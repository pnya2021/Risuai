import { PluginApiError } from './errors'
import { canonicalArgumentsDigest } from './idempotency'
import { canonicalJson, createRevision } from './revision'
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

interface StoredQueryCapture<T = unknown> extends QueryCaptureRecord<T> {
    owner: QueryCaptureOwner
    queryDigest: string
    itemCount: number
    metadataBytes: number
    expiresAt: number
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

export class QueryCaptureCache {
    private readonly records = new Map<string, StoredQueryCapture>()
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
        this.removeExpired()
        if (!Array.isArray(items)) throw new PluginApiError('INVALID_ARGUMENT', 'Context query capture items must be an array')
        assertNoSecretReferences(items)
        const canonicalItems = canonicalJson(items)
        const metadataBytes = new TextEncoder().encode(canonicalItems).byteLength
        const queryDigest = await canonicalArgumentsDigest(query)
        const captureRevision = await createRevision({ queryDigest, items })
        const key = this.key(owner, captureRevision)
        const existing = this.records.get(key) as StoredQueryCapture<T> | undefined
        if (existing) {
            if (existing.queryDigest !== queryDigest) throw mismatch()
            this.touch(key, existing)
            return existing
        }

        const usage = this.principalUsage(owner.principalId)
        if (items.length > this.maxItemsPerPrincipal
            || metadataBytes > this.maxMetadataBytesPerPrincipal
            || usage.items + items.length > this.maxItemsPerPrincipal
            || usage.bytes + metadataBytes > this.maxMetadataBytesPerPrincipal) {
            throw overBudget()
        }

        const record = deepFreeze({
            owner: { ...owner },
            queryDigest,
            captureRevision,
            items: [...items],
            itemCount: items.length,
            metadataBytes,
            expiresAt: this.now() + this.ttlMs,
        }) as StoredQueryCapture<T>
        this.records.set(key, record)
        this.evictPrincipalLru(owner.principalId)
        return record
    }

    async read<T>(
        owner: QueryCaptureOwner,
        query: unknown,
        captureRevision: Revision,
    ): Promise<QueryCaptureRecord<T>> {
        this.removeExpired()
        const key = this.key(owner, captureRevision)
        const record = this.records.get(key) as StoredQueryCapture<T> | undefined
        if (!record) throw unavailable()
        const queryDigest = await canonicalArgumentsDigest(query)
        if (this.records.get(key) !== record || record.expiresAt < this.now()) {
            this.records.delete(key)
            throw unavailable()
        }
        if (record.queryDigest !== queryDigest) throw mismatch()
        this.touch(key, record)
        return record
    }

    clearPrincipal(principalId: string) {
        for (const [key, record] of this.records) {
            if (record.owner.principalId === principalId) this.records.delete(key)
        }
    }

    clearInstance(principalId: string, instanceId: string) {
        for (const [key, record] of this.records) {
            if (record.owner.principalId === principalId && record.owner.instanceId === instanceId) {
                this.records.delete(key)
            }
        }
    }

    clearService(principalId: string, service: string) {
        for (const [key, record] of this.records) {
            if (record.owner.principalId === principalId && record.owner.service === service) {
                this.records.delete(key)
            }
        }
    }

    private key(owner: QueryCaptureOwner, revision: Revision) {
        return JSON.stringify([owner.principalId, owner.service, owner.instanceId, revision])
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
