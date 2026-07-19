import { describe, expect, it, vi } from 'vitest'
import { PluginDataLifecycleRegistry } from './pluginDataLifecycle'

describe('plugin data lifecycle', () => {
    it('runs hooks in stable order under one operation and continues after bounded failure', async () => {
        const registry = new PluginDataLifecycleRegistry()
        const calls: string[] = []
        registry.register('permission', 'purge', async (context) => { calls.push(`permission:${context.operationId}`) })
        registry.register('secrets', 'purge', async () => { throw new Error(`sensitive ${'x'.repeat(1000)}`) })
        registry.register('storage', 'quarantine', async (context) => { calls.push(`storage:${context.operationId}`) })

        const result = await registry.uninstall('11111111-1111-4111-8111-111111111111')
        expect(calls).toHaveLength(2)
        expect(calls[0].split(':')[1]).toBe(calls[1].split(':')[1])
        expect(result.failures).toHaveLength(1)
        expect(result.failures[0].message.length).toBeLessThanOrEqual(256)
        expect(result.failures[0].message).not.toContain('sensitive')
    })

    it('serializes operations for the same principal and makes operation IDs idempotent', async () => {
        const registry = new PluginDataLifecycleRegistry()
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const hook = vi.fn(async () => gate)
        registry.register('permission', 'purge', hook)
        const first = registry.run('p', 'purge', { operationId: 'same' })
        const replay = registry.run('p', 'purge', { operationId: 'same' })
        await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1))
        release()
        expect(await replay).toEqual(await first)
    })

    it('keeps summarize, purge, and quarantine atomic against concurrent operations', async () => {
        const registry = new PluginDataLifecycleRegistry()
        const calls: string[] = []
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        registry.register('summary', 'summarize', async () => { calls.push('summarize:start'); await gate; calls.push('summarize:end') })
        registry.register('permission', 'purge', () => { calls.push('purge') })
        registry.register('storage', 'quarantine', () => { calls.push('quarantine') })
        registry.register('storage', 'delete', () => { calls.push('delete') })

        const uninstall = registry.uninstall('p', { operationId: 'uninstall' })
        await vi.waitFor(() => expect(calls).toEqual(['summarize:start']))
        const concurrentDelete = registry.run('p', 'delete', { operationId: 'delete' })
        release()
        await Promise.all([uninstall, concurrentDelete])

        expect(calls).toEqual(['summarize:start', 'summarize:end', 'purge', 'quarantine', 'delete'])
    })

    it('supports empty registries and explicit separate delete/reassociate actions', async () => {
        const registry = new PluginDataLifecycleRegistry()
        expect((await registry.uninstall('p')).failures).toEqual([])
        expect((await registry.run('p', 'delete')).action).toBe('delete')
        expect((await registry.run('p', 'reassociate')).action).toBe('reassociate')
    })

    it('runs the stable hook snapshot even when a hook unregisters entries during execution', async () => {
        const registry = new PluginDataLifecycleRegistry()
        const calls: string[] = []
        let removeFirst!: () => void
        let removeSecond!: () => void
        removeFirst = registry.register('first', 'purge', () => { calls.push('first'); removeFirst(); removeSecond() })
        removeSecond = registry.register('second', 'purge', () => { calls.push('second') })
        registry.register('third', 'purge', () => { calls.push('third') })
        await registry.run('p', 'purge')
        expect(calls).toEqual(['first', 'second', 'third'])
    })

    it('stops all principal instances and unregisters stop handles', async () => {
        const registry = new PluginDataLifecycleRegistry()
        const calls: string[] = []
        const removeA = registry.registerInstanceStop('p', 'a', async () => { calls.push('a') })
        registry.registerInstanceStop('p', 'b', async () => { calls.push('b') })
        removeA()
        await registry.stopPrincipalInstances('p')
        expect(calls).toEqual(['b'])
        await registry.stopPrincipalInstances('p')
        expect(calls).toEqual(['b'])
    })

    it('stops a stable instance snapshot when one stop unregisters the next', async () => {
        const registry = new PluginDataLifecycleRegistry()
        const calls: string[] = []
        let removeB!: () => void
        registry.registerInstanceStop('p', 'a', () => { calls.push('a'); removeB() })
        removeB = registry.registerInstanceStop('p', 'b', () => { calls.push('b') })
        await registry.stopPrincipalInstances('p')
        expect(calls).toEqual(['a', 'b'])
    })

    it('retires an installed principal in summarize-purge-quarantine-invalidate-stop-remove order', async () => {
        const registry = new PluginDataLifecycleRegistry()
        const calls: string[] = []
        let installed = true
        for (const action of ['summarize', 'purge', 'quarantine'] as const) {
            registry.register(action, action, () => { expect(installed).toBe(true); calls.push(action) })
        }
        registry.registerInstanceStop('p', 'instance', () => { calls.push('stop') })
        const retirement = registry.retirePrincipal('p', {
            invalidate: () => { calls.push('invalidate') },
            remove: () => { installed = false; calls.push('remove') },
        })
        expect(registry.isRetiring('p')).toBe(true)
        await retirement
        expect(calls).toEqual(['summarize', 'purge', 'quarantine', 'invalidate', 'stop', 'remove'])
        expect(installed).toBe(false)
        expect(registry.isRetiring('p')).toBe(true)
    })

    it('immediately stops registrations that arrive after the retirement fence, including during stop cleanup', async () => {
        const registry = new PluginDataLifecycleRegistry()
        const calls: string[] = []
        registry.registerInstanceStop('p', 'first', () => {
            calls.push('first')
            registry.registerInstanceStop('p', 'late-during-stop', () => { calls.push('late-during-stop') })
        })
        const retirement = registry.retirePrincipal('p', { invalidate: () => undefined })
        registry.registerInstanceStop('p', 'late-before-stop', () => { calls.push('late-before-stop') })
        await retirement
        await vi.waitFor(() => expect(calls).toEqual(expect.arrayContaining(['first', 'late-before-stop', 'late-during-stop'])))
        await registry.stopPrincipalInstances('p')
        expect(calls.filter((call) => call === 'first')).toHaveLength(1)
    })
})
