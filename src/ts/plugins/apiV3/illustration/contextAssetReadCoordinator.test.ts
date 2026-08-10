import { describe, expect, it, vi } from 'vitest'
import {
    ContextAssetReadCoordinator,
    type ContextAssetReadLane,
    type ContextAssetReadOwner,
} from './contextAssetReadCoordinator'

interface Deferred<T> {
    promise: Promise<T>
    resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
    return { promise, resolve }
}

const owner = (principalId = 'principal-a', instanceId = 'instance-a'): ContextAssetReadOwner => ({
    principalId,
    instanceId,
})

describe('context asset read coordinator', () => {
    it('continues after more than sixty sequential reads without a time-window rejection', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const values: number[] = []

        for (let index = 0; index < 65; index += 1) {
            values.push(await coordinator.schedule({
                owner: owner(),
                lane: 'thumbnail',
                run: async () => index,
            }))
        }

        expect(values).toEqual(Array.from({ length: 65 }, (_, index) => index))
    })

    it('runs at most four physical reads and at most one explicit original per principal', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const release = deferred<void>()
        const starts: string[] = []
        let active = 0
        let activeOriginal = 0
        let maximumActive = 0
        let maximumOriginal = 0
        const schedule = (label: string, lane: ContextAssetReadLane) => coordinator.schedule({
            owner: owner(),
            lane,
            run: async () => {
                starts.push(label)
                active += 1
                if (lane === 'original') activeOriginal += 1
                maximumActive = Math.max(maximumActive, active)
                maximumOriginal = Math.max(maximumOriginal, activeOriginal)
                await release.promise
                active -= 1
                if (lane === 'original') activeOriginal -= 1
                return label
            },
        })

        const reads = [
            schedule('original-0', 'original'),
            schedule('original-1', 'original'),
            schedule('original-2', 'original'),
            schedule('thumbnail-0', 'thumbnail'),
            schedule('thumbnail-1', 'thumbnail'),
            schedule('thumbnail-2', 'thumbnail'),
            schedule('digest-0', 'digest'),
            schedule('digest-1', 'digest'),
        ]

        expect(starts).toEqual(['original-0', 'thumbnail-0', 'thumbnail-1', 'thumbnail-2'])
        expect(maximumActive).toBe(4)
        expect(maximumOriginal).toBe(1)

        release.resolve()
        await expect(Promise.all(reads)).resolves.toEqual([
            'original-0',
            'original-1',
            'original-2',
            'thumbnail-0',
            'thumbnail-1',
            'thumbnail-2',
            'digest-0',
            'digest-1',
        ])
        expect(maximumActive).toBe(4)
        expect(maximumOriginal).toBe(1)
    })

    it('preserves FIFO within lanes and starts the oldest eligible lane head', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const starts: string[] = []
        const gates = new Map<string, Deferred<string>>()
        const schedule = (label: string, lane: ContextAssetReadLane) => {
            const gate = deferred<string>()
            gates.set(label, gate)
            return coordinator.schedule({
                owner: owner(),
                lane,
                run: async () => {
                    starts.push(label)
                    return gate.promise
                },
            })
        }

        const reads = [
            schedule('original-active', 'original'),
            schedule('thumbnail-active-0', 'thumbnail'),
            schedule('thumbnail-active-1', 'thumbnail'),
            schedule('thumbnail-active-2', 'thumbnail'),
            schedule('original-waiting', 'original'),
            schedule('digest-0', 'digest'),
            schedule('digest-1', 'digest'),
            schedule('thumbnail-0', 'thumbnail'),
            schedule('thumbnail-1', 'thumbnail'),
        ]

        expect(starts).toEqual([
            'original-active',
            'thumbnail-active-0',
            'thumbnail-active-1',
            'thumbnail-active-2',
        ])

        gates.get('thumbnail-active-0')!.resolve('thumbnail-active-0')
        await vi.waitFor(() => expect(starts.at(-1)).toBe('digest-0'))
        gates.get('thumbnail-active-1')!.resolve('thumbnail-active-1')
        await vi.waitFor(() => expect(starts.at(-1)).toBe('digest-1'))
        gates.get('thumbnail-active-2')!.resolve('thumbnail-active-2')
        await vi.waitFor(() => expect(starts.at(-1)).toBe('thumbnail-0'))
        gates.get('thumbnail-0')!.resolve('thumbnail-0')
        await vi.waitFor(() => expect(starts.at(-1)).toBe('thumbnail-1'))
        gates.get('original-active')!.resolve('original-active')
        await vi.waitFor(() => expect(starts.at(-1)).toBe('original-waiting'))

        for (const label of ['digest-0', 'digest-1', 'thumbnail-1', 'original-waiting']) {
            gates.get(label)!.resolve(label)
        }

        await expect(Promise.all(reads)).resolves.toEqual([
            'original-active',
            'thumbnail-active-0',
            'thumbnail-active-1',
            'thumbnail-active-2',
            'original-waiting',
            'digest-0',
            'digest-1',
            'thumbnail-0',
            'thumbnail-1',
        ])
        expect(starts).toEqual([
            'original-active',
            'thumbnail-active-0',
            'thumbnail-active-1',
            'thumbnail-active-2',
            'digest-0',
            'digest-1',
            'thumbnail-0',
            'thumbnail-1',
            'original-waiting',
        ])
    })

    it('accepts exactly 128 queued jobs and rejects the next as retryable RESOURCE_LIMIT', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const activeGate = deferred<void>()
        const active = Array.from({ length: 4 }, (_, index) => coordinator.schedule({
            owner: owner(),
            lane: 'thumbnail',
            run: async () => {
                await activeGate.promise
                return `active-${index}`
            },
        }).catch((error: unknown) => error))
        const queued = Array.from({ length: 128 }, (_, index) => coordinator.schedule({
            owner: owner(),
            lane: 'digest',
            run: async () => `queued-${index}`,
        }).catch((error: unknown) => error))

        await expect(coordinator.schedule({
            owner: owner(),
            lane: 'thumbnail',
            run: async () => 'overflow',
        })).rejects.toMatchObject({
            name: 'PluginApiError',
            code: 'RESOURCE_LIMIT',
            retryable: true,
            message: expect.any(String),
        })

        coordinator.retirePrincipal('principal-a')
        activeGate.resolve()
        const queuedResults = await Promise.all(queued)
        expect(queuedResults).toHaveLength(128)
        expect(queuedResults).toEqual(queuedResults.map(() => expect.objectContaining({ code: 'ABORTED' })))
        expect(await Promise.all(active)).toEqual(active.map(() => expect.objectContaining({ code: 'ABORTED' })))
    })

    it('removes an aborted queued job without consuming a physical slot', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const starts: string[] = []
        const gates = new Map<string, Deferred<string>>()
        const schedule = (label: string, signal?: AbortSignal) => {
            const gate = deferred<string>()
            gates.set(label, gate)
            return coordinator.schedule({
                owner: owner(),
                lane: 'thumbnail',
                signal,
                run: async () => {
                    starts.push(label)
                    return gate.promise
                },
            })
        }
        const active = ['active-0', 'active-1', 'active-2', 'active-3'].map((label) => schedule(label))
        const abortController = new AbortController()
        const aborted = schedule('aborted-queued', abortController.signal)
        const next = schedule('next')

        abortController.abort()
        await expect(aborted).rejects.toMatchObject({ code: 'ABORTED', retryable: false })
        expect(starts).not.toContain('aborted-queued')

        gates.get('active-0')!.resolve('active-0')
        await vi.waitFor(() => expect(starts.at(-1)).toBe('next'))
        expect(starts).not.toContain('aborted-queued')

        for (const label of ['active-1', 'active-2', 'active-3', 'next']) gates.get(label)!.resolve(label)
        await expect(Promise.all([...active, next])).resolves.toEqual([
            'active-0',
            'active-1',
            'active-2',
            'active-3',
            'next',
        ])
    })

    it('holds an active aborted permit until the physical promise settles', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const starts: string[] = []
        const signals = new Map<string, AbortSignal>()
        const gates = new Map<string, Deferred<string>>()
        const schedule = (label: string, signal?: AbortSignal) => {
            const gate = deferred<string>()
            gates.set(label, gate)
            return coordinator.schedule({
                owner: owner(),
                lane: 'thumbnail',
                signal,
                run: async (physicalSignal) => {
                    starts.push(label)
                    signals.set(label, physicalSignal)
                    return gate.promise
                },
            })
        }
        const abortController = new AbortController()
        const aborted = schedule('active-aborted', abortController.signal)
        const active = ['active-1', 'active-2', 'active-3'].map((label) => schedule(label))
        const waiting = schedule('waiting')

        abortController.abort()
        expect(signals.get('active-aborted')?.aborted).toBe(true)
        await Promise.resolve()
        expect(starts).not.toContain('waiting')

        gates.get('active-aborted')!.resolve('ignored')
        await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' })
        await vi.waitFor(() => expect(starts.at(-1)).toBe('waiting'))

        for (const label of ['active-1', 'active-2', 'active-3', 'waiting']) gates.get(label)!.resolve(label)
        await expect(Promise.all([...active, waiting])).resolves.toEqual([
            'active-1',
            'active-2',
            'active-3',
            'waiting',
        ])
    })

    it('cancels one instance without cancelling a replacement instance or another principal', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const starts: string[] = []
        const signals = new Map<string, AbortSignal>()
        const gates = new Map<string, Deferred<string>>()
        const schedule = (label: string, readOwner: ContextAssetReadOwner) => {
            const gate = deferred<string>()
            gates.set(label, gate)
            return coordinator.schedule({
                owner: readOwner,
                lane: 'thumbnail',
                run: async (signal) => {
                    starts.push(label)
                    signals.set(label, signal)
                    return gate.promise
                },
            })
        }
        const oldOwner = owner('principal-a', 'instance-old')
        const replacementOwner = owner('principal-a', 'instance-new')
        const otherOwner = owner('principal-b', 'instance-old')
        const oldActive = schedule('old-active', oldOwner)
        const replacements = [
            schedule('replacement-0', replacementOwner),
            schedule('replacement-1', replacementOwner),
            schedule('replacement-2', replacementOwner),
        ]
        const oldQueued = schedule('old-queued', oldOwner)
        const replacementQueued = schedule('replacement-queued', replacementOwner)
        const other = schedule('other-principal', otherOwner)

        coordinator.cancelInstance(oldOwner)
        expect(signals.get('old-active')?.aborted).toBe(true)
        expect(signals.get('replacement-0')?.aborted).toBe(false)
        expect(signals.get('other-principal')?.aborted).toBe(false)
        await expect(oldQueued).rejects.toMatchObject({ code: 'ABORTED' })

        gates.get('old-active')!.resolve('ignored')
        await expect(oldActive).rejects.toMatchObject({ code: 'ABORTED' })
        await vi.waitFor(() => expect(starts).toContain('replacement-queued'))

        for (const label of ['replacement-0', 'replacement-1', 'replacement-2', 'replacement-queued', 'other-principal']) {
            gates.get(label)!.resolve(label)
        }
        await expect(Promise.all([...replacements, replacementQueued, other])).resolves.toEqual([
            'replacement-0',
            'replacement-1',
            'replacement-2',
            'replacement-queued',
            'other-principal',
        ])
        expect(starts).not.toContain('old-queued')
    })

    it('retires a principal only after its active jobs settle and removes idle state', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const gate = deferred<string>()
        let activeSignal: AbortSignal | undefined
        const active = coordinator.schedule({
            owner: owner(),
            lane: 'thumbnail',
            run: async (signal) => {
                activeSignal = signal
                return gate.promise
            },
        })
        const queued = coordinator.schedule({
            owner: owner(),
            lane: 'digest',
            run: async () => 'queued',
        })

        coordinator.retirePrincipal('principal-a')
        expect(activeSignal?.aborted).toBe(true)
        await expect(queued).rejects.toMatchObject({ code: 'ABORTED' })
        await expect(coordinator.schedule({
            owner: owner('principal-a', 'replacement-before-settle'),
            lane: 'thumbnail',
            run: async () => 'too-early',
        })).rejects.toMatchObject({ code: 'ABORTED' })

        gate.resolve('ignored')
        await expect(active).rejects.toMatchObject({ code: 'ABORTED' })
        await expect(coordinator.schedule({
            owner: owner('principal-a', 'replacement-after-settle'),
            lane: 'thumbnail',
            run: async () => 'replacement',
        })).resolves.toBe('replacement')
    })
})
