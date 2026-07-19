import { describe, expect, it, vi } from 'vitest'
import { cleanupOwnedProviderRegistration, InstanceChannelRegistry, InstanceCleanupRegistry, OwnedTimeoutSet, registerInstanceResourceIfActive, removeOwnedArrayEntry, removeOwnedMapEntry, removeOwnedSetEntry, retainOrCleanupInstanceResource } from './pluginInstanceResources'

describe('instance-owned V3 resources', () => {
    it('drains only the exact instance even when display names are reused', async () => {
        const registry = new InstanceCleanupRegistry()
        const oldCleanup = vi.fn()
        const newCleanup = vi.fn()
        registry.add('old-instance', oldCleanup)
        registry.add('new-instance', newCleanup)

        await registry.drain('old-instance')

        expect(oldCleanup).toHaveBeenCalledOnce()
        expect(newCleanup).not.toHaveBeenCalled()
        expect(registry.count('new-instance')).toBe(1)
    })

    it('does not let stale same-name channel cleanup delete a newer instance registration', () => {
        const channels = new InstanceChannelRegistry()
        const oldCallback = vi.fn()
        const newCallback = vi.fn()
        channels.register('same-name', 'updates', 'old-instance', oldCallback)
        channels.register('same-name', 'updates', 'new-instance', newCallback)

        channels.removeOwned('same-name', 'updates', 'old-instance')

        expect(channels.get('same-name', 'updates')).toBe(newCallback)
        channels.removeOwned('same-name', 'updates', 'new-instance')
        expect(channels.get('same-name', 'updates')).toBeUndefined()
    })

    it('makes repeated stale drains harmless', async () => {
        const registry = new InstanceCleanupRegistry()
        const cleanup = vi.fn()
        registry.add('instance', cleanup)
        await registry.drain('instance')
        await registry.drain('instance')
        expect(cleanup).toHaveBeenCalledOnce()
    })

    it('does not let stale UI cleanup remove a newer same-id object', () => {
        const oldEntry = { id: 'shared', owner: 'old' }
        const newEntry = { id: 'shared', owner: 'new' }
        const entries = [newEntry]
        removeOwnedArrayEntry(entries, oldEntry)
        expect(entries).toEqual([newEntry])
        removeOwnedArrayEntry(entries, newEntry)
        expect(entries).toEqual([])
    })

    it('keeps a newer same-name provider and cancels delayed callbacks on unload', async () => {
        vi.useFakeTimers()
        const oldProvider = vi.fn()
        const newProvider = vi.fn()
        const providers = new Map([['shared', newProvider]])
        removeOwnedMapEntry(providers, 'shared', oldProvider)
        expect(providers.get('shared')).toBe(newProvider)
        const callbacks = new Set([oldProvider, newProvider])
        removeOwnedSetEntry(callbacks, oldProvider)
        expect(callbacks).toEqual(new Set([newProvider]))
        const timeouts = new OwnedTimeoutSet()
        const callback = vi.fn()
        timeouts.schedule(callback, 50)
        timeouts.clear()
        await vi.advanceTimersByTimeAsync(50)
        expect(callback).not.toHaveBeenCalled()
        vi.useRealTimers()
    })

    it('cleans provider sidecars after the shared provider map was already cleared', () => {
        const oldProvider = vi.fn()
        const oldOptions = { tokenizer: 'old' }
        const providers = new Map<string, Function>()
        const providerOptions = new Map([['shared', oldOptions]])
        const removeName = vi.fn()
        const removeModel = vi.fn()

        cleanupOwnedProviderRegistration({
            name: 'shared', provider: oldProvider, options: oldOptions,
            providers, providerOptions, removeName, removeModel,
        })

        expect(providerOptions.has('shared')).toBe(false)
        expect(removeName).toHaveBeenCalledOnce()
        expect(removeModel).toHaveBeenCalledOnce()
    })

    it('preserves a newer same-name provider and its sidecars during stale cleanup', () => {
        const oldProvider = vi.fn()
        const newProvider = vi.fn()
        const oldOptions = { tokenizer: 'old' }
        const newOptions = { tokenizer: 'new' }
        const providers = new Map<string, Function>([['shared', newProvider]])
        const providerOptions = new Map([['shared', newOptions]])
        const removeName = vi.fn()
        const removeModel = vi.fn()

        cleanupOwnedProviderRegistration({
            name: 'shared', provider: oldProvider, options: oldOptions,
            providers, providerOptions, removeName, removeModel,
        })

        expect(providers.get('shared')).toBe(newProvider)
        expect(providerOptions.get('shared')).toBe(newOptions)
        expect(removeName).not.toHaveBeenCalled()
        expect(removeModel).toHaveBeenCalledOnce()
    })

    it('does not let an aborted late registration overwrite a live same-name provider', () => {
        const liveProvider = vi.fn()
        const lateProvider = vi.fn()
        const providers = new Map<string, Function>([['shared', liveProvider]])

        expect(registerInstanceResourceIfActive(
            () => false,
            () => { providers.set('shared', lateProvider) },
        )).toBe(false)
        expect(providers.get('shared')).toBe(liveProvider)
    })

    it('immediately cleans a resource whose async registration finishes after unload', async () => {
        const owner = new AbortController(); owner.abort()
        const cleanup = vi.fn()
        const retain = vi.fn()
        await retainOrCleanupInstanceResource(owner.signal, cleanup, retain)
        expect(cleanup).toHaveBeenCalledOnce()
        expect(retain).not.toHaveBeenCalled()
    })

    it('immediately runs cleanup registered after unload has taken the callback list', async () => {
        const registry = new InstanceCleanupRegistry()
        const lateCleanup = vi.fn()
        registry.add('instance', () => { registry.add('instance', lateCleanup) })
        const callbacks = registry.take('instance')
        expect(registry.isClosing('instance')).toBe(true)
        await callbacks[0]()
        await vi.waitFor(() => expect(lateCleanup).toHaveBeenCalledOnce())
        expect(registry.count('instance')).toBe(0)
    })
})
