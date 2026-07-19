import { describe, expect, it, vi } from 'vitest'
import { replacePluginV3RuntimeSnapshot } from './pluginV3Reload'

describe('V3 runtime snapshot replacement', () => {
    it('unloads every spliced old instance, then starts a retained-principal update', async () => {
        const cleanupA = vi.fn(), cleanupB = vi.fn(), terminateA = vi.fn(), terminateB = vi.fn()
        const live = [
            { id: 'a', principalId: 'p-a', cleanup: cleanupA, terminate: terminateA },
            { id: 'b', principalId: 'p-b', cleanup: cleanupB, terminate: terminateB },
        ]
        const start = vi.fn((plugin: { id: string; principalId: string }) => { live.push({ ...plugin, cleanup: vi.fn(), terminate: vi.fn() }) })
        await replacePluginV3RuntimeSnapshot({
            liveInstances: live,
            plugins: [{ id: 'b-updated', principalId: 'p-b' }],
            unload: async (instance) => {
                live.splice(live.indexOf(instance), 1)
                await instance.cleanup()
                instance.terminate()
            },
            load: start,
        })
        expect(cleanupA).toHaveBeenCalledOnce(); expect(cleanupB).toHaveBeenCalledOnce()
        expect(terminateA).toHaveBeenCalledOnce(); expect(terminateB).toHaveBeenCalledOnce()
        expect(start).toHaveBeenCalledOnce()
        expect(live.map((entry) => entry.id)).toEqual(['b-updated'])
    })
})
