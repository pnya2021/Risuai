import { describe, expect, it, vi } from 'vitest'
import * as queryCaptureCacheExports from './queryCaptureCache'
import { QueryCaptureCache, type QueryCaptureOwner } from './queryCaptureCache'
import { createRevision } from './revision'

const owner = (overrides: Partial<QueryCaptureOwner> = {}): QueryCaptureOwner => ({
    principalId: '11111111-1111-4111-8111-111111111111',
    service: 'context-assets',
    instanceId: 'instance-1',
    ...overrides,
})

const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
    return { promise, resolve }
}

describe('query capture cache', () => {
    it('produces byte-exact synchronous revisions matching the canonical async revision', async () => {
        const synchronousRevision = (queryCaptureCacheExports as {
            createSynchronousRevision?: (value: unknown) => string
        }).createSynchronousRevision
        expect(synchronousRevision).toBeTypeOf('function')
        if (!synchronousRevision) return

        const fixture = {
            unicode: '한국어 🌿',
            nested: [{ zero: -0, enabled: true }, { value: null }],
            order: { second: 2, first: 1 },
        }
        expect(synchronousRevision(fixture)).toBe(await createRevision(fixture))
    })

    it('prepares query hashing before a synchronous lifecycle-bound capture commit', async () => {
        const cache = new QueryCaptureCache()
        const preparedApi = cache as unknown as {
            prepareCreate?: (owner: QueryCaptureOwner, query: unknown) => Promise<unknown>
            commitPrepared?: <T>(preparation: unknown, items: readonly T[]) => {
                captureRevision: string
                items: readonly T[]
            }
        }
        expect(preparedApi.prepareCreate).toBeTypeOf('function')
        expect(preparedApi.commitPrepared).toBeTypeOf('function')
        if (!preparedApi.prepareCreate || !preparedApi.commitPrepared) return

        const query = { scope: 'installed', selectors: ['char-1', 'conversation-1'] }
        const items = [{ id: 'module-a', nested: { count: 1 } }]
        const preparation = await preparedApi.prepareCreate(owner(), query)
        const committed = preparedApi.commitPrepared(preparation, items)
        const reference = await new QueryCaptureCache().create(owner(), query, items)
        expect(committed).not.toBeInstanceOf(Promise)
        expect(committed.captureRevision).toBe(reference.captureRevision)
        expect(committed.items).toEqual(reference.items)

        const stale = await preparedApi.prepareCreate(owner(), { stale: true })
        cache.clearInstance(owner().principalId, owner().instanceId)
        expect(() => preparedApi.commitPrepared!(stale, [{ id: 'stale' }]))
            .toThrowError(expect.objectContaining({ code: 'CONFLICT', retryable: true }))
    })

    it('does not commit a capture after its instance is cleared while query hashing is pending', async () => {
        const cache = new QueryCaptureCache()
        const digestGate = deferred<void>()
        const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
        let digestCalls = 0
        const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
            digestCalls += 1
            if (digestCalls === 1) await digestGate.promise
            return originalDigest(algorithm, data)
        })
        try {
            const pending = cache.create(owner(), { delayed: true }, [{ id: 'late' }])
            await vi.waitFor(() => expect(digestCalls).toBe(1))
            cache.clearInstance(owner().principalId, owner().instanceId)
            digestGate.resolve()

            await expect(pending).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        } finally {
            digestGate.resolve()
            digestSpy.mockRestore()
        }
    })

    it('binds deterministic captures to the principal, service, instance, and complete query', async () => {
        const cache = new QueryCaptureCache()
        const query = { scope: 'installed', selectors: { characterId: 'char-1', conversationId: 'chat-1' } }
        const items = [{ id: 'module-a', nested: { count: 1 } }]
        const first = await cache.create(owner(), query, items)
        const second = await cache.create(owner(), query, items)

        expect(first.captureRevision).toBe(second.captureRevision)
        expect(first.captureRevision).toMatch(/^sha256:[0-9a-f]{64}$/)
        await expect(cache.read(owner(), query, first.captureRevision)).resolves.toEqual(first)
        await expect(cache.read(owner({ principalId: '22222222-2222-4222-8222-222222222222' }), query, first.captureRevision))
            .rejects.toMatchObject({ code: 'CONFLICT', message: 'Context query capture is no longer available', retryable: true })
        await expect(cache.read(owner({ service: 'context-modules' }), query, first.captureRevision))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(cache.read(owner({ instanceId: 'instance-2' }), query, first.captureRevision))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(cache.read(owner(), { ...query, scope: 'active' }, first.captureRevision))
            .rejects.toMatchObject({
                code: 'INVALID_ARGUMENT',
                message: 'Context query capture does not match this request',
            })
    })

    it('expires after exactly five minutes and refreshes LRU recency without extending expiry', async () => {
        let now = 1_000
        const cache = new QueryCaptureCache({ now: () => now, maxCapturesPerPrincipal: 2 })
        const first = await cache.create(owner(), { page: 'first' }, [{ id: 'first' }])
        now += 1
        const second = await cache.create(owner(), { page: 'second' }, [{ id: 'second' }])
        await cache.read(owner(), { page: 'first' }, first.captureRevision)
        now += 1
        const third = await cache.create(owner(), { page: 'third' }, [{ id: 'third' }])

        await expect(cache.read(owner(), { page: 'second' }, second.captureRevision))
            .rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        await expect(cache.read(owner(), { page: 'first' }, first.captureRevision)).resolves.toEqual(first)
        await expect(cache.read(owner(), { page: 'third' }, third.captureRevision)).resolves.toEqual(third)

        now = 301_000
        await expect(cache.read(owner(), { page: 'first' }, first.captureRevision)).resolves.toEqual(first)
        now += 1
        await expect(cache.read(owner(), { page: 'first' }, first.captureRevision))
            .rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
    })

    it('rejects principal-aggregate item and metadata budgets instead of evicting captures', async () => {
        const itemCache = new QueryCaptureCache()
        await itemCache.create(owner(), { batch: 1 }, Array.from({ length: 10_000 }, (_, index) => ({ index })))
        await expect(itemCache.create(
            owner({ service: 'context-modules' }),
            { batch: 2 },
            Array.from({ length: 10_001 }, (_, index) => ({ index })),
        )).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT',
            message: 'Context query capture exceeds its bounded metadata budget',
        })

        const byteCache = new QueryCaptureCache()
        await byteCache.create(owner(), { batch: 1 }, [{ value: 'a'.repeat(8_388_000) }])
        await expect(byteCache.create(
            owner({ service: 'context-modules' }),
            { batch: 2 },
            [{ value: 'b'.repeat(8_390_000) }],
        )).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT',
            message: 'Context query capture exceeds its bounded metadata budget',
        })
    })

    it('rejects binary and Secret-bearing metadata and retains a deeply immutable ordered projection', async () => {
        const cache = new QueryCaptureCache()
        await expect(cache.create(owner(), {}, [{ bytes: new Uint8Array([1]) }]))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(cache.create(owner(), {}, [{ authorization: { pluginSecret: 'api-key' } }]))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

        const created = await cache.create(owner(), { order: true }, [
            { id: 'second', nested: { value: 2 } },
            { id: 'first', nested: { value: 1 } },
        ])
        expect(created.items.map((item) => item.id)).toEqual(['second', 'first'])
        expect(Object.isFrozen(created.items)).toBe(true)
        expect(Object.isFrozen(created.items[0])).toBe(true)
        expect(Object.isFrozen(created.items[0].nested)).toBe(true)
    })

    it('clears captures at principal, service, and instance lifecycle boundaries', async () => {
        const cache = new QueryCaptureCache()
        const principalCapture = await cache.create(owner(), { key: 1 }, [{ id: 1 }])
        const otherPrincipal = owner({ principalId: '22222222-2222-4222-8222-222222222222' })
        const retained = await cache.create(otherPrincipal, { key: 1 }, [{ id: 1 }])
        cache.clearPrincipal(owner().principalId)
        await expect(cache.read(owner(), { key: 1 }, principalCapture.captureRevision)).rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(cache.read(otherPrincipal, { key: 1 }, retained.captureRevision)).resolves.toEqual(retained)

        const instanceCapture = await cache.create(owner(), { key: 2 }, [{ id: 2 }])
        cache.clearInstance(owner().principalId, owner().instanceId)
        await expect(cache.read(owner(), { key: 2 }, instanceCapture.captureRevision)).rejects.toMatchObject({ code: 'CONFLICT' })

        const serviceCapture = await cache.create(owner(), { key: 3 }, [{ id: 3 }])
        cache.clearService(owner().principalId, owner().service)
        await expect(cache.read(owner(), { key: 3 }, serviceCapture.captureRevision)).rejects.toMatchObject({ code: 'CONFLICT' })
    })
})
