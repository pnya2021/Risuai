import { describe, expect, it, vi } from 'vitest'
import { watchPluginFile } from './developModeWatcher'

describe('plugin development watcher lifecycle', () => {
    it('stops after abort and never recreates a missing/replaced principal', async () => {
        const abortController = new AbortController()
        const file = { lastModified: 1, text: vi.fn(async () => 'code') }
        const handle = { getFile: vi.fn(async () => file) } as unknown as FileSystemFileHandle
        const importPlugin = vi.fn(async () => undefined)
        const watcher = watchPluginFile(handle, {
            expectedPrincipalId: 'principal', signal: abortController.signal,
            currentPrincipalId: () => 'different', importPlugin,
            poll: async () => undefined,
        })
        await watcher
        expect(handle.getFile).not.toHaveBeenCalled()
        expect(importPlugin).not.toHaveBeenCalled()
    })

    it('hot reloads only while the expected principal is still installed', async () => {
        const abortController = new AbortController()
        const file = { lastModified: 1, text: vi.fn(async () => 'code') }
        const handle = { getFile: vi.fn(async () => file) } as unknown as FileSystemFileHandle
        const importPlugin = vi.fn(async () => { abortController.abort() })
        await watchPluginFile(handle, {
            expectedPrincipalId: 'principal', signal: abortController.signal,
            currentPrincipalId: () => 'principal', importPlugin,
            poll: async () => undefined,
            isTypescript: true,
        })
        expect(importPlugin).toHaveBeenCalledWith('code', expect.objectContaining({
            isHotReload: true, isUpdate: true, isTypescript: true, expectedPrincipalId: 'principal',
        }))
    })
})
