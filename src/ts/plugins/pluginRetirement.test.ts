import { describe, expect, it } from 'vitest'
import { ContextAssetReadCoordinator } from './apiV3/illustration/contextAssetReadCoordinator'
import {
    ContextResourceService,
    type ContextHostState,
} from './apiV3/illustration/contextResources'
import { PluginDataLifecycleRegistry } from './pluginDataLifecycle'
import { retirePluginPrincipals } from './pluginRetirement'

const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
    return { promise, resolve }
}

describe('production principal retirement', () => {
    for (const source of ['manual update', 'programmatic replacement', 'live database replacement']) {
        it(`${source} stops plugin code only after permission/data purge and quarantine`, async () => {
            const registry = new PluginDataLifecycleRegistry()
            const events: string[] = []
            let permissionsPresent = true
            let secretsPresent = true
            let durableState = 'owned'
            registry.register('summary', 'summarize', () => { events.push('summarize') })
            registry.register('permissions', 'purge', () => { permissionsPresent = false; events.push('purge-permissions') })
            registry.register('secrets', 'purge', () => { secretsPresent = false; events.push('purge-secrets') })
            registry.register('durable', 'quarantine', () => { durableState = 'quarantined'; events.push('quarantine') })
            registry.registerInstanceStop('principal', 'instance', () => {
                expect(permissionsPresent).toBe(false)
                expect(secretsPresent).toBe(false)
                expect(durableState).toBe('quarantined')
                events.push('stop')
            })

            await retirePluginPrincipals(['principal'], () => { events.push('invalidate') }, registry)

            expect(events).toEqual(['summarize', 'purge-permissions', 'purge-secrets', 'quarantine', 'invalidate', 'stop'])
        })
    }

    it('retires context reads before lifecycle waits while retaining active physical permits', async () => {
        const principalId = 'retiring-context-principal'
        const coordinator = new ContextAssetReadCoordinator()
        const registry = new PluginDataLifecycleRegistry()
        const lifecycleGate = deferred<void>()
        const physicalGate = deferred<void>()
        let lifecycleEntered = false
        let physicalStarted = 0
        let physicalFinished = 0
        let queuedStarted = false
        registry.register('summary', 'summarize', async ({ principalId: retiringPrincipal }) => {
            if (retiringPrincipal !== principalId) return
            lifecycleEntered = true
            await lifecycleGate.promise
        })
        const owner = (instanceId: string) => ({ principalId, instanceId })
        const active = Array.from({ length: 4 }, (_, index) => coordinator.schedule({
            owner: owner(`active-${index}`),
            lane: 'thumbnail' as const,
            run: async () => {
                physicalStarted += 1
                try { await physicalGate.promise } finally { physicalFinished += 1 }
                return `active-${index}`
            },
        }).then((value) => value, (error) => error))
        await expect.poll(() => physicalStarted).toBe(4)
        const queued = coordinator.schedule({
            owner: owner('queued'),
            lane: 'digest',
            run: async () => { queuedStarted = true; return 'queued' },
        }).then((value) => value, (error) => error)
        const contextState: ContextHostState = {
            current: {
                characterId: 'character',
                conversation: {
                    id: 'conversation',
                    localLorebook: [],
                    selectedModuleIds: [],
                    messageMembership: [],
                },
            },
            characters: [{
                id: 'character',
                type: 'character',
                name: 'Character',
                textSections: [],
                lorebook: [],
                assets: [{
                    identity: 'portrait',
                    storageKey: 'portrait',
                    storageRevision: 'portrait:1',
                    name: 'portrait.png',
                    extension: 'png',
                    mediaType: 'image/png',
                    role: 'portrait',
                }],
            }],
            activeModules: [],
            installedModules: [],
        }
        let stateReads = 0
        let storageStarted = false
        const contextAbort = new AbortController()
        const service = new ContextResourceService(
            {
                principalId,
                instanceId: 'logical-service',
                displayName: 'Logical service',
                signal: contextAbort.signal,
            },
            {
                getState: async () => { stateReads += 1; return contextState },
                readAsset: async () => { storageStarted = true; return new Uint8Array([1, 2, 3]) },
                createThumbnail: async () => ({
                    data: new Uint8Array([1]),
                    mediaType: 'image/webp',
                    width: 1,
                    height: 1,
                    decodedPixels: 1,
                }),
            },
            {
                requirePermission: async () => undefined,
                readCoordinator: coordinator,
            },
        )
        const sharedOwner = service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
            .then((value) => value, (error) => error)
        await expect.poll(() => stateReads).toBeGreaterThanOrEqual(2)
        const sharedJoiner = service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
            .then((value) => value, (error) => error)
        await expect.poll(() => stateReads).toBeGreaterThanOrEqual(4)
        await new Promise((resolve) => setTimeout(resolve, 0))

        const retirement = retirePluginPrincipals(
            [principalId],
            () => undefined,
            registry,
            coordinator,
        )
        await expect.poll(() => lifecycleEntered).toBe(true)
        const promptResults = await Promise.race([
            Promise.all([...active, queued, sharedOwner, sharedJoiner])
                .then((values) => ({ status: 'settled' as const, values })),
            new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
        ])
        const replacement = coordinator.schedule({
            owner: owner('replacement-before-settle'),
            lane: 'thumbnail',
            run: async () => 'replacement-before-settle',
        }).then((value) => value, (error) => error)
        const replacementResult = await Promise.race([
            replacement,
            new Promise<'PENDING'>((resolve) => setTimeout(() => resolve('PENDING'), 50)),
        ])
        const otherPrincipal = await coordinator.schedule({
            owner: { principalId: 'unrelated-context-principal', instanceId: 'other' },
            lane: 'thumbnail',
            run: async () => 'other-principal',
        })

        lifecycleGate.resolve()
        await retirement
        const postLifecycle = coordinator.schedule({
            owner: owner('replacement-after-lifecycle'),
            lane: 'thumbnail',
            run: async () => 'replacement-after-lifecycle',
        }).then((value) => value, (error) => error)
        const postLifecycleResult = await Promise.race([
            postLifecycle,
            new Promise<'PENDING'>((resolve) => setTimeout(() => resolve('PENDING'), 50)),
        ])
        const finishedBeforePhysicalRelease = physicalFinished

        physicalGate.resolve()
        await Promise.all([...active, queued, sharedOwner, sharedJoiner, replacement, postLifecycle])
        const afterSettlement = await coordinator.schedule({
            owner: owner('replacement-after-settlement'),
            lane: 'thumbnail',
            run: async () => 'replacement-after-settlement',
        })

        expect(promptResults).toMatchObject({
            status: 'settled',
            values: Array.from({ length: 7 }, () => expect.objectContaining({ code: 'ABORTED' })),
        })
        expect(replacementResult).toMatchObject({ code: 'ABORTED' })
        expect(postLifecycleResult).toMatchObject({ code: 'ABORTED' })
        expect(otherPrincipal).toBe('other-principal')
        expect(finishedBeforePhysicalRelease).toBe(0)
        expect(queuedStarted).toBe(false)
        expect(storageStarted).toBe(false)
        expect(physicalFinished).toBe(4)
        expect(afterSettlement).toBe('replacement-after-settlement')
        service.dispose()
    })
})
