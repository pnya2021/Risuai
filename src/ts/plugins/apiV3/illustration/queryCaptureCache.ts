import { Sha256 } from '@aws-crypto/sha256-js'
import { PluginApiError } from './errors'
import { canonicalArgumentsDigest } from './idempotency'
import { canonicalJson } from './revision'
import type { Revision } from './contextResources'

export interface QueryCaptureOwner {
    principalId: string
    service: 'context-assets' | 'context-modules'
    instanceId: string
}

export interface QueryCaptureRecord<T> {
    captureRevision: Revision
    items: readonly T[]
}

export interface QueryCapturePreparation {
    readonly owner: QueryCaptureOwner
    readonly queryDigest: string
    readonly lifecycle: readonly (readonly [string, number])[]
}

export interface QueryCaptureReservation<T> extends QueryCaptureRecord<T> {}

interface StoredQueryCapture<T = unknown> extends QueryCaptureRecord<T> {
    owner: QueryCaptureOwner
    queryDigest: string
    itemCount: number
    metadataBytes: number
    expiresAt: number
}

interface StoredQueryCaptureReservation<T = unknown> {
    reservation: QueryCaptureReservation<T>
    preparation: QueryCapturePreparation
    key: string
    existing?: StoredQueryCapture<T>
    itemCount: number
    metadataBytes: number
}

const unavailable = () => new PluginApiError(
    'CONFLICT',
    'Context query capture is no longer available',
    { retryable: true },
)

const mismatch = () => new PluginApiError(
    'INVALID_ARGUMENT',
    'Context query capture does not match this request',
)

const overBudget = () => new PluginApiError(
    'RESOURCE_LIMIT',
    'Context query capture exceeds its bounded metadata budget',
)

function assertNoSecretReferences(value: unknown, seen = new Set<object>()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            assertNoSecretReferences(Object.getOwnPropertyDescriptor(value, String(index))?.value, seen)
        }
        return
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.hasOwn(descriptors, 'pluginSecret')) {
        throw new PluginApiError('INVALID_ARGUMENT', 'Context query capture metadata cannot contain Secret references')
    }
    for (const descriptor of Object.values(descriptors)) {
        if (descriptor.enumerable && 'value' in descriptor) assertNoSecretReferences(descriptor.value, seen)
    }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
    if (!value || typeof value !== 'object' || seen.has(value)) return value
    seen.add(value)
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (descriptor.enumerable && 'value' in descriptor) deepFreeze(descriptor.value, seen)
    }
    return Object.freeze(value)
}

export function createSynchronousRevision(value: unknown): Revision {
    const hasher = new Sha256()
    hasher.update(new TextEncoder().encode(canonicalJson(value)))
    const digest = hasher.digestSync()
    return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export class QueryCaptureCache {
    private readonly records = new Map<string, StoredQueryCapture>()
    private readonly reservations = new Map<QueryCaptureReservation<unknown>, StoredQueryCaptureReservation>()
    private readonly lifecycleEpochs = new Map<string, number>()
    private readonly now: () => number
    private readonly ttlMs: number
    private readonly maxCapturesPerPrincipal: number
    private readonly maxItemsPerPrincipal: number
    private readonly maxMetadataBytesPerPrincipal: number

    constructor(options: {
        now?: () => number
        ttlMs?: number
        maxCapturesPerPrincipal?: number
        maxItemsPerPrincipal?: number
        maxMetadataBytesPerPrincipal?: number
    } = {}) {
        this.now = options.now ?? Date.now
        this.ttlMs = options.ttlMs ?? 300_000
        this.maxCapturesPerPrincipal = options.maxCapturesPerPrincipal ?? 64
        this.maxItemsPerPrincipal = options.maxItemsPerPrincipal ?? 20_000
        this.maxMetadataBytesPerPrincipal = options.maxMetadataBytesPerPrincipal ?? 16_777_216
    }

    async create<T>(owner: QueryCaptureOwner, query: unknown, items: readonly T[]): Promise<QueryCaptureRecord<T>> {
        const preparation = await this.prepareCreate(owner, query)
        return this.commitPrepared(preparation, items)
    }

    async prepareCreate(owner: QueryCaptureOwner, query: unknown): Promise<QueryCapturePreparation> {
        const lifecycle = this.captureLifecycle(owner)
        const queryDigest = await canonicalArgumentsDigest(query)
        if (!this.isLifecycleCurrent(lifecycle)) throw unavailable()
        return deepFreeze({ owner: { ...owner }, queryDigest, lifecycle })
    }

    commitPrepared<T>(
        preparation: QueryCapturePreparation,
        items: readonly T[],
    ): QueryCaptureRecord<T> {
        const reservation = this.reservePrepared(preparation, items)
        try {
            return this.commitReserved(reservation)
        } finally {
            this.releaseReservation(reservation)
        }
    }

    reservePrepared<T>(
        preparation: QueryCapturePreparation,
        items: readonly T[],
    ): QueryCaptureReservation<T> {
        this.removeExpired()
        if (!this.isLifecycleCurrent(preparation.lifecycle)) throw unavailable()
        if (!Array.isArray(items)) throw new PluginApiError('INVALID_ARGUMENT', 'Context query capture items must be an array')
        assertNoSecretReferences(items)
        const canonicalItems = canonicalJson(items)
        const metadataBytes = new TextEncoder().encode(canonicalItems).byteLength
        const captureRevision = createSynchronousRevision({ queryDigest: preparation.queryDigest, items })
        const key = this.key(preparation.owner, captureRevision)
        const existing = this.records.get(key) as StoredQueryCapture<T> | undefined
        if (existing) {
            if (existing.queryDigest !== preparation.queryDigest) throw mismatch()
        }

        const usage = this.principalUsage(preparation.owner.principalId)
        const reservedItemCount = existing ? 0 : items.length
        const reservedMetadataBytes = existing ? 0 : metadataBytes
        if (items.length > this.maxItemsPerPrincipal
            || metadataBytes > this.maxMetadataBytesPerPrincipal
            || usage.items + reservedItemCount > this.maxItemsPerPrincipal
            || usage.bytes + reservedMetadataBytes > this.maxMetadataBytesPerPrincipal) {
            throw overBudget()
        }

        const reservation = deepFreeze({
            captureRevision,
            items: [...items],
        }) as QueryCaptureReservation<T>
        if (!this.isLifecycleCurrent(preparation.lifecycle)) throw unavailable()
        this.reservations.set(
            reservation as QueryCaptureReservation<unknown>,
            {
                reservation,
                preparation,
                key,
                existing,
                itemCount: reservedItemCount,
                metadataBytes: reservedMetadataBytes,
            },
        )
        return reservation
    }

    commitReserved<T>(reservation: QueryCaptureReservation<T>): QueryCaptureRecord<T> {
        this.removeExpired()
        const stored = this.reservations.get(
            reservation as QueryCaptureReservation<unknown>,
        ) as StoredQueryCaptureReservation<T> | undefined
        if (!stored || !this.isLifecycleCurrent(stored.preparation.lifecycle)) {
            if (stored) this.reservations.delete(reservation as QueryCaptureReservation<unknown>)
            throw unavailable()
        }
        const current = this.records.get(stored.key) as StoredQueryCapture<T> | undefined
        if (stored.existing && current !== stored.existing) {
            this.reservations.delete(reservation as QueryCaptureReservation<unknown>)
            throw unavailable()
        }
        if (current) {
            if (current.queryDigest !== stored.preparation.queryDigest) {
                this.reservations.delete(reservation as QueryCaptureReservation<unknown>)
                throw mismatch()
            }
            this.reservations.delete(reservation as QueryCaptureReservation<unknown>)
            this.touch(stored.key, current)
            return current
        }
        const record = deepFreeze({
            owner: { ...stored.preparation.owner },
            queryDigest: stored.preparation.queryDigest,
            captureRevision: reservation.captureRevision,
            items: reservation.items,
            itemCount: stored.itemCount,
            metadataBytes: stored.metadataBytes,
            expiresAt: this.now() + this.ttlMs,
        }) as StoredQueryCapture<T>
        if (!this.isLifecycleCurrent(stored.preparation.lifecycle)) {
            this.reservations.delete(reservation as QueryCaptureReservation<unknown>)
            throw unavailable()
        }
        this.reservations.delete(reservation as QueryCaptureReservation<unknown>)
        this.records.set(stored.key, record)
        this.evictPrincipalLru(stored.preparation.owner.principalId)
        return record
    }

    releaseReservation(reservation: QueryCaptureReservation<unknown>) {
        this.reservations.delete(reservation)
    }

    async read<T>(
        owner: QueryCaptureOwner,
        query: unknown,
        captureRevision: Revision,
    ): Promise<QueryCaptureRecord<T>> {
        const preparation = await this.prepareCreate(owner, query)
        return this.readPrepared<T>(preparation, captureRevision)
    }

    readPrepared<T>(
        preparation: QueryCapturePreparation,
        captureRevision: Revision,
    ): QueryCaptureRecord<T> {
        this.removeExpired()
        if (!this.isLifecycleCurrent(preparation.lifecycle)) throw unavailable()
        const key = this.key(preparation.owner, captureRevision)
        const record = this.records.get(key) as StoredQueryCapture<T> | undefined
        if (!record) throw unavailable()
        if (this.records.get(key) !== record || record.expiresAt < this.now()) {
            this.records.delete(key)
            throw unavailable()
        }
        if (record.queryDigest !== preparation.queryDigest) throw mismatch()
        if (!this.isLifecycleCurrent(preparation.lifecycle)) throw unavailable()
        this.touch(key, record)
        return record
    }

    clearPrincipal(principalId: string) {
        this.bumpLifecycle(`principal:${principalId}`)
        for (const [key, record] of this.records) {
            if (record.owner.principalId === principalId) this.records.delete(key)
        }
        for (const [reservation, stored] of this.reservations) {
            if (stored.preparation.owner.principalId === principalId) this.reservations.delete(reservation)
        }
    }

    clearInstance(principalId: string, instanceId: string) {
        this.bumpLifecycle(`instance:${principalId}:${instanceId}`)
        for (const [key, record] of this.records) {
            if (record.owner.principalId === principalId && record.owner.instanceId === instanceId) {
                this.records.delete(key)
            }
        }
        for (const [reservation, stored] of this.reservations) {
            if (stored.preparation.owner.principalId === principalId
                && stored.preparation.owner.instanceId === instanceId) this.reservations.delete(reservation)
        }
    }

    clearService(principalId: string, service: string) {
        this.bumpLifecycle(`service:${principalId}:${service}`)
        for (const [key, record] of this.records) {
            if (record.owner.principalId === principalId && record.owner.service === service) {
                this.records.delete(key)
            }
        }
        for (const [reservation, stored] of this.reservations) {
            if (stored.preparation.owner.principalId === principalId
                && stored.preparation.owner.service === service) this.reservations.delete(reservation)
        }
    }

    private key(owner: QueryCaptureOwner, revision: Revision) {
        return JSON.stringify([owner.principalId, owner.service, owner.instanceId, revision])
    }

    private bumpLifecycle(key: string) {
        this.lifecycleEpochs.set(key, (this.lifecycleEpochs.get(key) ?? 0) + 1)
    }

    private captureLifecycle(owner: QueryCaptureOwner) {
        const keys = [
            `principal:${owner.principalId}`,
            `service:${owner.principalId}:${owner.service}`,
            `instance:${owner.principalId}:${owner.instanceId}`,
        ]
        return keys.map((key) => [key, this.lifecycleEpochs.get(key) ?? 0] as const)
    }

    private isLifecycleCurrent(lifecycle: readonly (readonly [string, number])[]) {
        return lifecycle.every(([key, epoch]) => (this.lifecycleEpochs.get(key) ?? 0) === epoch)
    }

    private touch(key: string, record: StoredQueryCapture) {
        this.records.delete(key)
        this.records.set(key, record)
    }

    private removeExpired() {
        const now = this.now()
        for (const [key, record] of this.records) {
            if (record.expiresAt < now) this.records.delete(key)
        }
    }

    private principalUsage(principalId: string) {
        let captures = 0
        let items = 0
        let bytes = 0
        for (const record of this.records.values()) {
            if (record.owner.principalId !== principalId) continue
            captures += 1
            items += record.itemCount
            bytes += record.metadataBytes
        }
        for (const stored of this.reservations.values()) {
            if (stored.preparation.owner.principalId !== principalId) continue
            items += stored.itemCount
            bytes += stored.metadataBytes
        }
        return { captures, items, bytes }
    }

    private evictPrincipalLru(principalId: string) {
        let usage = this.principalUsage(principalId)
        if (usage.captures <= this.maxCapturesPerPrincipal) return
        for (const [key, record] of this.records) {
            if (record.owner.principalId !== principalId) continue
            this.records.delete(key)
            usage = this.principalUsage(principalId)
            if (usage.captures <= this.maxCapturesPerPrincipal) return
        }
    }
}

/** Shared extension-wide cache so aggregate metadata budgets are enforced per principal. */
export const illustrationQueryCaptureCache = new QueryCaptureCache()
