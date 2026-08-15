import { describe, expect, it, vi } from 'vitest'
import { CursorRegistry } from './cursorRegistry'

describe('cursor registry', () => {
    it('binds opaque cursors to principal, service and query and rejects tampering', async () => {
        const registry = new CursorRegistry()
        const cursor = await registry.create('p', 'assets', 'instance-a', { scope: 'active' }, { offset: 10 })
        expect(await registry.read(cursor, 'p', 'assets', 'instance-a', { scope: 'active' })).toEqual({ offset: 10 })
        await expect(registry.read(cursor, 'other', 'assets', 'instance-a', { scope: 'active' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(registry.read(cursor, 'p', 'assets', 'instance-b', { scope: 'active' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(registry.read(cursor + 'x', 'p', 'assets', 'instance-a', { scope: 'active' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })

    it('accepts exact TTL and rejects expired cursors', async () => {
        let now = 0
        const registry = new CursorRegistry({ ttlMs: 10, now: () => now })
        const cursor = await registry.create('p', 'assets', 'instance', {}, 1)
        now = 10
        expect(await registry.read(cursor, 'p', 'assets', 'instance', {})).toBe(1)
        now = 11
        await expect(registry.read(cursor, 'p', 'assets', 'instance', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })

    it('enforces 64 active cursors across services and clears on expiry, explicit clear and unload', async () => {
        const registry = new CursorRegistry({ maxPerPrincipal: 2 })
        await registry.create('p', 'assets', 'instance-a', { n: 1 }, 1)
        await registry.create('p', 'cache', 'instance-b', { n: 2 }, 2)
        await expect(registry.create('p', 'modules', 'instance-c', { n: 3 }, 3)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        registry.clearPrincipal('p')
        expect(registry.activeCount('p')).toBe(0)
        const cursor = await registry.create('p', 'assets', 'instance', {}, 1)
        registry.clear(cursor)
        expect(registry.activeCount('p')).toBe(0)
    })

    it('atomically enforces 64/65 concurrent creates principal-wide and supports scoped unload cleanup', async () => {
        const registry = new CursorRegistry()
        const results = await Promise.allSettled(Array.from({ length: 65 }, (_, n) =>
            registry.create('p', `service-${n % 3}`, `instance-${n % 4}`, { n }, n)))
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(64)
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
        expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'RESOURCE_LIMIT' })
        const fulfilledInstanceZero = results.filter((result, n) => result.status === 'fulfilled' && n % 4 === 0).length
        registry.clearInstance('p', 'instance-0')
        const remainingAfterInstanceClear = 64 - fulfilledInstanceZero
        expect(registry.activeCount('p')).toBe(remainingAfterInstanceClear)
        registry.clearService('p', 'service-1')
        expect(registry.activeCount('p')).toBeLessThan(remainingAfterInstanceClear)
    })

    it('does not insert an orphan when instance cleanup wins a pending create digest', async () => {
        let resolveDigest!: (value: string) => void
        const digest = vi.fn(() => new Promise<string>((resolve) => { resolveDigest = resolve }))
        const registry = new CursorRegistry({ maxPerPrincipal: 1, digest })
        const create = registry.create('p', 'assets', 'instance', {}, 1)
        await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce())
        registry.clearInstance('p', 'instance')
        resolveDigest('query')

        await expect(create).rejects.toMatchObject({ code: 'ABORTED' })
        expect(registry.activeCount('p')).toBe(0)
    })

    it('does not return a record cleared while a read digest is pending', async () => {
        let resolveReadDigest!: (value: string) => void
        let digestCalls = 0
        const registry = new CursorRegistry({
            digest: vi.fn(async () => {
                digestCalls += 1
                if (digestCalls === 1) return 'query'
                return new Promise<string>((resolve) => { resolveReadDigest = resolve })
            }),
        })
        const cursor = await registry.create('p', 'assets', 'instance', {}, 'secret')
        const read = registry.read(cursor, 'p', 'assets', 'instance', {})
        await vi.waitFor(() => expect(resolveReadDigest).toBeTypeOf('function'))
        registry.clearInstance('p', 'instance')
        resolveReadDigest('query')

        await expect(read).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })

    it('prepares cursor hashing before a synchronous lifecycle-bound commit', async () => {
        const registry = new CursorRegistry()
        const preparedApi = registry as unknown as {
            prepareCreate?: (
                principalId: string,
                service: string,
                instanceId: string,
                query: unknown,
            ) => Promise<unknown>
            commitPrepared?: <T>(preparation: unknown, value: T) => string
        }
        expect(preparedApi.prepareCreate).toBeTypeOf('function')
        expect(preparedApi.commitPrepared).toBeTypeOf('function')
        if (!preparedApi.prepareCreate || !preparedApi.commitPrepared) return

        const prepared = await preparedApi.prepareCreate('p', 'modules', 'instance', { page: 1 })
        const cursor = preparedApi.commitPrepared(prepared, { offset: 1 })
        expect(cursor).toBeTypeOf('string')
        expect(await registry.read(cursor, 'p', 'modules', 'instance', { page: 1 }))
            .toEqual({ offset: 1 })

        const stale = await preparedApi.prepareCreate('p', 'modules', 'instance', { page: 2 })
        registry.clearInstance('p', 'instance')
        expect(() => preparedApi.commitPrepared!(stale, { offset: 2 }))
            .toThrowError(expect.objectContaining({ code: 'ABORTED' }))
    })
})
