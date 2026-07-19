import { describe, expect, it, vi } from 'vitest'
import { invokePermissionCheckedProvider } from './providerPermission'

describe('V3 provider permission boundary', () => {
    it('returns the legacy failure shape and never invokes a denied provider', async () => {
        const provider = vi.fn(async () => ({ success: true, content: 'secret' }))
        await expect(invokePermissionCheckedProvider(async () => false, provider, { prompt: 'x' } as any))
            .resolves.toEqual({ success: false, content: 'Permission denied: provider' })
        expect(provider).not.toHaveBeenCalled()
    })

    it('does not invoke a provider whose owning plugin instance is already aborted', async () => {
        const owner = new AbortController(); owner.abort()
        const permission = vi.fn(async () => true)
        const provider = vi.fn(async () => ({ success: true, content: 'stale' }))
        await expect(invokePermissionCheckedProvider(permission, provider, {} as any, undefined, owner.signal))
            .resolves.toEqual({ success: false, content: 'Permission denied: provider' })
        expect(permission).not.toHaveBeenCalled()
        expect(provider).not.toHaveBeenCalled()
    })
})
