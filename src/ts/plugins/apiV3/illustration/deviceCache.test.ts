import { describe, expect, it } from 'vitest'
import { PluginDataLifecycleRegistry } from '../../pluginDataLifecycle'
import { CursorRegistry } from './cursorRegistry'
import {
    DeviceCacheService,
    registerDeviceCacheLifecycle,
    type DeviceCacheStore,
    type PluginDeviceCacheLimits,
    type StoredDeviceCacheRecord,
} from './deviceCache'

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PRINCIPAL_B = '22222222-2222-4222-8222-222222222222'

const cloneRecord = (record: StoredDeviceCacheRecord, sparseBytes = false): StoredDeviceCacheRecord => ({
    descriptor: { ...record.descriptor },
    value: record.value.kind === 'bytes'
        ? {
            kind: 'bytes',
            data: sparseBytes ? new Uint8Array() : record.value.data.slice(),
            ...(record.value.mediaType === undefined ? {} : { mediaType: record.value.mediaType }),
        }
        : { kind: 'json', value: structuredClone(record.value.value) },
})

class MemoryDeviceCacheStore implements DeviceCacheStore {
    readonly buckets = new Map<string, StoredDeviceCacheRecord[]>()
    failNextReplace = false
    replaceCount = 0

    constructor(private readonly sparseBytes = false) {}

    async readPrincipal(principalId: string) {
        return (this.buckets.get(principalId) ?? []).map((record) => cloneRecord(record, this.sparseBytes))
    }

    async replacePrincipal(principalId: string, records: StoredDeviceCacheRecord[]) {
        if (this.failNextReplace) {
            this.failNextReplace = false
            throw new Error('simulated persistence failure')
        }
        this.replaceCount++
        this.buckets.set(principalId, records.map((record) => cloneRecord(record, this.sparseBytes)))
    }

    async clearPrincipal(principalId: string) {
        this.buckets.delete(principalId)
    }

    seed(principalId: string, records: StoredDeviceCacheRecord[]) {
        this.buckets.set(principalId, records.map((record) => cloneRecord(record, this.sparseBytes)))
    }
}

const context = (
    principalId = PRINCIPAL_A,
    instanceId = `instance-${principalId}`,
    abortController = new AbortController(),
) => ({
    principalId,
    instanceId,
    displayName: 'Device cache test',
    signal: abortController.signal,
})

function harness(options: {
    principalId?: string
    instanceId?: string
    abortController?: AbortController
    store?: MemoryDeviceCacheStore
    cursors?: CursorRegistry
    now?: { value: number }
    limits?: Partial<PluginDeviceCacheLimits>
} = {}) {
    const store = options.store ?? new MemoryDeviceCacheStore()
    const cursors = options.cursors ?? new CursorRegistry()
    const now = options.now ?? { value: 1_000 }
    let revision = 0
    const execution = context(options.principalId, options.instanceId, options.abortController)
    const service = new DeviceCacheService(execution, {
        store,
        cursorRegistry: cursors,
        now: () => now.value,
        createRevision: () => `revision-${++revision}`,
        limits: options.limits,
    })
    return { service, store, cursors, now, execution }
}

const codeOf = async (promise: Promise<unknown>) => {
    try {
        await promise
        return undefined
    } catch (error) {
        return (error as { code?: string }).code
    }
}

const logicalRecord = (options: {
    key: string
    byteLength: number
    revision?: string
    createdAt?: number
    updatedAt?: number
    lastAccessedAt?: number
    expiresAt?: number
}): StoredDeviceCacheRecord => ({
    descriptor: {
        key: options.key,
        revision: options.revision ?? `seed-${options.key}`,
        kind: 'bytes',
        byteLength: options.byteLength,
        createdAt: options.createdAt ?? 1,
        updatedAt: options.updatedAt ?? 1,
        lastAccessedAt: options.lastAccessedAt ?? 1,
        ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    },
    value: { kind: 'bytes', data: new Uint8Array() },
})

describe('V3 principal-isolated device cache', () => {
    it('round-trips JSON and bytes by value with exact canonical byte accounting and no detachment', async () => {
        const { service } = harness()
        const json = { z: '가', nested: { value: 1 } }
        const jsonPut = await service.putDeviceCacheEntry({ key: 'json', value: { kind: 'json', value: json } })
        expect(jsonPut.entry.byteLength).toBe(new TextEncoder().encode('{"nested":{"value":1},"z":"가"}').byteLength)
        json.nested.value = 9
        const firstJson = await service.getDeviceCacheEntry('json')
        expect(firstJson).toMatchObject({ kind: 'json', value: { nested: { value: 1 }, z: '가' } })
        ;((firstJson as unknown as { value: { nested: { value: number } } }).value.nested).value = 8
        expect(await service.getDeviceCacheEntry('json')).toMatchObject({ value: { nested: { value: 1 } } })

        const bytes = new Uint8Array([1, 2, 3])
        const originalBuffer = bytes.buffer
        const bytesPut = await service.putDeviceCacheEntry({
            key: 'bytes',
            value: { kind: 'bytes', data: bytes, mediaType: 'image/png' },
        })
        expect(bytesPut.entry).toMatchObject({ kind: 'bytes', byteLength: 3, mediaType: 'image/png' })
        expect(bytes.buffer).toBe(originalBuffer)
        expect([...bytes]).toEqual([1, 2, 3])
        bytes[0] = 9
        const firstBytes = await service.getDeviceCacheEntry('bytes')
        expect([...(firstBytes as { data: Uint8Array }).data]).toEqual([1, 2, 3])
        ;(firstBytes as { data: Uint8Array }).data[1] = 9
        expect([...(await service.getDeviceCacheEntry('bytes') as { data: Uint8Array }).data]).toEqual([1, 2, 3])
    })

    it('rejects Blob, ArrayBuffer, and Uint8Array lookalikes before storage mutation', async () => {
        const { service, store } = harness()
        const invalid = [
            new Blob([new Uint8Array([1])]),
            new Uint8Array([1]).buffer,
            { byteLength: 1, slice: () => new Uint8Array([1]) },
        ]
        for (const data of invalid) {
            expect(await codeOf(service.putDeviceCacheEntry({
                key: 'invalid',
                value: { kind: 'bytes', data } as never,
            }))).toBe('INVALID_ARGUMENT')
        }
        expect(store.replaceCount).toBe(0)
    })

    it('structurally isolates every operation for principals using the same key', async () => {
        const store = new MemoryDeviceCacheStore()
        const a = harness({ store, principalId: PRINCIPAL_A }).service
        const b = harness({ store, principalId: PRINCIPAL_B }).service
        await a.putDeviceCacheEntry({ key: 'same', value: { kind: 'json', value: 'a' } })
        await b.putDeviceCacheEntry({ key: 'same', value: { kind: 'json', value: 'b' } })
        await a.putDeviceCacheEntry({ key: 'prefix/a', value: { kind: 'json', value: 1 } })
        await b.putDeviceCacheEntry({ key: 'prefix/b', value: { kind: 'json', value: 2 } })

        expect(await a.getDeviceCacheEntry('same')).toMatchObject({ value: 'a' })
        expect(await b.getDeviceCacheEntry('same')).toMatchObject({ value: 'b' })
        expect((await a.listDeviceCacheEntries()).items.map((item) => item.key)).toEqual(['prefix/a', 'same'])
        expect((await b.listDeviceCacheEntries()).items.map((item) => item.key)).toEqual(['prefix/b', 'same'])
        expect(await a.deleteDeviceCacheEntry('same')).toBe(true)
        expect(await b.getDeviceCacheEntry('same')).toMatchObject({ value: 'b' })
        expect(await a.clearDeviceCache({ prefix: 'prefix/' })).toBe(1)
        expect((await b.listDeviceCacheEntries()).items.map((item) => item.key)).toEqual(['prefix/b', 'same'])
    })

    it('accepts exact key and entry byte ceilings and rejects empty/one-over values before mutation', async () => {
        const store = new MemoryDeviceCacheStore(true)
        const { service } = harness({ store })
        await expect(service.putDeviceCacheEntry({
            key: 'k'.repeat(256),
            value: { kind: 'bytes', data: new Uint8Array(33_554_432) },
        })).resolves.toMatchObject({ entry: { byteLength: 33_554_432 } })
        const writes = store.replaceCount
        expect(await codeOf(service.putDeviceCacheEntry({ key: '', value: { kind: 'json', value: null } }))).toBe('INVALID_ARGUMENT')
        expect(await codeOf(service.putDeviceCacheEntry({ key: 'k'.repeat(257), value: { kind: 'json', value: null } }))).toBe('RESOURCE_LIMIT')
        expect(await codeOf(service.putDeviceCacheEntry({
            key: 'too-large',
            value: { kind: 'bytes', data: new Uint8Array(33_554_433) },
        }))).toBe('RESOURCE_LIMIT')
        expect(store.replaceCount).toBe(writes)
    })

    it('implements create-only, CAS, upsert, one concurrent winner, and no failed-write mutation', async () => {
        const { service, store } = harness()
        const created = await service.putDeviceCacheEntry({
            key: 'cas', value: { kind: 'json', value: 1 }, expectedRevision: null,
        })
        expect(await codeOf(service.putDeviceCacheEntry({
            key: 'cas', value: { kind: 'json', value: 2 }, expectedRevision: null,
        }))).toBe('CONFLICT')
        expect(await codeOf(service.putDeviceCacheEntry({
            key: 'cas', value: { kind: 'json', value: 2 }, expectedRevision: 'wrong',
        }))).toBe('CONFLICT')
        expect(await service.getDeviceCacheEntry('cas')).toMatchObject({ value: 1, revision: created.entry.revision })

        const results = await Promise.allSettled([
            service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 2 }, expectedRevision: created.entry.revision }),
            service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 3 }, expectedRevision: created.entry.revision }),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(['CONFLICT'])

        const beforeFailure = await service.getDeviceCacheEntry('cas')
        store.failNextReplace = true
        expect(await codeOf(service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 4 } }))).toBe('INTERNAL')
        expect(await service.getDeviceCacheEntry('cas')).toMatchObject({
            value: (beforeFailure as { value: unknown }).value,
            revision: (beforeFailure as { revision: string }).revision,
        })
        await expect(service.putDeviceCacheEntry({ key: 'cas', value: { kind: 'json', value: 5 } })).resolves.toBeDefined()
    })

    it('enforces exact and one-over 128 MiB and 1,024-entry budgets with sparse logical fixtures', async () => {
        const exactBytes = new MemoryDeviceCacheStore(true)
        exactBytes.seed(PRINCIPAL_A, [logicalRecord({ key: 'large', byteLength: 134_217_727 })])
        const exactByteResult = await harness({ store: exactBytes }).service.putDeviceCacheEntry({
            key: 'incoming', value: { kind: 'bytes', data: new Uint8Array([1]) },
        })
        expect(exactByteResult.evictedKeys).toEqual([])

        const overBytes = new MemoryDeviceCacheStore(true)
        overBytes.seed(PRINCIPAL_A, [logicalRecord({ key: 'large', byteLength: 134_217_728 })])
        overBytes.seed(PRINCIPAL_B, [logicalRecord({ key: 'foreign', byteLength: 134_217_728 })])
        const overByteResult = await harness({ store: overBytes }).service.putDeviceCacheEntry({
            key: 'incoming', value: { kind: 'bytes', data: new Uint8Array([1]) },
        })
        expect(overByteResult.evictedKeys).toEqual(['large'])
        expect(overBytes.buckets.get(PRINCIPAL_B)?.map((record) => record.descriptor.key)).toEqual(['foreign'])

        const countStore = new MemoryDeviceCacheStore(true)
        countStore.seed(PRINCIPAL_A, Array.from({ length: 1_023 }, (_, index) => logicalRecord({
            key: `seed-${String(index).padStart(4, '0')}`, byteLength: 0, lastAccessedAt: index,
        })))
        const countService = harness({ store: countStore }).service
        expect((await countService.putDeviceCacheEntry({ key: 'z-exact', value: { kind: 'bytes', data: new Uint8Array() } })).evictedKeys).toEqual([])
        expect((await countService.putDeviceCacheEntry({ key: 'z-over', value: { kind: 'bytes', data: new Uint8Array() } })).evictedKeys).toEqual(['seed-0000'])
    })

    it('accounts for overwrites, purges expired entries first, then evicts deterministic LRU without evicting incoming or foreign data', async () => {
        const store = new MemoryDeviceCacheStore(true)
        store.seed(PRINCIPAL_A, [
            logicalRecord({ key: 'expired', byteLength: 5, expiresAt: 999, lastAccessedAt: 0 }),
            logicalRecord({ key: 'b', byteLength: 3, lastAccessedAt: 10 }),
            logicalRecord({ key: 'a', byteLength: 3, lastAccessedAt: 10 }),
        ])
        store.seed(PRINCIPAL_B, [logicalRecord({ key: 'foreign', byteLength: 6 })])
        const { service } = harness({ store, limits: { maxBytesPerPrincipal: 7, maxEntriesPerPrincipal: 3 } })
        const result = await service.putDeviceCacheEntry({ key: 'incoming', value: { kind: 'bytes', data: new Uint8Array([1, 2]) } })
        expect(result.evictedKeys).toEqual(['a'])
        expect((await service.listDeviceCacheEntries()).items.map((item) => item.key)).toEqual(['b', 'incoming'])
        expect(store.buckets.get(PRINCIPAL_B)?.map((record) => record.descriptor.key)).toEqual(['foreign'])

        const overwritten = await service.putDeviceCacheEntry({ key: 'b', value: { kind: 'bytes', data: new Uint8Array([1]) } })
        expect(overwritten.evictedKeys).toEqual([])
        expect((await service.listDeviceCacheEntries()).items.map((item) => item.key)).toEqual(['b', 'incoming'])
    })

    it('validates TTL boundaries, expires at the deadline, and reloads quota accounting without expired records', async () => {
        const store = new MemoryDeviceCacheStore()
        const now = { value: 1_000 }
        const { service } = harness({ store, now, limits: { maxBytesPerPrincipal: 3 } })
        const permanent = await service.putDeviceCacheEntry({ key: 'permanent', value: { kind: 'bytes', data: new Uint8Array([1]) } })
        expect(permanent.entry.expiresAt).toBeUndefined()
        const short = await service.putDeviceCacheEntry({ key: 'short', value: { kind: 'bytes', data: new Uint8Array([1, 2]) }, ttlMs: 1 })
        expect(short.entry.expiresAt).toBe(1_001)
        await expect(service.putDeviceCacheEntry({ key: 'max', value: { kind: 'bytes', data: new Uint8Array() }, ttlMs: 2_592_000_000 })).resolves.toBeDefined()
        expect(await codeOf(service.putDeviceCacheEntry({ key: 'over', value: { kind: 'json', value: null }, ttlMs: 2_592_000_001 }))).toBe('RESOURCE_LIMIT')
        for (const ttlMs of [0, -1, 1.5]) {
            expect(await codeOf(service.putDeviceCacheEntry({ key: `bad-${ttlMs}`, value: { kind: 'json', value: null }, ttlMs }))).toBe('INVALID_ARGUMENT')
        }

        now.value = 1_001
        expect(await service.getDeviceCacheEntry('short')).toBeNull()
        const recreated = harness({ store, now, limits: { maxBytesPerPrincipal: 3 } }).service
        await expect(recreated.putDeviceCacheEntry({ key: 'replacement', value: { kind: 'bytes', data: new Uint8Array([3, 4]) } })).resolves.toMatchObject({ evictedKeys: [] })
    })

    it('lists deterministic prefix pages at default/max limits and binds opaque cursors to principal, instance, query, and unload', async () => {
        const store = new MemoryDeviceCacheStore()
        const cursors = new CursorRegistry()
        const abortController = new AbortController()
        const { service } = harness({ store, cursors, abortController, instanceId: 'instance-a' })
        for (let index = 104; index >= 0; index--) {
            await service.putDeviceCacheEntry({
                key: `item/${String(index).padStart(3, '0')}`,
                value: { kind: 'json', value: index },
            })
        }
        await service.putDeviceCacheEntry({ key: 'other', value: { kind: 'json', value: true } })

        const first = await service.listDeviceCacheEntries({ prefix: 'item/' })
        expect(first.items).toHaveLength(50)
        expect(first.items[0].key).toBe('item/000')
        expect(first.items[49].key).toBe('item/049')
        expect(first.nextCursor).toEqual(expect.any(String))
        const second = await service.listDeviceCacheEntries({ prefix: 'item/', cursor: first.nextCursor })
        expect(second.items[0].key).toBe('item/050')

        const maximum = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 100 })
        expect(maximum.items).toHaveLength(100)
        expect(await codeOf(service.listDeviceCacheEntries({ limit: 101 }))).toBe('RESOURCE_LIMIT')

        const queryBound = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        expect(await codeOf(service.listDeviceCacheEntries({ prefix: 'other', limit: 1, cursor: queryBound.nextCursor }))).toBe('INVALID_ARGUMENT')
        const principalBound = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        const foreign = harness({ store, cursors, principalId: PRINCIPAL_B, instanceId: 'instance-b' }).service
        expect(await codeOf(foreign.listDeviceCacheEntries({ prefix: 'item/', limit: 1, cursor: principalBound.nextCursor }))).toBe('INVALID_ARGUMENT')
        const instanceBound = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        const otherInstance = harness({ store, cursors, instanceId: 'instance-other' }).service
        expect(await codeOf(otherInstance.listDeviceCacheEntries({ prefix: 'item/', limit: 1, cursor: instanceBound.nextCursor }))).toBe('INVALID_ARGUMENT')
        const tamperBound = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        expect(await codeOf(service.listDeviceCacheEntries({ prefix: 'item/', limit: 1, cursor: `${tamperBound.nextCursor}x` }))).toBe('INVALID_ARGUMENT')

        const unloadBound = await service.listDeviceCacheEntries({ prefix: 'item/', limit: 1 })
        abortController.abort()
        const replacement = harness({ store, cursors, instanceId: 'instance-a' }).service
        expect(await codeOf(replacement.listDeviceCacheEntries({ prefix: 'item/', limit: 1, cursor: unloadBound.nextCursor }))).toBe('INVALID_ARGUMENT')
    })

    it('deletes with CAS and clears exact prefix counts after expiry purging', async () => {
        const now = { value: 100 }
        const { service } = harness({ now })
        const target = await service.putDeviceCacheEntry({ key: 'group/a', value: { kind: 'json', value: 1 } })
        await service.putDeviceCacheEntry({ key: 'group/b', value: { kind: 'json', value: 2 } })
        await service.putDeviceCacheEntry({ key: 'group/expired', value: { kind: 'json', value: 3 }, ttlMs: 1 })
        await service.putDeviceCacheEntry({ key: 'other', value: { kind: 'json', value: 4 } })
        expect(await codeOf(service.deleteDeviceCacheEntry('group/a', { expectedRevision: 'wrong' }))).toBe('CONFLICT')
        expect(await service.deleteDeviceCacheEntry('group/a', { expectedRevision: target.entry.revision })).toBe(true)
        expect(await service.deleteDeviceCacheEntry('group/a')).toBe(false)
        now.value = 101
        expect(await service.clearDeviceCache({ prefix: 'group/' })).toBe(1)
        expect((await service.listDeviceCacheEntries()).items.map((item) => item.key)).toEqual(['other'])
        expect(await service.clearDeviceCache()).toBe(1)
    })

    it('persists records and durable read access timestamps across service recreation', async () => {
        const store = new MemoryDeviceCacheStore()
        const now = { value: 100 }
        const first = harness({ store, now }).service
        await first.putDeviceCacheEntry({ key: 'persisted', value: { kind: 'json', value: { ok: true } } })
        now.value = 200
        const second = harness({ store, now }).service
        expect(await second.getDeviceCacheEntry('persisted')).toMatchObject({ value: { ok: true }, lastAccessedAt: 200 })
        const third = harness({ store, now }).service
        expect((await third.listDeviceCacheEntries()).items[0]).toMatchObject({ key: 'persisted', lastAccessedAt: 200 })
    })

    it.each(['purge', 'quarantine', 'delete'] as const)('cleans only the lifecycle principal and its cursors on %s', async (action) => {
        const store = new MemoryDeviceCacheStore()
        const cursors = new CursorRegistry()
        const lifecycle = new PluginDataLifecycleRegistry()
        const unregister = registerDeviceCacheLifecycle(store, cursors, lifecycle)
        const a = harness({ store, cursors, principalId: PRINCIPAL_A, instanceId: 'a' }).service
        const b = harness({ store, cursors, principalId: PRINCIPAL_B, instanceId: 'b' }).service
        for (let index = 0; index < 2; index++) {
            await a.putDeviceCacheEntry({ key: `a/${index}`, value: { kind: 'json', value: index } })
            await b.putDeviceCacheEntry({ key: `b/${index}`, value: { kind: 'json', value: index } })
        }
        const aPage = await a.listDeviceCacheEntries({ limit: 1 })
        const bPage = await b.listDeviceCacheEntries({ limit: 1 })

        const result = await lifecycle.run(PRINCIPAL_A, action)
        expect(result.failures).toEqual([])
        expect(await a.listDeviceCacheEntries()).toEqual({ items: [] })
        expect((await b.listDeviceCacheEntries()).items.map((item) => item.key)).toEqual(['b/0', 'b/1'])
        expect(await codeOf(a.listDeviceCacheEntries({ limit: 1, cursor: aPage.nextCursor }))).toBe('INVALID_ARGUMENT')
        await expect(b.listDeviceCacheEntries({ limit: 1, cursor: bPage.nextCursor })).resolves.toMatchObject({ items: [{ key: 'b/1' }] })
        unregister()
    })

    it('keeps summaries content-free and relies on the dedicated store boundary rather than save data', async () => {
        const store = new MemoryDeviceCacheStore()
        const lifecycle = new PluginDataLifecycleRegistry()
        const unregister = registerDeviceCacheLifecycle(store, new CursorRegistry(), lifecycle)
        const { service } = harness({ store })
        await service.putDeviceCacheEntry({ key: 'private-derived-data', value: { kind: 'json', value: { tag: 'secret-ish' } } })
        const result = await lifecycle.run(PRINCIPAL_A, 'summarize')
        expect(result).toMatchObject({ failures: [] })
        expect(JSON.stringify(result)).not.toContain('private-derived-data')
        expect(await service.getDeviceCacheEntry('private-derived-data')).toMatchObject({ value: { tag: 'secret-ish' } })
        unregister()
    })
})
