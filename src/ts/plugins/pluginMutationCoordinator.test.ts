import { describe, expect, it, vi } from 'vitest'
import { PluginMutationCoordinator, PluginRuntimeReloadCoordinator } from './pluginMutationCoordinator'

describe('installed plugin mutation coordinator', () => {
    it('serializes concurrent mutations and continues after a rejected mutation', async () => {
        const coordinator = new PluginMutationCoordinator()
        const calls: string[] = []
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const first = coordinator.run(async () => { calls.push('first:start'); await gate; calls.push('first:end') })
        const second = coordinator.run(async () => { calls.push('second'); throw new Error('expected') })
        const third = coordinator.run(async () => { calls.push('third') })
        await vi.waitFor(() => expect(calls).toEqual(['first:start']))
        release()
        await first
        await expect(second).rejects.toThrow('expected')
        await third
        expect(calls).toEqual(['first:start', 'first:end', 'second', 'third'])
    })
})

describe('plugin runtime reload coordinator', () => {
    it('holds queued reloads behind an exclusive replacement lease', async () => {
        const coordinator = new PluginRuntimeReloadCoordinator<string[]>()
        const release = await coordinator.acquire()
        const reload = vi.fn()
        const queued = coordinator.run(() => ['latest'], reload)
        await Promise.resolve()
        expect(reload).not.toHaveBeenCalled()
        release()
        await queued
        expect(reload).toHaveBeenCalledWith(['latest'])
    })

    it('serializes concurrent reloads and snapshots the latest database when each queued reload starts', async () => {
        const coordinator = new PluginRuntimeReloadCoordinator<string[]>()
        let installed = ['first']
        let running: string[] = []
        const snapshots: string[][] = []
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })

        const first = coordinator.run(
            () => [...installed],
            async (snapshot) => {
                snapshots.push(snapshot)
                await gate
                running = snapshot
            },
        )
        await vi.waitFor(() => expect(snapshots).toEqual([['first']]))

        installed = ['final']
        const second = coordinator.run(
            () => [...installed],
            async (snapshot) => {
                snapshots.push(snapshot)
                running = snapshot
            },
        )
        installed = ['final', 'latest']
        release()
        await Promise.all([first, second])

        expect(snapshots).toEqual([['first'], ['final', 'latest']])
        expect(running).toEqual(installed)
    })
})
