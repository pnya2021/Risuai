import { describe, expect, it } from 'vitest'
import { normalizePluginDatabaseState } from './pluginDatabaseNormalization'
import { clearPrincipalTombstonesForTests, invalidatePluginPrincipal, isCanonicalPluginPrincipalId } from './pluginPrincipal'
import { pluginDataLifecycle } from './pluginDataLifecycle'

describe('RisuAI plugin database normalization', () => {
    it('assigns a stable principal once and reports the required durable writeback', () => {
        const data: { plugins: Array<{ name: string; script: string; principalId?: string }> } = {
            plugins: [{ name: 'legacy', script: 'code' }],
        }
        expect(normalizePluginDatabaseState(data).pluginStateChanged).toBe(true)
        const principalId = data.plugins[0].principalId
        expect(isCanonicalPluginPrincipalId(principalId)).toBe(true)
        expect(normalizePluginDatabaseState(data).pluginStateChanged).toBe(false)
        expect(data.plugins[0].principalId).toBe(principalId)
    })

    it('preserves a tombstoned record only until its active retirement removes it', async () => {
        clearPrincipalTombstonesForTests()
        const principalId = '77777777-7777-4777-8777-777777777777'
        const data = { plugins: [{ name: 'demo', script: 'code', principalId }] }
        let releaseStop!: () => void
        let markStopStarted!: () => void
        const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
        const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve })
        pluginDataLifecycle.registerInstanceStop(principalId, 'instance', async () => {
            markStopStarted()
            await stopGate
        })
        const retirement = pluginDataLifecycle.retirePrincipal(principalId, {
            invalidate: () => invalidatePluginPrincipal(principalId),
            remove: () => { data.plugins = data.plugins.filter((plugin) => plugin.principalId !== principalId) },
        })
        await stopStarted
        expect(pluginDataLifecycle.isRetirementInProgress(principalId)).toBe(true)

        normalizePluginDatabaseState(data)
        expect(data.plugins[0].principalId).toBe(principalId)
        releaseStop()
        await retirement
        expect(data.plugins).toEqual([])
        expect(pluginDataLifecycle.isRetirementInProgress(principalId)).toBe(false)

        const coldOldSave = { plugins: [{ name: 'demo', script: 'code', principalId }] }
        normalizePluginDatabaseState(coldOldSave)
        expect(coldOldSave.plugins[0].principalId).not.toBe(principalId)
        expect(isCanonicalPluginPrincipalId(coldOldSave.plugins[0].principalId)).toBe(true)
        clearPrincipalTombstonesForTests()
    })
})
