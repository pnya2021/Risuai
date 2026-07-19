import { describe, expect, it, vi } from 'vitest'
import { isCurrentPluginRuntimeRecord, PluginRuntimeReplacementTransaction, reloadPluginRuntime, runCoordinatedPersistedRuntimeMutation, runCoordinatedPluginRuntimeMutation, suspendPluginRuntime } from './pluginRuntimeReplacement'
import { PluginRuntimeReloadCoordinator } from './pluginMutationCoordinator'

describe('plugin runtime dependency order', () => {
    it('unloads V3 ownership before clearing V2 registries and loads V2 before new V3 instances', async () => {
        const events: string[] = []
        const runtime = {
            loadV2: async (plugins: string[]) => { events.push(`v2:${plugins.join(',')}`) },
            loadV3: async (plugins: string[]) => { events.push(`v3:${plugins.join(',')}`) },
        }

        await reloadPluginRuntime(['old-v2'], ['new-v3'], runtime)
        expect(events).toEqual(['v3:', 'v2:old-v2', 'v3:new-v3'])

        events.length = 0
        await suspendPluginRuntime(runtime)
        expect(events).toEqual(['v3:', 'v2:'])
    })

    it('rejects retired, disabled, or stale same-principal runtime snapshots', () => {
        const current = {
            principalId: '11111111-1111-4111-8111-111111111111', name: 'demo',
            version: '3.0', script: 'new code', enabled: true,
        }
        expect(isCurrentPluginRuntimeRecord(current, [current], () => false)).toBe(true)
        expect(isCurrentPluginRuntimeRecord({ ...current, script: 'old code' }, [current], () => false)).toBe(false)
        expect(isCurrentPluginRuntimeRecord(current, [{ ...current, enabled: false }], () => false)).toBe(false)
        expect(isCurrentPluginRuntimeRecord(current, [current], () => true)).toBe(false)
    })
})

describe('PluginRuntimeReplacementTransaction', () => {
    it('releases the reload lease when pre-suspend authorization throws', async () => {
        const coordinator = new PluginRuntimeReloadCoordinator<unknown>()
        const release = await coordinator.acquire()
        const expected = new Error('authorization failed')
        await expect(PluginRuntimeReplacementTransaction.prepare({
            suspend: vi.fn(), resume: vi.fn(), release,
        }, () => { throw expected })).rejects.toBe(expected)

        const nextRelease = await Promise.race([
            coordinator.acquire(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reload lease remained locked')), 100)),
        ])
        nextRelease()
    })
    it('authorizes by stable installed record across self-suspension and rejects a queued stale record', async () => {
        const events: string[] = []
        let instanceActive = true
        let installedRecordCurrent = true
        const transaction = await PluginRuntimeReplacementTransaction.prepare({
            suspend: () => { events.push('suspend'); instanceActive = false },
            resume: () => { events.push('resume') },
            release: () => { events.push('release') },
        }, () => instanceActive && installedRecordCurrent)
        expect(instanceActive && installedRecordCurrent).toBe(false)
        await runCoordinatedPluginRuntimeMutation(
            transaction,
            async (markLive) => {
                if (!installedRecordCurrent) throw new Error('stale installed record')
                markLive(); events.push('commit-live')
            },
            async () => { events.push('reload') },
            vi.fn(),
        )
        expect(events).toEqual(['suspend', 'commit-live', 'reload', 'release'])

        // The exact same record can still be installed after another runtime
        // instance replaced this caller. The pre-suspend instance gate must
        // reject that old queued call even though stable identity is true.
        installedRecordCurrent = true
        const staleSuspend = vi.fn()
        const staleRelease = vi.fn()
        await expect(PluginRuntimeReplacementTransaction.prepare({
            suspend: staleSuspend, resume: vi.fn(), release: staleRelease,
        }, () => instanceActive && installedRecordCurrent)).rejects.toThrow('installed record is no longer current')
        expect(staleSuspend).not.toHaveBeenCalled()
        expect(staleRelease).toHaveBeenCalledOnce()
    })
    it('coordinates one reload and chooses rollback before, or fail-closed after, live mutation', async () => {
        const successEvents: string[] = []
        const success = await PluginRuntimeReplacementTransaction.prepare({
            suspend: () => { successEvents.push('suspend') },
            resume: () => { successEvents.push('resume') },
            release: () => { successEvents.push('release') },
        })
        await expect(runCoordinatedPluginRuntimeMutation(
            success,
            async (markLive) => { successEvents.push('mutate'); markLive(); return 'done' },
            async () => { successEvents.push('reload') },
            async () => { successEvents.push('fail-closed') },
        )).resolves.toBe('done')
        expect(successEvents).toEqual(['suspend', 'mutate', 'reload', 'release'])

        const rollbackEvents: string[] = []
        const rollback = await PluginRuntimeReplacementTransaction.prepare({
            suspend: () => { rollbackEvents.push('suspend') },
            resume: () => { rollbackEvents.push('resume') },
            release: () => { rollbackEvents.push('release') },
        })
        await expect(runCoordinatedPluginRuntimeMutation(
            rollback,
            async () => { throw new Error('before live') },
            vi.fn(),
            async () => { rollbackEvents.push('fail-closed') },
        )).rejects.toThrow('before live')
        expect(rollbackEvents).toEqual(['suspend', 'resume', 'release'])

        const failedEvents: string[] = []
        const failed = await PluginRuntimeReplacementTransaction.prepare({
            suspend: () => { failedEvents.push('suspend') },
            resume: () => { failedEvents.push('resume') },
            release: () => { failedEvents.push('release') },
        })
        await expect(runCoordinatedPluginRuntimeMutation(
            failed,
            async (markLive) => { markLive() },
            async () => { throw new Error('reload failed') },
            async () => { failedEvents.push('fail-closed') },
        )).rejects.toThrow('reload failed')
        expect(failedEvents).toEqual(['suspend', 'fail-closed', 'release'])
    })

    it('recovers a partially failed prepare and fails closed if resume also fails', async () => {
        const events: string[] = []
        const release = vi.fn()
        await expect(PluginRuntimeReplacementTransaction.prepare({
            suspend: async () => { events.push('suspend'); throw new Error('partial suspend') },
            resume: async () => { events.push('resume') },
            release,
        })).rejects.toThrow('partial suspend')
        expect(events).toEqual(['suspend', 'resume'])
        expect(release).toHaveBeenCalledOnce()

        const failClosed = vi.fn()
        await expect(PluginRuntimeReplacementTransaction.prepare({
            suspend: async () => { throw new Error('partial suspend') },
            resume: async () => { throw new Error('resume failed') },
            failClosed,
        })).rejects.toBeInstanceOf(AggregateError)
        expect(failClosed).toHaveBeenCalledOnce()
    })

    it('releases an exclusive runtime lease exactly once on terminal state', async () => {
        const committedRelease = vi.fn()
        const committed = await PluginRuntimeReplacementTransaction.prepare({
            suspend: vi.fn(), resume: vi.fn(), release: committedRelease,
        })
        committed.commit()
        await committed.rollback()
        expect(committedRelease).toHaveBeenCalledOnce()

        const rolledBackRelease = vi.fn()
        const rolledBack = await PluginRuntimeReplacementTransaction.prepare({
            suspend: vi.fn(), resume: vi.fn(), release: rolledBackRelease,
        })
        await rolledBack.rollback()
        await rolledBack.rollback()
        expect(rolledBackRelease).toHaveBeenCalledOnce()
    })
    it('suspends, commits without resuming, and keeps rollback retryable', async () => {
        const events: string[] = []
        const transaction = await PluginRuntimeReplacementTransaction.prepare({
            suspend: () => { events.push('suspend') },
            resume: () => { events.push('resume') },
        })
        transaction.commit()
        await transaction.rollback()
        expect(events).toEqual(['suspend'])
        expect(transaction.state).toBe('committed')

        const resume = vi.fn().mockRejectedValueOnce(new Error('resume')).mockResolvedValueOnce(undefined)
        const retryable = await PluginRuntimeReplacementTransaction.prepare({ suspend: vi.fn(), resume })
        await expect(retryable.rollback()).rejects.toThrow('resume')
        expect(retryable.state).toBe('prepared')
        await retryable.rollback()
        expect(retryable.state).toBe('rolled-back')
    })

    it('fails closed without resuming after live lifecycle application starts', async () => {
        const resume = vi.fn()
        const reload = vi.fn()
        const transaction = await PluginRuntimeReplacementTransaction.prepare({ suspend: vi.fn(), resume })
        await transaction.failClosed(reload)
        await transaction.rollback()
        expect(transaction.state).toBe('failed-closed')
        expect(reload).toHaveBeenCalledOnce()
        expect(resume).not.toHaveBeenCalled()
    })

    it('keeps restore persistence, live replacement, normalized write, and reload under one suspended lease', async () => {
        const events: string[] = []
        const transaction = await PluginRuntimeReplacementTransaction.prepare({
            suspend: () => { events.push('suspend') },
            resume: () => { events.push('resume') },
            release: () => { events.push('release') },
        })
        await expect(runCoordinatedPersistedRuntimeMutation(
            transaction,
            async () => { events.push('persist-request'); return 'persisted' },
            async (persisted) => {
                events.push(`live:${persisted}`)
                events.push('persist-normalized')
            },
            async () => { events.push('reload') },
            async () => { events.push('fail-closed') },
        )).resolves.toEqual({ persisted: 'persisted', result: undefined })
        expect(events).toEqual(['suspend', 'persist-request', 'live:persisted', 'persist-normalized', 'reload', 'release'])
    })

    it('keeps staged archive assets, cold data, live DB, and normalized persistence inside the restore lease', async () => {
        const events: string[] = []
        const transaction = await PluginRuntimeReplacementTransaction.prepare({
            suspend: () => { events.push('suspend') }, resume: vi.fn(), release: () => { events.push('release') },
        })
        await runCoordinatedPluginRuntimeMutation(
            transaction,
            async (markIrreversible) => {
                markIrreversible(); events.push('asset-write')
                events.push('cold-write')
                events.push('live-db')
                events.push('normalized-db-write')
            },
            async () => { events.push('reload') },
            async () => { events.push('fail-closed') },
        )
        expect(events).toEqual(['suspend', 'asset-write', 'cold-write', 'live-db', 'normalized-db-write', 'reload', 'release'])
    })

    it('fails closed when a persist request commits before its response is lost', async () => {
        const rejectedEvents: string[] = []
        let backingDatabase = 'old'
        const rejected = await PluginRuntimeReplacementTransaction.prepare({
            suspend: () => { rejectedEvents.push('suspend') },
            resume: () => { rejectedEvents.push('resume') },
            release: () => { rejectedEvents.push('release') },
        })
        await expect(runCoordinatedPersistedRuntimeMutation(
            rejected,
            async () => {
                rejectedEvents.push('persist-request')
                backingDatabase = 'restored'
                throw new Error('response lost after commit')
            },
            vi.fn(), vi.fn(), async () => { rejectedEvents.push('fail-closed') },
        )).rejects.toThrow('response lost after commit')
        expect(backingDatabase).toBe('restored')
        expect(rejectedEvents).toEqual(['suspend', 'persist-request', 'fail-closed', 'release'])
    })

    it('fails closed after persistence succeeds but live replacement fails', async () => {
        const appliedEvents: string[] = []
        const applied = await PluginRuntimeReplacementTransaction.prepare({
            suspend: () => { appliedEvents.push('suspend') },
            resume: () => { appliedEvents.push('resume') },
            release: () => { appliedEvents.push('release') },
        })
        await expect(runCoordinatedPersistedRuntimeMutation(
            applied,
            async () => { appliedEvents.push('persist-request') },
            async () => { throw new Error('normalized write conflict') },
            vi.fn(), async () => { appliedEvents.push('fail-closed') },
        )).rejects.toThrow('normalized write conflict')
        expect(appliedEvents).toEqual(['suspend', 'persist-request', 'fail-closed', 'release'])
    })
})
