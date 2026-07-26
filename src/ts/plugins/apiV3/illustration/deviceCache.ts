import localforage from 'localforage'
import type { PluginDataLifecycleRegistry } from '../../pluginDataLifecycle'
import { pluginDataLifecycle } from '../../pluginDataLifecycle'
import { CAPABILITY_CONTRACT } from './capabilityContract'
import { CursorRegistry, illustrationCursorRegistry } from './cursorRegistry'
import { PluginApiError } from './errors'
import type { PluginExecutionContext } from './permissions'
import { validateJsonLimits } from './revision'

export const DEVICE_CACHE_CAPABILITY_IDS = ['storage.device-cache.v1'] as const

export type PluginJsonValue =
    | null | boolean | number | string
    | PluginJsonValue[]
    | { [key: string]: PluginJsonValue }

export type PluginDeviceCacheValue =
    | { kind: 'json'; value: PluginJsonValue }
    | { kind: 'bytes'; data: Uint8Array; mediaType?: string }

export interface PluginDeviceCacheDescriptor {
    key: string
    revision: string
    kind: PluginDeviceCacheValue['kind']
    byteLength: number
    mediaType?: string
    createdAt: number
    updatedAt: number
    lastAccessedAt: number
    expiresAt?: number
}

export interface StoredDeviceCacheRecord {
    descriptor: PluginDeviceCacheDescriptor
    value: PluginDeviceCacheValue
}

export interface DeviceCacheStore {
    readPrincipal(principalId: string): Promise<StoredDeviceCacheRecord[]>
    replacePrincipal(principalId: string, records: StoredDeviceCacheRecord[]): Promise<void>
    clearPrincipal(principalId: string): Promise<void>
}

export interface PluginDeviceCacheLimits {
    maxBytesPerPrincipal: number
    maxEntriesPerPrincipal: number
    maxEntryBytes: number
    maxKeyUtf8Bytes: number
    defaultPageSize: number
    maxPageSize: number
    maxTtlMs: number
    maxJsonDepth: number
}

const advertisedLimits = CAPABILITY_CONTRACT['storage.device-cache.v1'].limits
const DEFAULT_LIMITS: PluginDeviceCacheLimits = {
    maxBytesPerPrincipal: Number(advertisedLimits.maxCacheBytesPerPrincipal),
    maxEntriesPerPrincipal: Number(advertisedLimits.maxCacheEntriesPerPrincipal),
    maxEntryBytes: Number(advertisedLimits.maxCacheEntryBytes),
    maxKeyUtf8Bytes: Number(advertisedLimits.maxCacheKeyUtf8Bytes),
    defaultPageSize: Number(advertisedLimits.defaultPageSize),
    maxPageSize: Number(advertisedLimits.maxPageSize),
    maxTtlMs: Number(advertisedLimits.maxTtlMs),
    maxJsonDepth: 32,
}

interface PersistedPrincipalBucket {
    version: 1
    records: StoredDeviceCacheRecord[]
}

const cloneJson = (value: PluginJsonValue, maxBytes = Number.MAX_SAFE_INTEGER, maxDepth = 32): PluginJsonValue => {
    const canonical = validateJsonLimits(value, { maxDepth, maxBytes })
    return JSON.parse(canonical) as PluginJsonValue
}

const cloneValue = (value: PluginDeviceCacheValue): PluginDeviceCacheValue => value.kind === 'bytes'
    ? {
        kind: 'bytes',
        data: value.data.slice(),
        ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
    }
    : { kind: 'json', value: cloneJson(value.value) }

const cloneRecord = (record: StoredDeviceCacheRecord): StoredDeviceCacheRecord => ({
    descriptor: { ...record.descriptor },
    value: cloneValue(record.value),
})

class LocalForageDeviceCacheStore implements DeviceCacheStore {
    private readonly storage = localforage.createInstance({
        name: 'plugin_device_cache_v3',
        storeName: 'principal_entries',
    })

    async readPrincipal(principalId: string) {
        const bucket = await this.storage.getItem<PersistedPrincipalBucket>(principalId)
        if (!bucket) return []
        if (bucket.version !== 1 || !Array.isArray(bucket.records)) throw new Error('invalid device cache bucket')
        return bucket.records.map(cloneRecord)
    }

    async replacePrincipal(principalId: string, records: StoredDeviceCacheRecord[]) {
        await this.storage.setItem(principalId, {
            version: 1,
            records: records.map(cloneRecord),
        } satisfies PersistedPrincipalBucket)
    }

    async clearPrincipal(principalId: string) {
        await this.storage.removeItem(principalId)
    }
}

const defaultStore = new LocalForageDeviceCacheStore()
const principalTails = new WeakMap<DeviceCacheStore, Map<string, Promise<void>>>()

function withPrincipalLock<T>(store: DeviceCacheStore, principalId: string, operation: () => Promise<T>): Promise<T> {
    let tails = principalTails.get(store)
    if (!tails) {
        tails = new Map()
        principalTails.set(store, tails)
    }
    const previous = tails.get(principalId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    tails.set(principalId, settled)
    return result.finally(() => {
        if (tails?.get(principalId) === settled) tails.delete(principalId)
    })
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

const invalid = (message: string): never => {
    throw new PluginApiError('INVALID_ARGUMENT', message)
}

const ownValue = (input: object, key: PropertyKey) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Invalid device cache input')
    return descriptor.value
}

function assertPlainInput(input: unknown): asserts input is Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Invalid device cache input')
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) invalid('Invalid device cache input')
}

interface DeviceCacheServiceDependencies {
    store?: DeviceCacheStore
    cursorRegistry?: CursorRegistry
    now?: () => number
    createRevision?: () => string | Promise<string>
    limits?: Partial<PluginDeviceCacheLimits>
    isPrincipalRetiring?: (principalId: string) => boolean
}

interface NormalizedValue {
    value: PluginDeviceCacheValue
    kind: PluginDeviceCacheValue['kind']
    byteLength: number
    mediaType?: string
}

export class DeviceCacheService {
    private readonly store: DeviceCacheStore
    private readonly cursorRegistry: CursorRegistry
    private readonly now: () => number
    private readonly revision: () => string | Promise<string>
    private readonly limits: PluginDeviceCacheLimits
    private readonly isPrincipalRetiring: (principalId: string) => boolean

    constructor(
        private readonly context: PluginExecutionContext,
        dependencies: DeviceCacheServiceDependencies = {},
    ) {
        this.store = dependencies.store ?? defaultStore
        this.cursorRegistry = dependencies.cursorRegistry ?? illustrationCursorRegistry
        this.now = dependencies.now ?? Date.now
        this.revision = dependencies.createRevision ?? (() => crypto.randomUUID())
        this.limits = { ...DEFAULT_LIMITS, ...dependencies.limits }
        this.isPrincipalRetiring = dependencies.isPrincipalRetiring
            ?? ((principalId) => pluginDataLifecycle.isRetiring(principalId))
        context.signal.addEventListener('abort', () => {
            this.cursorRegistry.clearInstance(context.principalId, context.instanceId)
        }, { once: true })
    }

    private assertActive() {
        if (this.context.signal.aborted || this.isPrincipalRetiring(this.context.principalId)) {
            throw new PluginApiError('ABORTED', 'Plugin cache owner is no longer active')
        }
    }

    private key(value: unknown, allowEmpty = false): string {
        if (typeof value !== 'string') invalid('Invalid device cache key')
        const key = value as string
        if (!allowEmpty && key.length === 0) invalid('Device cache key must not be empty')
        if (new TextEncoder().encode(key).byteLength > this.limits.maxKeyUtf8Bytes) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Device cache key limit exceeded')
        }
        return key
    }

    private prefix(value: unknown): string | undefined {
        if (value === undefined || value === '') return undefined
        return this.key(value, true)
    }

    private expectedRevision(value: unknown, allowNull: boolean): string | null | undefined {
        if (value === undefined || (allowNull && value === null)) return value as string | null | undefined
        if (typeof value !== 'string' || value.length === 0) invalid('Invalid expected device cache revision')
        return value as string
    }

    private ttl(value: unknown): number | undefined {
        if (value === undefined) return undefined
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) invalid('Invalid device cache TTL')
        const ttl = value as number
        if (ttl > this.limits.maxTtlMs) throw new PluginApiError('RESOURCE_LIMIT', 'Device cache TTL limit exceeded')
        return ttl
    }

    private normalizeValue(input: unknown): NormalizedValue {
        assertPlainInput(input)
        const kind = ownValue(input, 'kind')
        if (kind === 'bytes') {
            const data = ownValue(input, 'data')
            if (!(data instanceof Uint8Array)) invalid('Device cache bytes must be a Uint8Array')
            const mediaType = Object.hasOwn(input, 'mediaType') ? ownValue(input, 'mediaType') : undefined
            if (mediaType !== undefined && typeof mediaType !== 'string') invalid('Invalid device cache media type')
            if (data.byteLength > this.limits.maxEntryBytes) {
                throw new PluginApiError('RESOURCE_LIMIT', 'Device cache entry limit exceeded')
            }
            const copy = data.slice()
            return {
                value: { kind: 'bytes', data: copy, ...(mediaType === undefined ? {} : { mediaType }) },
                kind,
                byteLength: copy.byteLength,
                ...(mediaType === undefined ? {} : { mediaType }),
            }
        }
        if (kind === 'json') {
            const canonical = validateJsonLimits(ownValue(input, 'value'), {
                maxDepth: this.limits.maxJsonDepth,
                maxBytes: this.limits.maxEntryBytes,
            })
            return {
                value: { kind: 'json', value: JSON.parse(canonical) as PluginJsonValue },
                kind,
                byteLength: new TextEncoder().encode(canonical).byteLength,
            }
        }
        invalid('Invalid device cache value kind')
    }

    private async load() {
        try {
            return await this.store.readPrincipal(this.context.principalId)
        } catch {
            throw new PluginApiError('INTERNAL', 'Device cache read failed')
        }
    }

    private async persist(records: StoredDeviceCacheRecord[]) {
        try {
            if (records.length === 0) await this.store.clearPrincipal(this.context.principalId)
            else await this.store.replacePrincipal(this.context.principalId, records)
        } catch {
            throw new PluginApiError('INTERNAL', 'Device cache write failed')
        }
    }

    private sweep(records: StoredDeviceCacheRecord[], now: number) {
        const retained = records.filter((record) => record.descriptor.expiresAt === undefined
            || record.descriptor.expiresAt > now)
        return { records: retained, changed: retained.length !== records.length }
    }

    private descriptor(record: StoredDeviceCacheRecord): PluginDeviceCacheDescriptor {
        return { ...record.descriptor }
    }

    private result(record: StoredDeviceCacheRecord) {
        const descriptor = this.descriptor(record)
        if (record.value.kind === 'bytes') {
            return {
                ...descriptor,
                kind: 'bytes' as const,
                data: record.value.data.slice(),
                ...(record.value.mediaType === undefined ? {} : { mediaType: record.value.mediaType }),
            }
        }
        return {
            ...descriptor,
            kind: 'json' as const,
            value: cloneJson(record.value.value),
        }
    }

    async putDeviceCacheEntry(input: {
        key: string
        value: PluginDeviceCacheValue
        expectedRevision?: string | null
        ttlMs?: number
    }) {
        assertPlainInput(input)
        const key = this.key(ownValue(input, 'key'))
        const value = this.normalizeValue(ownValue(input, 'value'))
        const expectedRevision = Object.hasOwn(input, 'expectedRevision')
            ? this.expectedRevision(ownValue(input, 'expectedRevision'), true)
            : undefined
        const ttlMs = Object.hasOwn(input, 'ttlMs') ? this.ttl(ownValue(input, 'ttlMs')) : undefined
        this.assertActive()
        return withPrincipalLock(this.store, this.context.principalId, async () => {
            this.assertActive()
            const now = this.now()
            const swept = this.sweep(await this.load(), now)
            const existing = swept.records.find((record) => record.descriptor.key === key)
            if (expectedRevision === null && existing) throw new PluginApiError('CONFLICT', 'Device cache revision conflict')
            if (typeof expectedRevision === 'string' && existing?.descriptor.revision !== expectedRevision) {
                throw new PluginApiError('CONFLICT', 'Device cache revision conflict')
            }
            const record: StoredDeviceCacheRecord = {
                descriptor: {
                    key,
                    revision: await this.revision(),
                    kind: value.kind,
                    byteLength: value.byteLength,
                    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
                    createdAt: existing?.descriptor.createdAt ?? now,
                    updatedAt: now,
                    lastAccessedAt: now,
                    ...(ttlMs === undefined ? {} : { expiresAt: now + ttlMs }),
                },
                value: cloneValue(value.value),
            }
            const others = swept.records.filter((candidate) => candidate.descriptor.key !== key)
            const evictionCandidates = [...others].sort((left, right) =>
                left.descriptor.lastAccessedAt - right.descriptor.lastAccessedAt
                || compareText(left.descriptor.key, right.descriptor.key))
            const retained = new Map(others.map((candidate) => [candidate.descriptor.key, candidate]))
            let byteLength = value.byteLength + others.reduce((sum, candidate) => sum + candidate.descriptor.byteLength, 0)
            let entryCount = others.length + 1
            const evictedKeys: string[] = []
            for (const candidate of evictionCandidates) {
                if (byteLength <= this.limits.maxBytesPerPrincipal
                    && entryCount <= this.limits.maxEntriesPerPrincipal) break
                retained.delete(candidate.descriptor.key)
                byteLength -= candidate.descriptor.byteLength
                entryCount--
                evictedKeys.push(candidate.descriptor.key)
            }
            if (byteLength > this.limits.maxBytesPerPrincipal
                || entryCount > this.limits.maxEntriesPerPrincipal) {
                throw new PluginApiError('QUOTA_EXCEEDED', 'Device cache quota exceeded')
            }
            const records = [...retained.values(), record]
            await this.persist(records)
            this.assertActive()
            return { entry: this.descriptor(record), evictedKeys }
        })
    }

    async getDeviceCacheEntry(keyInput: string) {
        const key = this.key(keyInput)
        this.assertActive()
        return withPrincipalLock(this.store, this.context.principalId, async () => {
            this.assertActive()
            const now = this.now()
            const swept = this.sweep(await this.load(), now)
            const record = swept.records.find((candidate) => candidate.descriptor.key === key)
            if (!record) {
                if (swept.changed) await this.persist(swept.records)
                return null
            }
            record.descriptor.lastAccessedAt = now
            await this.persist(swept.records)
            this.assertActive()
            return this.result(record)
        })
    }

    async listDeviceCacheEntries(options: {
        prefix?: string
        cursor?: string
        limit?: number
    } = {}) {
        assertPlainInput(options)
        const prefix = Object.hasOwn(options, 'prefix') ? this.prefix(ownValue(options, 'prefix')) : undefined
        const cursor = Object.hasOwn(options, 'cursor') ? ownValue(options, 'cursor') : undefined
        if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) invalid('Invalid device cache cursor')
        const limitInput = Object.hasOwn(options, 'limit') ? ownValue(options, 'limit') : undefined
        const limit = limitInput === undefined ? this.limits.defaultPageSize : limitInput
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) invalid('Invalid device cache page limit')
        if (limit > this.limits.maxPageSize) throw new PluginApiError('RESOURCE_LIMIT', 'Device cache page limit exceeded')
        this.assertActive()
        return withPrincipalLock(this.store, this.context.principalId, async () => {
            this.assertActive()
            const swept = this.sweep(await this.load(), this.now())
            if (swept.changed) await this.persist(swept.records)
            const query = { prefix: prefix ?? null, limit }
            let offset = 0
            if (cursor) {
                const page = await this.cursorRegistry.read<{ offset: number }>(
                    cursor,
                    this.context.principalId,
                    'device-cache',
                    this.context.instanceId,
                    query,
                )
                this.cursorRegistry.clear(cursor)
                offset = page.offset
            }
            const matching = swept.records
                .filter((record) => prefix === undefined || record.descriptor.key.startsWith(prefix))
                .sort((left, right) => compareText(left.descriptor.key, right.descriptor.key))
            const page = matching.slice(offset, offset + limit)
            const nextOffset = offset + page.length
            const nextCursor = nextOffset < matching.length
                ? await this.cursorRegistry.create(
                    this.context.principalId,
                    'device-cache',
                    this.context.instanceId,
                    query,
                    { offset: nextOffset },
                )
                : undefined
            return {
                items: page.map((record) => this.descriptor(record)),
                ...(nextCursor === undefined ? {} : { nextCursor }),
            }
        })
    }

    async deleteDeviceCacheEntry(keyInput: string, options: { expectedRevision?: string } = {}) {
        const key = this.key(keyInput)
        assertPlainInput(options)
        const expectedRevision = Object.hasOwn(options, 'expectedRevision')
            ? this.expectedRevision(ownValue(options, 'expectedRevision'), false)
            : undefined
        this.assertActive()
        return withPrincipalLock(this.store, this.context.principalId, async () => {
            this.assertActive()
            const swept = this.sweep(await this.load(), this.now())
            const record = swept.records.find((candidate) => candidate.descriptor.key === key)
            if (!record) {
                if (swept.changed) await this.persist(swept.records)
                return false
            }
            if (expectedRevision !== undefined && record.descriptor.revision !== expectedRevision) {
                throw new PluginApiError('CONFLICT', 'Device cache revision conflict')
            }
            await this.persist(swept.records.filter((candidate) => candidate !== record))
            this.assertActive()
            return true
        })
    }

    async clearDeviceCache(options: { prefix?: string } = {}) {
        assertPlainInput(options)
        const prefix = Object.hasOwn(options, 'prefix') ? this.prefix(ownValue(options, 'prefix')) : undefined
        this.assertActive()
        return withPrincipalLock(this.store, this.context.principalId, async () => {
            this.assertActive()
            const swept = this.sweep(await this.load(), this.now())
            const retained = swept.records.filter((record) =>
                prefix !== undefined && !record.descriptor.key.startsWith(prefix))
            const removed = swept.records.length - retained.length
            if (swept.changed || removed > 0) await this.persist(retained)
            this.assertActive()
            return removed
        })
    }
}

export function registerDeviceCacheLifecycle(
    store: DeviceCacheStore = defaultStore,
    cursors: CursorRegistry = illustrationCursorRegistry,
    lifecycle: PluginDataLifecycleRegistry = pluginDataLifecycle,
) {
    const cleanup = (principalId: string) => withPrincipalLock(store, principalId, async () => {
        try {
            await store.clearPrincipal(principalId)
        } finally {
            cursors.clearPrincipal(principalId)
        }
    })
    const unregister = (['purge', 'quarantine', 'delete'] as const).map((action) =>
        lifecycle.register('device-cache', action, ({ principalId }) => cleanup(principalId)))
    return () => unregister.forEach((callback) => callback())
}

registerDeviceCacheLifecycle()
