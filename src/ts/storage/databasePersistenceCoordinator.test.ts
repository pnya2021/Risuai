import { describe, expect, it } from 'vitest'
import { DatabasePersistenceCoordinator } from './databasePersistenceCoordinator'

describe('database persistence coordinator', () => {
    it('lets an in-flight normal save finish before an exclusive restore lands last', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const events: string[] = []
        let releaseSave!: () => void
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
        const token = coordinator.captureGeneration()
        const save = coordinator.runNormalWrite(token, async () => { events.push('save:start'); await saveGate; events.push('save:end') })
        await Promise.resolve()
        const restore = coordinator.runExclusiveMutation(async () => { events.push('restore') })
        await Promise.resolve()
        expect(events).toEqual(['save:start'])
        releaseSave()
        await Promise.all([save, restore])
        expect(events).toEqual(['save:start', 'save:end', 'restore'])
    })

    it('invalidates a stale save captured before an exclusive restore without deadlocking async rebase work', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const staleToken = coordinator.captureGeneration()
        let releaseRestore!: () => void
        const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve })
        const events: string[] = []
        const restore = coordinator.runExclusiveMutation(async () => { events.push('restore:start'); await restoreGate; events.push('restore:end') })
        await Promise.resolve()
        const staleSave = coordinator.runNormalWrite(staleToken, async () => { events.push('stale-save') })
        releaseRestore()
        const [, result] = await Promise.all([restore, staleSave])
        expect(result.executed).toBe(false)
        expect(events).toEqual(['restore:start', 'restore:end'])
    })
})
