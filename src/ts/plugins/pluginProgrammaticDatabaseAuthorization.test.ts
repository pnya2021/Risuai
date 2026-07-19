import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PluginMutationCoordinator, PluginRuntimeReloadCoordinator, runAuthorizedPluginMutation } from './pluginMutationCoordinator'
import { PluginRuntimeReplacementTransaction, runAuthorizedPluginRuntimeMutation } from './pluginRuntimeReplacement'
import { createV2RuntimeAuthorization } from './pluginV2Runtime'

type AuthorizationScenario = {
    isActive: () => boolean
    isInstalledRecordCurrent: () => boolean
    invalidateInstance: () => void
}

const v2Scenario = (): AuthorizationScenario => {
    const runtime = { generation: 0 }
    const isInstalledRecordCurrent = () => true
    return {
        isActive: createV2RuntimeAuthorization(runtime, isInstalledRecordCurrent),
        isInstalledRecordCurrent,
        invalidateInstance: () => { runtime.generation += 1 },
    }
}

const v3Scenario = (): AuthorizationScenario => {
    const controller = new AbortController()
    const isInstalledRecordCurrent = () => true
    return {
        isActive: () => !controller.signal.aborted && isInstalledRecordCurrent(),
        isInstalledRecordCurrent,
        invalidateInstance: () => { controller.abort() },
    }
}

describe('programmatic database mutation authorization', () => {
    it.each([['V2', v2Scenario], ['V3', v3Scenario]] as const)(
        '%s commits and reloads once when its own suspension revokes only the instance gate',
        async (_name, createScenario) => {
            const scenario = createScenario()
            const coordinator = new PluginRuntimeReloadCoordinator<unknown>()
            const mutate = vi.fn(async (markLive: () => void) => { markLive() })
            const reload = vi.fn(async () => undefined)
            await runAuthorizedPluginRuntimeMutation({
                prepare: async () => {
                    const release = await coordinator.acquire()
                    return PluginRuntimeReplacementTransaction.prepare({
                        suspend: scenario.invalidateInstance,
                        resume: vi.fn(),
                        release,
                    }, scenario.isActive)
                },
                authorizeAfterSuspend: scenario.isInstalledRecordCurrent,
                mutate,
                reload,
                failClosed: vi.fn(),
            })
            expect(scenario.isActive()).toBe(false)
            expect(mutate).toHaveBeenCalledOnce()
            expect(reload).toHaveBeenCalledOnce()
        },
    )

    it('rechecks stable identity under the plugin mutation lock after a concurrent uninstall', async () => {
        const coordinator = new PluginMutationCoordinator()
        let installedRecordCurrent = true
        let releaseUninstall!: () => void
        let markUninstallStarted!: () => void
        const uninstallGate = new Promise<void>((resolve) => { releaseUninstall = resolve })
        const uninstallStarted = new Promise<void>((resolve) => { markUninstallStarted = resolve })
        expect(installedRecordCurrent).toBe(true) // outer post-suspend check
        const uninstall = coordinator.run(async () => {
            markUninstallStarted()
            await uninstallGate
            installedRecordCurrent = false
        })
        await uninstallStarted
        const applyDatabase = vi.fn()
        const staleApply = runAuthorizedPluginMutation(
            coordinator,
            () => installedRecordCurrent,
            applyDatabase,
        )
        releaseUninstall()

        await uninstall
        await expect(staleApply).rejects.toThrow('installed record is no longer current')
        expect(applyDatabase).not.toHaveBeenCalled()
    })

    it.each([['V2', v2Scenario], ['V3', v3Scenario]] as const)(
        '%s rejects an old queued call after a same-record instance replacement',
        async (_name, createScenario) => {
            const scenario = createScenario()
            const coordinator = new PluginRuntimeReloadCoordinator<unknown>()
            const blockingRelease = await coordinator.acquire()
            const suspend = vi.fn()
            const mutate = vi.fn()
            const queued = runAuthorizedPluginRuntimeMutation({
                prepare: async () => {
                    const release = await coordinator.acquire()
                    return PluginRuntimeReplacementTransaction.prepare({
                        suspend, resume: vi.fn(), release,
                    }, scenario.isActive)
                },
                authorizeAfterSuspend: scenario.isInstalledRecordCurrent,
                mutate,
                reload: vi.fn(),
                failClosed: vi.fn(),
            })
            await Promise.resolve()
            scenario.invalidateInstance()
            blockingRelease()

            await expect(queued).rejects.toThrow('installed record is no longer current')
            expect(suspend).not.toHaveBeenCalled()
            expect(mutate).not.toHaveBeenCalled()
            const nextRelease = await coordinator.acquire()
            nextRelease()
        },
    )

    it('wires the behavioral seam into both production V2 and V3 database APIs', () => {
        const plugins = readFileSync(join(process.cwd(), 'src/ts/plugins/plugins.svelte.ts'), 'utf8')
        const v3 = readFileSync(join(process.cwd(), 'src/ts/plugins/apiV3/v3.svelte.ts'), 'utf8')
        const database = readFileSync(join(process.cwd(), 'src/ts/storage/database.svelte.ts'), 'utf8')
        expect(plugins).toContain('runAuthorizedPluginRuntimeMutation({')
        expect(plugins).toContain('preparePluginRuntimeReplacement(options.authorizeBeforeSuspend)')
        expect(plugins).toContain('authorizeBeforeSuspend: isActive')
        expect(plugins).toContain('authorizeAfterSuspend: isInstalledRecordCurrent')
        expect(plugins).toContain('getV2PluginAPIs(isCurrent, isInstalledRecordCurrent)')
        expect(v3).toContain('getV2PluginAPIs(canRegisterResource, isExecutionCurrent)')
        expect(v3).toContain("applyProgrammaticDatabaseMutation(newDb, 'lite', canRegisterResource, isExecutionCurrent)")
        expect(plugins).toContain('setDatabaseLive(data, options.authorizeAfterSuspend, markLive)')
        expect(database).toContain('withAuthorizedPluginMutationLock(authorize')
    })
})
