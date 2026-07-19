import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ensureColdDatabaseWriteback,
    flushColdDatabaseWriteback,
    hydrateColdDatabase,
    loadPluginsAfterColdDatabaseWriteback,
    registerColdDatabaseWritebackWriter,
    requestColdDatabaseWriteback,
    runAfterColdDatabaseWriteback,
} from './coldDatabaseHydration'

describe('cold database hydration writeback', () => {
    beforeEach(async () => { await flushColdDatabaseWriteback(async () => undefined) })

    it('persists repaired principals before plugin execution', async () => {
        const events: string[] = []
        hydrateColdDatabase({}, {
            setDatabase: () => { events.push('normalize'); return { pluginStateChanged: true } },
            getSnapshot: () => ({}),
        })
        await loadPluginsAfterColdDatabaseWriteback(
            async () => { events.push('durable-write') },
            async () => { events.push('plugin-load') },
        )
        expect(events).toEqual(['normalize', 'durable-write', 'plugin-load'])
    })

    it('keeps a failed write pending and retries it at the lowest plugin reload boundary', async () => {
        let attempts = 0
        const unregister = registerColdDatabaseWritebackWriter(async () => {
            attempts += 1
            if (attempts === 1) throw new Error('persist failed')
        })
        try {
            requestColdDatabaseWriteback()
            const load = vi.fn()
            await expect(runAfterColdDatabaseWriteback(load)).rejects.toThrow('persist failed')
            expect(load).not.toHaveBeenCalled()
            await expect(runAfterColdDatabaseWriteback(load)).resolves.toBeUndefined()
            expect(attempts).toBe(2)
            expect(load).toHaveBeenCalledOnce()
        } finally { unregister() }
    })

    it('coalesces concurrent loaders without exposing a pending=false gap', async () => {
        let release!: () => void
        let markStarted!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const started = new Promise<void>((resolve) => { markStarted = resolve })
        const writer = vi.fn(async () => { markStarted(); await gate })
        const unregister = registerColdDatabaseWritebackWriter(writer)
        try {
            requestColdDatabaseWriteback()
            const first = ensureColdDatabaseWriteback()
            await started
            const second = ensureColdDatabaseWriteback()
            expect(writer).toHaveBeenCalledOnce()
            release()
            await Promise.all([first, second])
            expect(writer).toHaveBeenCalledOnce()
        } finally { unregister() }
    })

    it('does not lose a new normalization request made during an in-flight write', async () => {
        let releaseFirst!: () => void
        let markFirstStarted!: () => void
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
        const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
        let calls = 0
        const unregister = registerColdDatabaseWritebackWriter(async () => {
            calls += 1
            if (calls === 1) { markFirstStarted(); await firstGate }
        })
        try {
            requestColdDatabaseWriteback()
            const flush = ensureColdDatabaseWriteback()
            await firstStarted
            requestColdDatabaseWriteback()
            releaseFirst()
            await flush
            expect(calls).toBe(2)
        } finally { unregister() }
    })

    it('fails closed when persistence is pending without a registered durable writer', async () => {
        requestColdDatabaseWriteback()
        await expect(ensureColdDatabaseWriteback()).rejects.toThrow('no durable writer is registered')
        await flushColdDatabaseWriteback(async () => undefined)
    })
})
