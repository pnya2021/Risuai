import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    ContextResourceService,
    type CharacterCardSnapshot,
    type ContextAssetSource,
    type ContextHostState,
    type ContextResourceAdapter,
} from './contextResources'
import { ContextAssetReadCoordinator } from './contextAssetReadCoordinator'
import { ContextAssetAuthorityRegistry } from './contextAssetAuthorityRegistry'
import { CursorRegistry } from './cursorRegistry'
import {
    createStudioCardResourceRpcApi,
    createStudioCardResourceService,
    type StudioCardNativeCatalogue,
    type StudioCardNativeSource,
    type StudioCardResourceService,
} from './studioCardResources'
import { takeStudioCardRpcFinalizer } from '../studioCardRpcTransport'

const sha = (value: string) => `sha256:${value.padEnd(64, '0').slice(0, 64)}`

const card = (id: string, name = id, type: 'character' | 'group' = 'character'): CharacterCardSnapshot => ({
    id,
    revision: sha(`card-${id}`),
    type,
    name,
    textSections: [{ key: 'description', label: 'Description', content: `${name} description` }],
    lorebook: [],
    ...(type === 'group' ? { groupMemberIds: ['member-b', 'member-a', 'member-a'] } : {}),
})

const deferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('Timed out waiting for condition')
}

const nativeAsset = (ownerCardId: string, index: number) => ({
    logicalIdentity: `logical-${ownerCardId}-${index}`,
    revision: sha(`asset-${ownerCardId}-${index}`),
    name: `${index}.png`,
    mediaType: 'image/png',
    role: 'additional' as const,
    locator: {
        ownerCardId,
        ownerRevision: sha(`owner-${ownerCardId}`),
        storageRevision: sha(`storage-${ownerCardId}-${index}`),
        nativeSlot: index,
    },
})

const nativeSource = (cardId: string, assets = 1): StudioCardNativeSource => ({
    nativeRevision: sha(`source-${cardId}`),
    card: card(cardId),
    groupMembers: [],
    assets: Array.from({ length: assets }, (_, index) => nativeAsset(cardId, index)),
    authority: {},
})

const largeGroupSource = (cardId: string, memberCount: number, contentBytes: number): StudioCardNativeSource => {
    const memberIds = Array.from({ length: memberCount }, (_, index) => `${cardId}-member-${index}`)
    const root = card(cardId, cardId, 'group')
    root.groupMemberIds = memberIds
    return {
        nativeRevision: sha(`source-${cardId}`),
        card: root,
        groupMembers: memberIds.map((memberId) => {
            const member = card(memberId)
            member.textSections[0].content = 'x'.repeat(contentBytes)
            return member
        }),
        assets: [],
        authority: {},
    }
}

const liveServices: StudioCardResourceService[] = []
afterEach(() => {
    for (const service of liveServices.splice(0)) service.dispose()
    vi.restoreAllMocks()
})

function studioHarness(options: {
    principalId?: string
    instanceId?: string
    cardIds?: string[]
    registry?: ContextAssetAuthorityRegistry
    coordinator?: ContextAssetReadCoordinator
    cursorRegistry?: CursorRegistry
    now?: () => number
    sourceFor?: (cardId: string) => StudioCardNativeSource | null | Promise<StudioCardNativeSource | null>
} = {}) {
    const cardIds = options.cardIds ?? ['card-1']
    let permission = 'permission-1'
    let nativeGeneration = 'generation-1'
    let catalogueCurrent = true
    let sourceCurrent = true
    const abortController = new AbortController()
    const context = {
        principalId: options.principalId ?? crypto.randomUUID(),
        instanceId: options.instanceId ?? crypto.randomUUID(),
        displayName: 'Studio',
        signal: abortController.signal,
    }
    const catalogue: StudioCardNativeCatalogue = {
        nativeRevision: sha('catalogue'),
        hostActiveCardId: cardIds[0],
        records: cardIds.map((cardId) => ({
            cardId,
            catalogueItemRevision: sha(`item-${cardId}`),
            kind: 'character',
            name: cardId,
            groupMemberIds: [],
        })),
        authority: {},
    }
    const captureCatalogue = vi.fn(async () => structuredClone(catalogue))
    const captureSource = vi.fn(async (cardId: string) => {
        const value = options.sourceFor ? await options.sourceFor(cardId) : nativeSource(cardId)
        return value === null ? null : structuredClone(value)
    })
    const readAsset = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const registry = options.registry ?? new ContextAssetAuthorityRegistry()
    const coordinator = options.coordinator ?? new ContextAssetReadCoordinator()
    const service = createStudioCardResourceService({
        context,
        adapter: {
            captureCatalogue,
            revalidateCatalogue: () => catalogueCurrent,
            captureSource,
            revalidateSource: () => sourceCurrent,
            readAsset,
            captureGeneration: () => nativeGeneration,
            isGenerationCurrent: (value) => value === nativeGeneration,
        },
        assetAuthorityRegistry: registry,
        readCoordinator: coordinator,
        permissionGeneration: () => permission,
        requirePermission: async () => undefined,
        now: options.now,
        ...({ cursorRegistry: options.cursorRegistry } as any),
    })
    liveServices.push(service)
    return {
        service, registry, coordinator, context, catalogue, captureCatalogue, captureSource, readAsset,
        abortController,
        setPermission(value: string) { permission = value },
        setNativeGeneration(value: string) { nativeGeneration = value },
        setCatalogueCurrent(value: boolean) { catalogueCurrent = value },
        setSourceCurrent(value: boolean) { sourceCurrent = value },
    }
}

const selectCard = async (h: ReturnType<typeof studioHarness>, cardId = h.catalogue.records[0].cardId) => {
    const page = await h.service.listStudioCards({ limit: 24 })
    const summary = page.items.find((item) => item.cardId === cardId) ?? page.hostActiveCard!
    return h.service.captureStudioCardSource({
        cardId,
        expectedCatalogueItemRevision: summary.catalogueItemRevision,
        catalogueRevision: page.catalogueRevision,
    })
}

function currentContextReader(input: {
    context: ReturnType<typeof studioHarness>['context']
    registry: ContextAssetAuthorityRegistry
    coordinator: ContextAssetReadCoordinator
    thumbnail?: ContextResourceAdapter['createThumbnail']
}) {
    const source: ContextAssetSource = {
        identity: 'current-portrait',
        storageKey: 'current-portrait',
        storageRevision: sha('current-storage'),
        name: 'current.png',
        mediaType: 'image/png',
        role: 'portrait',
    }
    const state: ContextHostState = {
        current: {
            characterId: 'current-card',
            conversation: { id: 'conversation-1', localLorebook: [], selectedModuleIds: [], messageMembership: [] },
        },
        characters: [{
            id: 'current-card', type: 'character', name: 'Current',
            textSections: [], lorebook: [], assets: [source],
        }],
        activeModules: [],
        installedModules: [],
    }
    const readAsset = vi.fn(async () => new Uint8Array([9, 8, 7]))
    const service = new ContextResourceService(input.context, {
        getState: async () => state,
        readAsset,
        createThumbnail: input.thumbnail ?? (async (_source, data) => ({
            data, mediaType: 'image/png', width: 1, height: 1, decodedPixels: 1,
        })),
    }, {
        requirePermission: async () => undefined,
        assetAuthorityRegistry: input.registry,
        readCoordinator: input.coordinator,
    })
    return { service, readAsset }
}

const studioSubjectPath = './studioCardResources'
const registrySubjectPath = './contextAssetAuthorityRegistry'
const loadSubject = async () => import(/* @vite-ignore */ studioSubjectPath).catch(() => undefined)
const loadRegistry = async () => import(/* @vite-ignore */ registrySubjectPath).catch(() => undefined)

describe('Studio card resource core', () => {
    it('publishes stable filtered pages and separately retains the Host-active summary', async () => {
        const subject = await loadSubject()
        const captureCatalogue = vi.fn(async () => ({
            nativeRevision: 'native-1',
            hostActiveCardId: 'card-60',
            records: Array.from({ length: 60 }, (_, index) => ({
                cardId: `card-${String(index + 1).padStart(2, '0')}`,
                catalogueItemRevision: `item-${index + 1}`,
                kind: index === 2 ? 'group' as const : 'character' as const,
                name: index === 0 ? 'Zeta' : `Alpha ${String(index + 1).padStart(2, '0')}`,
                groupMemberIds: index === 2 ? ['member-a', 'member-b'] : [],
                ...(index === 59 ? {
                    portrait: {
                        revision: sha('portrait'), name: 'portrait.png', mediaType: 'image/png',
                        locator: {
                            ownerCardId: 'card-60', ownerRevision: 'owner-1',
                            storageRevision: 'storage-1', nativeSlot: 0,
                        },
                    },
                } : {}),
            })),
            authority: {},
        }))
        const adapter = {
            captureCatalogue,
            revalidateCatalogue: () => true,
            captureSource: vi.fn(),
            revalidateSource: () => true,
            readAsset: vi.fn(),
            captureGeneration: () => 'generation-1',
            isGenerationCurrent: () => true,
        }
        const registryModule = await loadRegistry()
        const context = {
            principalId: 'principal-a', instanceId: 'instance-a', displayName: 'Studio',
            signal: new AbortController().signal,
        }
        const service = subject && registryModule
            ? subject.createStudioCardResourceService({
                context,
                adapter,
                assetAuthorityRegistry: new registryModule.ContextAssetAuthorityRegistry(),
                readCoordinator: { schedule: ({ run }: any) => run(new AbortController().signal) } as any,
                permissionGeneration: () => 'permission-1',
                requirePermission: async () => undefined,
            })
            : undefined

        const first = await service?.listStudioCards({ limit: 24 })
        expect(first?.items).toHaveLength(24)
        expect(first?.items[0].name).toBe('Alpha 02')
        expect(first?.hostActiveCard).toMatchObject({ cardId: 'card-60', portrait: { name: 'portrait.png' } })
        const second = await service?.listStudioCards({
            limit: 24,
            cursor: first?.nextCursor,
            catalogueRevision: first?.catalogueRevision,
        })
        expect(second?.catalogueRevision).toBe(first?.catalogueRevision)
        expect(second?.total).toBe(60)
        const third = await service?.listStudioCards({
            limit: 24,
            cursor: second?.nextCursor,
            catalogueRevision: first?.catalogueRevision,
        })
        expect(third?.items).toHaveLength(12)
        await expect(service?.captureStudioCardSource({
            cardId: first!.items[0].cardId,
            expectedCatalogueItemRevision: first!.items[0].catalogueItemRevision,
            catalogueRevision: first!.catalogueRevision,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(adapter.captureSource).not.toHaveBeenCalled()
        expect(captureCatalogue).toHaveBeenCalledTimes(1)
    })

    it('promotes an admitted selection, deduplicates direct members, and pages descriptors without handles', async () => {
        const subject = await loadSubject()
        const registryModule = await loadRegistry()
        const root = card('group-1', 'Group', 'group')
        const nativeSource = {
            nativeRevision: 'source-1',
            card: root,
            groupMembers: [card('member-b'), card('member-a'), card('member-a')],
            assets: Array.from({ length: 125 }, (_, index) => ({
                logicalIdentity: `asset-${index}`,
                revision: sha(`asset-${index}`),
                name: `${index}.png`,
                mediaType: 'image/png',
                role: 'additional' as const,
                locator: {
                    ownerCardId: 'group-1', ownerRevision: 'owner-1',
                    storageRevision: `storage-${index}`, nativeSlot: index,
                },
            })),
            authority: {},
        }
        const adapter = {
            captureCatalogue: async () => ({
                nativeRevision: 'catalogue-1', records: [{
                    cardId: 'group-1', catalogueItemRevision: 'item-1', kind: 'group' as const,
                    name: 'Group', groupMemberIds: ['member-b', 'member-a', 'member-a'],
                }], authority: {},
            }),
            revalidateCatalogue: () => true,
            captureSource: vi.fn(async () => structuredClone(nativeSource)),
            revalidateSource: () => true,
            readAsset: vi.fn(async () => new Uint8Array([1, 2, 3])),
            captureGeneration: () => 'generation-1',
            isGenerationCurrent: () => true,
        }
        const context = {
            principalId: 'principal-b', instanceId: 'instance-b', displayName: 'Studio',
            signal: new AbortController().signal,
        }
        const registry = registryModule ? new registryModule.ContextAssetAuthorityRegistry() : undefined
        const service = subject && registry
            ? subject.createStudioCardResourceService({
                context, adapter, assetAuthorityRegistry: registry,
                readCoordinator: { schedule: ({ run }: any) => run(new AbortController().signal) } as any,
                permissionGeneration: () => 'permission-1', requirePermission: async () => undefined,
            })
            : undefined
        const listing = await service?.listStudioCards({ limit: 24 })
        const capture = await service?.captureStudioCardSource({
            cardId: 'group-1', expectedCatalogueItemRevision: 'item-1',
            catalogueRevision: listing?.catalogueRevision ?? '',
        })
        expect(capture?.groupMembers.map((member) => member.id)).toEqual(['member-a', 'member-b'])
        const first = await service?.listStudioCardAssets({ captureRevision: capture?.captureRevision ?? '', limit: 100 })
        const second = await service?.listStudioCardAssets({
            captureRevision: capture?.captureRevision ?? '', cursor: first?.nextCursor, limit: 100,
        })
        expect(first?.assets).toHaveLength(100)
        expect(second?.assets).toHaveLength(25)
        expect(registry?.size(context.principalId, context.instanceId)).toBe(0)
        const access = await service?.resolveStudioCardAssetHandles({
            captureRevision: capture?.captureRevision ?? '',
            logicalAssetIds: first?.assets.slice(0, 3).map((asset) => asset.logicalAssetId) ?? [],
            purpose: 'selected',
        })
        expect(access?.assets).toHaveLength(3)
        expect(registry?.size(context.principalId, context.instanceId)).toBe(3)
    })
})

describe('Studio card review schedules', () => {
    it('rejects Studio portrait admission without evicting a capacity-filling current handle', async () => {
        const registry = new ContextAssetAuthorityRegistry({ maxPerPrincipal: 1 })
        const coordinator = new ContextAssetReadCoordinator()
        const h = studioHarness({ registry, coordinator })
        const current = currentContextReader({ context: h.context, registry, coordinator })
        const currentPage = await current.service.listContextAssets({ moduleScope: 'none', limit: 1 })
        h.catalogue.records[0].portrait = {
            revision: sha('portrait'),
            name: 'portrait.png',
            mediaType: 'image/png',
            locator: {
                ownerCardId: 'card-1',
                ownerRevision: sha('portrait-owner'),
                storageRevision: sha('portrait-storage'),
                nativeSlot: 0,
            },
        }

        await expect(h.service.listStudioCards({ limit: 24 }))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(current.service.readContextAsset(currentPage.assets[0].assetId, {
            ifRevision: currentPage.assets[0].revision,
        })).resolves.toMatchObject({ revision: currentPage.assets[0].revision })
        expect(registry.size(h.context.principalId, h.context.instanceId)).toBe(1)
        current.service.dispose()
    })

    it('does not publish a capture when permission changes during deferred native capture', async () => {
        const h = studioHarness()
        const page = await h.service.listStudioCards({ limit: 24 })
        const gate = deferred<StudioCardNativeSource | null>()
        h.captureSource.mockImplementationOnce(() => gate.promise)
        const pending = h.service.captureStudioCardSource({
            cardId: 'card-1',
            expectedCatalogueItemRevision: page.items[0].catalogueItemRevision,
            catalogueRevision: page.catalogueRevision,
        })
        await waitFor(() => h.captureSource.mock.calls.length === 1)
        h.setPermission('permission-2')
        gate.resolve(nativeSource('card-1'))

        await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
        expect(h.registry.size(h.context.principalId, h.context.instanceId)).toBe(0)
    })

    it('never revives old target, capture, or handles after revoke and regrant', async () => {
        const h = studioHarness()
        const capture = await selectCard(h)
        const assets = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const access = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [assets.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        h.setPermission('permission-2')
        await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
            .rejects.toMatchObject({ code: expect.stringMatching(/ABORTED|CONFLICT|NOT_FOUND/) })
        h.setPermission('permission-3')
        await expect(h.service.captureStudioCardSource({
            targetRevision: capture.targetRevision,
            expectedSourceRevision: capture.sourceRevision,
        })).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|NOT_FOUND/) })
        expect(() => h.registry.lookup(access.assets[0].asset.assetId, h.context))
            .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    })

    it('rolls back when catalogue or target authority is released during source capture', async () => {
        const h = studioHarness()
        const page = await h.service.listStudioCards({ limit: 24 })
        const firstGate = deferred<StudioCardNativeSource | null>()
        h.captureSource.mockImplementationOnce(() => firstGate.promise)
        const firstPending = h.service.captureStudioCardSource({
            cardId: 'card-1',
            expectedCatalogueItemRevision: page.items[0].catalogueItemRevision,
            catalogueRevision: page.catalogueRevision,
        })
        await waitFor(() => h.captureSource.mock.calls.length === 1)
        await h.service.releaseStudioCardCatalogue(page.catalogueRevision)
        firstGate.resolve(nativeSource('card-1'))
        await expect(firstPending).rejects.toMatchObject({ code: expect.stringMatching(/ABORTED|CONFLICT|NOT_FOUND/) })

        const capture = await selectCard(h)
        const secondGate = deferred<StudioCardNativeSource | null>()
        h.captureSource.mockImplementationOnce(() => secondGate.promise)
        const secondPending = h.service.captureStudioCardSource({
            targetRevision: capture.targetRevision,
            expectedSourceRevision: capture.sourceRevision,
        })
        await waitFor(() => h.captureSource.mock.calls.length === 3)
        await h.service.releaseStudioCardTarget(capture.targetRevision)
        secondGate.resolve(nativeSource('card-1'))
        await expect(secondPending).rejects.toMatchObject({ code: expect.stringMatching(/ABORTED|CONFLICT|NOT_FOUND/) })
    })

    it('rejects page publication when its catalogue is released during an awaited page token', async () => {
        const h = studioHarness({ cardIds: Array.from({ length: 30 }, (_, index) => `card-${index}`) })
        const first = await h.service.listStudioCards({ limit: 24 })
        const digest = crypto.subtle.digest.bind(crypto.subtle)
        const gate = deferred<ArrayBuffer>()
        let captured: Parameters<SubtleCrypto['digest']> | undefined
        vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((...args) => {
            captured = args
            return gate.promise
        })
        const pending = h.service.listStudioCards({
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        })
        await waitFor(() => captured !== undefined)
        await h.service.releaseStudioCardCatalogue(first.catalogueRevision)
        gate.resolve(await digest(...captured!))

        await expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/ABORTED|CONFLICT|NOT_FOUND/) })
    })

    it('preserves a consumed cursor when later page hashing fails', async () => {
        const h = studioHarness({ cardIds: Array.from({ length: 30 }, (_, index) => `card-${index}`) })
        const first = await h.service.listStudioCards({ limit: 24 })
        const digest = crypto.subtle.digest.bind(crypto.subtle)
        let digestCalls = 0
        const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((...args) => {
            digestCalls += 1
            if (digestCalls === 2) return Promise.reject(new Error('injected page hash failure'))
            return digest(...args)
        })
        await expect(h.service.listStudioCards({
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        })).rejects.toBeDefined()
        spy.mockRestore()

        await expect(h.service.listStudioCards({
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        })).resolves.toMatchObject({ items: expect.any(Array) })
    })

    it('rejects access publication when capture is released during an awaited access token', async () => {
        const h = studioHarness()
        const capture = await selectCard(h)
        const assets = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const digest = crypto.subtle.digest.bind(crypto.subtle)
        const gate = deferred<ArrayBuffer>()
        let captured: Parameters<SubtleCrypto['digest']> | undefined
        vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((...args) => {
            captured = args
            return gate.promise
        })
        const pending = h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [assets.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        await waitFor(() => captured !== undefined)
        await h.service.releaseStudioCardSource(capture.captureRevision)
        gate.resolve(await digest(...captured!))

        await expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/ABORTED|CONFLICT|NOT_FOUND/) })
        expect(h.registry.size(h.context.principalId, h.context.instanceId)).toBe(0)
    })

    it('publishes no descendant when disposed during catalogue, source, or access awaits', async () => {
        const catalogueHarness = studioHarness()
        const catalogueGate = deferred<StudioCardNativeCatalogue>()
        catalogueHarness.captureCatalogue.mockImplementationOnce(() => catalogueGate.promise)
        const cataloguePending = catalogueHarness.service.listStudioCards({ limit: 24 })
        await waitFor(() => catalogueHarness.captureCatalogue.mock.calls.length === 1)
        catalogueHarness.service.dispose()
        catalogueGate.resolve(structuredClone(catalogueHarness.catalogue))
        await expect(cataloguePending).rejects.toMatchObject({ code: 'ABORTED' })
        expect(catalogueHarness.registry.size(catalogueHarness.context.principalId)).toBe(0)

        const sourceHarness = studioHarness()
        const sourcePage = await sourceHarness.service.listStudioCards({ limit: 24 })
        const sourceGate = deferred<StudioCardNativeSource | null>()
        sourceHarness.captureSource.mockImplementationOnce(() => sourceGate.promise)
        const sourcePending = sourceHarness.service.captureStudioCardSource({
            cardId: sourcePage.items[0].cardId,
            expectedCatalogueItemRevision: sourcePage.items[0].catalogueItemRevision,
            catalogueRevision: sourcePage.catalogueRevision,
        })
        await waitFor(() => sourceHarness.captureSource.mock.calls.length === 1)
        sourceHarness.service.dispose()
        sourceGate.resolve(nativeSource('card-1'))
        await expect(sourcePending).rejects.toMatchObject({ code: 'ABORTED' })
        expect(sourceHarness.registry.size(sourceHarness.context.principalId)).toBe(0)

        const accessHarness = studioHarness()
        const capture = await selectCard(accessHarness)
        const descriptors = await accessHarness.service.listStudioCardAssets({
            captureRevision: capture.captureRevision,
        })
        const digest = crypto.subtle.digest.bind(crypto.subtle)
        const digestGate = deferred<ArrayBuffer>()
        let capturedDigest: Parameters<SubtleCrypto['digest']> | undefined
        vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((...args) => {
            capturedDigest = args
            return digestGate.promise
        })
        const accessPending = accessHarness.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        await waitFor(() => capturedDigest !== undefined)
        accessHarness.service.dispose()
        digestGate.resolve(await digest(...capturedDigest!))
        await expect(accessPending).rejects.toMatchObject({ code: 'ABORTED' })
        expect(accessHarness.registry.size(accessHarness.context.principalId)).toBe(0)
    })

    it('keeps four live captures pinned and rejects a fifth before materializing accessor data', async () => {
        const h = studioHarness({ cardIds: ['card-1', 'card-2', 'card-3', 'card-4', 'card-5'] })
        const page = await h.service.listStudioCards({ limit: 24 })
        const captures = []
        for (const summary of page.items.slice(0, 4)) {
            captures.push(await h.service.captureStudioCardSource({
                cardId: summary.cardId,
                expectedCatalogueItemRevision: summary.catalogueItemRevision,
                catalogueRevision: page.catalogueRevision,
            }))
        }
        let getterCalled = false
        const malformedAsset = nativeAsset('card-5', 0) as Record<string, unknown>
        Object.defineProperty(malformedAsset, 'logicalIdentity', {
            enumerable: true,
            get: () => {
                getterCalled = true
                throw new TypeError('materialized too early')
            },
        })
        h.captureSource.mockImplementationOnce(async () => ({
            ...nativeSource('card-5', 0),
            assets: [malformedAsset],
        } as unknown as StudioCardNativeSource))
        const fifth = page.items[4]
        await expect(h.service.captureStudioCardSource({
            cardId: fifth.cardId,
            expectedCatalogueItemRevision: fifth.catalogueItemRevision,
            catalogueRevision: page.catalogueRevision,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(getterCalled).toBe(false)
        for (const capture of captures) {
            await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
                .resolves.toMatchObject({ captureRevision: capture.captureRevision })
        }
    })

    it('rolls back a reserved catalogue LRU victim when final portrait admission fails', async () => {
        const registry = new ContextAssetAuthorityRegistry({ maxPerPrincipal: 0 })
        const h = studioHarness({ registry })
        const retained: string[] = []
        for (let index = 0; index < 4; index++) {
            retained.push((await h.service.listStudioCards({ limit: 24 })).catalogueRevision)
        }
        h.catalogue.records[0].portrait = {
            revision: sha('pressure-portrait'),
            name: 'pressure.png',
            mediaType: 'image/png',
            locator: {
                ownerCardId: 'card-1',
                ownerRevision: sha('pressure-owner'),
                storageRevision: sha('pressure-storage'),
                nativeSlot: 0,
            },
        }
        await expect(h.service.listStudioCards({ limit: 24 }))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        for (const catalogueRevision of retained) {
            await expect(h.service.releaseStudioCardCatalogue(catalogueRevision)).resolves.toBeUndefined()
        }
    })

    it('rolls back a provisional target reservation when native capture fails', async () => {
        const h = studioHarness({ cardIds: ['card-1', 'card-2', 'card-3', 'card-4', 'card-5'] })
        const page = await h.service.listStudioCards({ limit: 24 })
        const retained: Array<{ targetRevision: string; sourceRevision: string }> = []
        for (const summary of page.items.slice(0, 4)) {
            const capture = await h.service.captureStudioCardSource({
                cardId: summary.cardId,
                expectedCatalogueItemRevision: summary.catalogueItemRevision,
                catalogueRevision: page.catalogueRevision,
            })
            retained.push(capture)
            await h.service.releaseStudioCardSource(capture.captureRevision)
        }
        h.captureSource.mockImplementationOnce(async () => null)
        const fifth = page.items[4]
        await expect(h.service.captureStudioCardSource({
            cardId: fifth.cardId,
            expectedCatalogueItemRevision: fifth.catalogueItemRevision,
            catalogueRevision: page.catalogueRevision,
        })).rejects.toMatchObject({ code: 'NOT_FOUND' })

        for (const target of retained) {
            await expect(h.service.captureStudioCardSource({
                targetRevision: target.targetRevision,
                expectedSourceRevision: target.sourceRevision,
            })).resolves.toMatchObject({ targetRevision: target.targetRevision })
        }
    })

    it('reserves the principal-wide 16 MiB capture budget without evicting a live capture', async () => {
        const principalId = crypto.randomUUID()
        const first = studioHarness({
            principalId,
            instanceId: 'large-instance-a',
            cardIds: ['large-a'],
            sourceFor: () => largeGroupSource('large-a', 100, 90_000),
        })
        first.catalogue.records[0].kind = 'group'
        first.catalogue.records[0].groupMemberIds = Array.from(
            { length: 100 }, (_, index) => `large-a-member-${index}`,
        )
        const retained = await selectCard(first)

        const second = studioHarness({
            principalId,
            instanceId: 'large-instance-b',
            cardIds: ['large-b'],
            sourceFor: () => largeGroupSource('large-b', 100, 90_000),
        })
        second.catalogue.records[0].kind = 'group'
        second.catalogue.records[0].groupMemberIds = Array.from(
            { length: 100 }, (_, index) => `large-b-member-${index}`,
        )
        const secondPage = await second.service.listStudioCards({ limit: 24 })
        await expect(second.service.captureStudioCardSource({
            cardId: secondPage.items[0].cardId,
            expectedCatalogueItemRevision: secondPage.items[0].catalogueItemRevision,
            catalogueRevision: secondPage.catalogueRevision,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(first.service.listStudioCardAssets({ captureRevision: retained.captureRevision }))
            .resolves.toMatchObject({ captureRevision: retained.captureRevision })
    }, 60_000)

    it('reserves the principal-wide 20,000-item capture budget and rolls back rejected admission', async () => {
        const principalId = crypto.randomUUID()
        const first = studioHarness({
            principalId,
            instanceId: 'items-instance-a',
            cardIds: ['items-a'],
            sourceFor: () => nativeSource('items-a', 9_999),
        })
        const firstCapture = await selectCard(first)
        const second = studioHarness({
            principalId,
            instanceId: 'items-instance-b',
            cardIds: ['items-b'],
            sourceFor: () => nativeSource('items-b', 9_999),
        })
        const secondCapture = await selectCard(second)
        const third = studioHarness({
            principalId,
            instanceId: 'items-instance-c',
            cardIds: ['items-c'],
            sourceFor: () => nativeSource('items-c', 1),
        })
        const thirdPage = await third.service.listStudioCards({ limit: 24 })
        await expect(third.service.captureStudioCardSource({
            cardId: thirdPage.items[0].cardId,
            expectedCatalogueItemRevision: thirdPage.items[0].catalogueItemRevision,
            catalogueRevision: thirdPage.catalogueRevision,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(first.service.listStudioCardAssets({ captureRevision: firstCapture.captureRevision }))
            .resolves.toBeDefined()
        await expect(second.service.listStudioCardAssets({ captureRevision: secondCapture.captureRevision }))
            .resolves.toBeDefined()
    }, 60_000)

    it('accepts every catalogue page limit from 1 through 100 and rejects only values outside that range', async () => {
        const h = studioHarness({
            cardIds: Array.from({ length: 100 }, (_, index) => `card-${index.toString().padStart(3, '0')}`),
        })
        for (const limit of [1, 25, 100]) {
            await expect(h.service.listStudioCards({ limit })).resolves.toMatchObject({
                items: expect.any(Array),
            })
            const page = await h.service.listStudioCards({ limit })
            expect(page.items).toHaveLength(limit)
        }
        for (const limit of [0, 101]) {
            await expect(h.service.listStudioCards({ limit }))
                .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        }
    })

    it('rejects exact-shape, accessor, dense-array, and mixed-union public inputs before Host work', async () => {
        const h = studioHarness()
        const inherited = Object.create({ limit: 24 })
        const accessor = Object.defineProperty({}, 'search', {
            enumerable: true,
            get: () => { throw new TypeError('getter must not run') },
        })
        const cases: unknown[] = [
            inherited,
            accessor,
            { limit: 24, extra: true },
            { limit: 101 },
            { search: 7 },
            { search: '\uFDFA'.repeat(80) },
            null,
        ]
        for (const value of cases) {
            await expect(h.service.listStudioCards(value as never))
                .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        }
        expect(h.captureCatalogue).not.toHaveBeenCalled()

        const page = await h.service.listStudioCards({ limit: 24 })
        const captureCalls = h.captureSource.mock.calls.length
        const invalidCaptureInputs: unknown[] = [
            null,
            Object.create({
                cardId: 'card-1',
                expectedCatalogueItemRevision: page.items[0].catalogueItemRevision,
                catalogueRevision: page.catalogueRevision,
            }),
            {
                cardId: 'card-1',
                expectedCatalogueItemRevision: page.items[0].catalogueItemRevision,
                catalogueRevision: page.catalogueRevision,
                extra: true,
            },
            {
                cardId: 'card-1',
                expectedCatalogueItemRevision: page.items[0].catalogueItemRevision,
                catalogueRevision: page.catalogueRevision,
                targetRevision: 'mixed-branch',
            },
            { targetRevision: 'target', acceptCurrentSourceRevision: false },
            Object.defineProperty({ targetRevision: 'target' }, 'expectedSourceRevision', {
                enumerable: true,
                get: () => { throw new TypeError('capture getter must not run') },
            }),
        ]
        for (const value of invalidCaptureInputs) {
            await expect(h.service.captureStudioCardSource(value as never))
                .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        }
        expect(h.captureSource).toHaveBeenCalledTimes(captureCalls)

        const capture = await h.service.captureStudioCardSource({
            cardId: page.items[0].cardId,
            expectedCatalogueItemRevision: page.items[0].catalogueItemRevision,
            catalogueRevision: page.catalogueRevision,
        })
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const sparseMediaTypes = new Array(1) as string[]
        const sparseIds = new Array(1) as string[]
        const invalidAssetLists: unknown[] = [
            null,
            { captureRevision: capture.captureRevision, extra: true },
            { captureRevision: capture.captureRevision, mediaTypes: sparseMediaTypes },
            Object.defineProperty({}, 'captureRevision', {
                enumerable: true,
                get: () => { throw new TypeError('asset-list getter must not run') },
            }),
        ]
        for (const value of invalidAssetLists) {
            await expect(h.service.listStudioCardAssets(value as never))
                .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        }
        const invalidAccesses: unknown[] = [
            null,
            {
                captureRevision: capture.captureRevision,
                logicalAssetIds: [descriptors.assets[0].logicalAssetId],
                purpose: 'selected',
                extra: true,
            },
            { captureRevision: capture.captureRevision, logicalAssetIds: sparseIds, purpose: 'selected' },
            {
                captureRevision: capture.captureRevision,
                logicalAssetIds: [descriptors.assets[0].logicalAssetId],
                purpose: 'invalid',
            },
        ]
        for (const value of invalidAccesses) {
            await expect(h.service.resolveStudioCardAssetHandles(value as never))
                .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        }
        for (const release of [
            h.service.releaseStudioCardCatalogue.bind(h.service),
            h.service.releaseStudioCardTarget.bind(h.service),
            h.service.releaseStudioCardSource.bind(h.service),
            h.service.releaseStudioCardAssetAccess.bind(h.service),
        ]) {
            await expect(release({ token: 'inherited-or-object' } as never))
                .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        }
    })

    it('rejects malformed native own-data shapes without invoking accessors or leaking TypeError', async () => {
        const h = studioHarness()
        let getterCalled = false
        const malformed = structuredClone(h.catalogue)
        Object.defineProperty(malformed.records[0], 'name', {
            enumerable: true,
            get: () => {
                getterCalled = true
                throw new TypeError('native getter')
            },
        })
        h.captureCatalogue.mockImplementationOnce(async () => malformed)
        await expect(h.service.listStudioCards({ limit: 24 }))
            .rejects.toMatchObject({ name: 'PluginApiError', code: expect.stringMatching(/CONFLICT|INVALID_ARGUMENT/) })
        expect(getterCalled).toBe(false)

        const cleanPage = await h.service.listStudioCards({ limit: 24 })
        const badSource = nativeSource('card-1') as StudioCardNativeSource & { extra?: boolean }
        badSource.extra = true
        badSource.assets[0].role = 'invalid-role' as never
        h.captureSource.mockImplementationOnce(async () => badSource)
        await expect(h.service.captureStudioCardSource({
            cardId: 'card-1',
            expectedCatalogueItemRevision: cleanPage.items[0].catalogueItemRevision,
            catalogueRevision: cleanPage.catalogueRevision,
        })).rejects.toMatchObject({ name: 'PluginApiError', code: expect.stringMatching(/CONFLICT|INVALID_ARGUMENT/) })

        const invalidRole = nativeSource('card-1')
        invalidRole.assets[0].role = 'invalid-role' as never
        h.captureSource.mockImplementationOnce(async () => invalidRole)
        await expect(h.service.captureStudioCardSource({
            cardId: 'card-1',
            expectedCatalogueItemRevision: cleanPage.items[0].catalogueItemRevision,
            catalogueRevision: cleanPage.catalogueRevision,
        })).rejects.toMatchObject({ name: 'PluginApiError', code: 'CONFLICT' })

        const accessorSource = nativeSource('card-1')
        let sourceGetterCalled = false
        Object.defineProperty(accessorSource.assets[0], 'role', {
            enumerable: true,
            get: () => {
                sourceGetterCalled = true
                throw new TypeError('source getter')
            },
        })
        h.captureSource.mockImplementationOnce(async () => accessorSource)
        await expect(h.service.captureStudioCardSource({
            cardId: 'card-1',
            expectedCatalogueItemRevision: cleanPage.items[0].catalogueItemRevision,
            catalogueRevision: cleanPage.catalogueRevision,
        })).rejects.toMatchObject({ name: 'PluginApiError', code: 'CONFLICT' })
        expect(sourceGetterCalled).toBe(false)
    })

    it('uses deterministic NFKC code-point ordering instead of locale collation', async () => {
        const h = studioHarness({ cardIds: ['combining', 'precomposed', 'private', 'emoji'] })
        const byId = new Map(h.catalogue.records.map((record) => [record.cardId, record]))
        byId.get('combining')!.name = 'A\u030A'
        byId.get('precomposed')!.name = '\u00C5'
        byId.get('private')!.name = '\uE000'
        byId.get('emoji')!.name = '😀'
        const page = await h.service.listStudioCards({ limit: 24 })
        expect(page.items.map((item) => item.cardId)).toEqual([
            'combining', 'precomposed', 'private', 'emoji',
        ])
    })

    it('does not extend capture TTL for rejected descendant work', async () => {
        let now = 0
        const h = studioHarness({ now: () => now })
        const capture = await selectCard(h)
        now = 299_000
        await expect(h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: ['studioasset_unknown'],
            purpose: 'selected',
        })).rejects.toMatchObject({ code: 'NOT_FOUND' })
        now = 300_001
        await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('rejects expired portrait and selected handles without native reads or TTL revival', async () => {
        let now = 0
        const h = studioHarness({ now: () => now })
        h.catalogue.records[0].portrait = {
            revision: sha('expiring-portrait'),
            name: 'portrait.png',
            mediaType: 'image/png',
            locator: {
                ownerCardId: 'card-1',
                ownerRevision: sha('expiring-portrait-owner'),
                storageRevision: sha('expiring-portrait-storage'),
                nativeSlot: 0,
            },
        }
        const catalogue = await h.service.listStudioCards({ limit: 24 })
        const capture = await h.service.captureStudioCardSource({
            cardId: catalogue.items[0].cardId,
            expectedCatalogueItemRevision: catalogue.items[0].catalogueItemRevision,
            catalogueRevision: catalogue.catalogueRevision,
        })
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const access = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        const reader = currentContextReader({
            context: h.context,
            registry: h.registry,
            coordinator: h.coordinator,
        })
        now = 300_001

        await expect(reader.service.readContextAsset(catalogue.items[0].portrait!.assetId))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(reader.service.readContextAsset(access.assets[0].asset.assetId))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(h.readAsset).not.toHaveBeenCalled()
        reader.service.dispose()
    })

    it('rejects malformed thumbnail metadata from a Studio handle read', async () => {
        const h = studioHarness()
        const capture = await selectCard(h)
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const access = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        const reader = currentContextReader({
            context: h.context,
            registry: h.registry,
            coordinator: h.coordinator,
            thumbnail: async () => ({
                data: new Uint8Array([1]),
                mediaType: 'image/png',
                width: Number.NaN,
                height: -1,
                decodedPixels: 0,
            }),
        })

        await expect(reader.service.readContextAsset(access.assets[0].asset.assetId, {
            variant: 'thumbnail',
        })).rejects.toMatchObject({ code: 'DECODE_FAILED' })
        reader.service.dispose()
    })

    it('enumerates 4,902 descriptors without authority and bounds candidate plus selected handles', async () => {
        const h = studioHarness({ sourceFor: (cardId) => nativeSource(cardId, 4_902) })
        const capture = await selectCard(h)
        const descriptors = []
        let cursor: string | undefined
        do {
            const page = await h.service.listStudioCardAssets({
                captureRevision: capture.captureRevision,
                limit: 100,
                ...(cursor ? { cursor } : {}),
            })
            descriptors.push(...page.assets)
            cursor = page.nextCursor
        } while (cursor)
        expect(descriptors).toHaveLength(4_902)
        expect(h.registry.size(h.context.principalId, h.context.instanceId)).toBe(0)

        const first = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: descriptors.slice(111, 135).map((asset) => asset.logicalAssetId),
            purpose: 'candidate-page',
        })
        await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: descriptors.slice(2_111, 2_135).map((asset) => asset.logicalAssetId),
            purpose: 'candidate-page',
        })
        const third = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: descriptors.slice(4_111, 4_135).map((asset) => asset.logicalAssetId),
            purpose: 'candidate-page',
        })
        const selected = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: descriptors.slice(4_899).map((asset) => asset.logicalAssetId),
            purpose: 'selected',
        })
        expect(h.registry.size(h.context.principalId, h.context.instanceId)).toBeLessThanOrEqual(51)
        expect(() => h.registry.lookup(first.assets[0].asset.assetId, h.context))
            .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
        expect(h.registry.lookup(third.assets[0].asset.assetId, h.context)).toBeDefined()
        expect(h.registry.lookup(selected.assets[0].asset.assetId, h.context)).toBeDefined()
        expect(h.readAsset).not.toHaveBeenCalled()
    }, 60_000)

    it('shares four physical read slots and blocks released queued and inflight Studio reads', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const registry = new ContextAssetAuthorityRegistry()
        const h = studioHarness({
            coordinator,
            registry,
            sourceFor: (cardId) => nativeSource(cardId, 3),
        })
        const capture = await selectCard(h)
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const access = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: descriptors.assets.map((asset) => asset.logicalAssetId),
            purpose: 'candidate-page',
        })
        const current = currentContextReader({ context: h.context, registry, coordinator })
        const currentPage = await current.service.listContextAssets({ moduleScope: 'none', limit: 1 })
        current.readAsset.mockClear()
        h.readAsset.mockClear()

        const currentGates = Array.from({ length: 2 }, () => deferred<Uint8Array<ArrayBuffer>>())
        const studioGates = Array.from({ length: 2 }, () => deferred<Uint8Array<ArrayBuffer>>())
        let currentGateIndex = 0
        let studioGateIndex = 0
        current.readAsset.mockImplementation(async () => currentGates[currentGateIndex++].promise)
        h.readAsset.mockImplementation(async () => studioGates[studioGateIndex++].promise)
        const reads = [
            current.service.readContextAsset(currentPage.assets[0].assetId, { variant: 'thumbnail' }),
            current.service.readContextAsset(access.assets[0].asset.assetId, { variant: 'thumbnail' }),
            current.service.readContextAsset(currentPage.assets[0].assetId, { variant: 'thumbnail' }),
            current.service.readContextAsset(access.assets[1].asset.assetId, { variant: 'thumbnail' }),
        ]
        await waitFor(() => current.readAsset.mock.calls.length + h.readAsset.mock.calls.length === 4)
        const queued = current.service.readContextAsset(access.assets[2].asset.assetId, { variant: 'thumbnail' })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(current.readAsset.mock.calls.length + h.readAsset.mock.calls.length).toBe(4)
        await h.service.releaseStudioCardAssetAccess(access.accessRevision)
        for (const gate of currentGates) gate.resolve(new Uint8Array([9, 8, 7]))
        for (const gate of studioGates) gate.resolve(new Uint8Array([1]))

        const outcomes = await Promise.allSettled([...reads, queued])
        expect(outcomes[0]).toMatchObject({ status: 'fulfilled' })
        expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'NOT_FOUND' } })
        expect(outcomes[2]).toMatchObject({ status: 'fulfilled' })
        expect(outcomes[3]).toMatchObject({ status: 'rejected', reason: { code: 'NOT_FOUND' } })
        expect(outcomes[4]).toMatchObject({ status: 'rejected', reason: { code: 'NOT_FOUND' } })
        expect(current.readAsset.mock.calls.length + h.readAsset.mock.calls.length).toBe(4)
        current.service.dispose()
    })

    it('shares a bounded principal-wide cursor budget across Studio instances', async () => {
        const principalId = crypto.randomUUID()
        const cursorRegistry = new CursorRegistry({ maxPerPrincipal: 4 })
        const first = studioHarness({
            principalId,
            instanceId: 'cursor-instance-a',
            cursorRegistry,
            sourceFor: (cardId) => nativeSource(cardId, 101),
        })
        const second = studioHarness({
            principalId,
            instanceId: 'cursor-instance-b',
            cursorRegistry,
            sourceFor: (cardId) => nativeSource(cardId, 101),
        })
        const firstCapture = await selectCard(first)
        const secondCapture = await selectCard(second)
        for (let index = 0; index < 2; index++) {
            await expect(first.service.listStudioCardAssets({
                captureRevision: firstCapture.captureRevision,
                limit: 1,
            })).resolves.toHaveProperty('nextCursor')
            await expect(second.service.listStudioCardAssets({
                captureRevision: secondCapture.captureRevision,
                limit: 1,
            })).resolves.toHaveProperty('nextCursor')
        }

        await expect(first.service.listStudioCardAssets({
            captureRevision: firstCapture.captureRevision,
            limit: 1,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(cursorRegistry.activeCount(principalId)).toBe(4)
    })

    it('keeps explicit replacement distinct while old authority remains readable until explicit release', async () => {
        const h = studioHarness()
        const oldCapture = await selectCard(h)
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: oldCapture.captureRevision })
        const oldAccess = await h.service.resolveStudioCardAssetHandles({
            captureRevision: oldCapture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        const replacement = await h.service.captureStudioCardSource({
            targetRevision: oldCapture.targetRevision,
            acceptCurrentSourceRevision: true,
        })
        expect(replacement.targetRevision).not.toBe(oldCapture.targetRevision)
        expect(replacement.captureRevision).not.toBe(oldCapture.captureRevision)
        expect(replacement.sourceRevision).toBe(oldCapture.sourceRevision)
        expect(h.registry.lookup(oldAccess.assets[0].asset.assetId, h.context)).toBeDefined()

        await h.service.releaseStudioCardTarget(oldCapture.targetRevision)
        expect(() => h.registry.lookup(oldAccess.assets[0].asset.assetId, h.context))
            .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
        await expect(h.service.listStudioCardAssets({ captureRevision: replacement.captureRevision }))
            .resolves.toMatchObject({ captureRevision: replacement.captureRevision })
    })

    it('rolls back exact opaque catalogue, target/capture, recapture, and access identities', async () => {
        const h = studioHarness({
            cardIds: Array.from({ length: 50 }, (_, index) => `card-${index.toString().padStart(2, '0')}`),
        })
        h.catalogue.hostActiveCardId = undefined
        for (const [index, record] of h.catalogue.records.entries()) {
            record.portrait = {
                revision: sha(`portrait-${record.cardId}`),
                name: `${record.cardId}.png`,
                mediaType: 'image/png',
                locator: {
                    ownerCardId: record.cardId,
                    ownerRevision: sha(`portrait-owner-${record.cardId}`),
                    storageRevision: sha(`portrait-storage-${record.cardId}`),
                    nativeSlot: index,
                },
            }
        }
        const rpc = createStudioCardResourceRpcApi(h.service)
        const settle = (value: object, action: 'commit' | 'rollback') => {
            const finalizer = takeStudioCardRpcFinalizer(value)
            expect(finalizer).toBeDefined()
            finalizer![action]()
        }

        const firstPage = await rpc.listStudioCards({ limit: 24 })
        settle(firstPage, 'commit')
        const retainedCursor = firstPage.nextCursor!
        const secondPage = await rpc.listStudioCards({
            limit: 24,
            cursor: firstPage.nextCursor,
            catalogueRevision: firstPage.catalogueRevision,
        })
        const lostPagePortrait = secondPage.items[0].portrait!.assetId
        expect(secondPage.nextCursor).toBeDefined()
        secondPage.catalogueRevision = 'tampered-pre-existing-catalogue'
        secondPage.nextCursor = 'tampered-pre-existing-cursor'
        settle(secondPage, 'rollback')
        expect(h.registry.lookup(firstPage.items[0].portrait!.assetId, h.context)).toBeDefined()
        expect(() => h.registry.lookup(lostPagePortrait, h.context))
            .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
        const retriedPage = await h.service.listStudioCards({
            limit: 24,
            cursor: retainedCursor,
            catalogueRevision: firstPage.catalogueRevision,
        })
        expect(retriedPage.items[0].cardId).toBe('card-24')

        const adopted = await h.service.captureStudioCardSource({
            cardId: firstPage.items[0].cardId,
            expectedCatalogueItemRevision: firstPage.items[0].catalogueItemRevision,
            catalogueRevision: firstPage.catalogueRevision,
        })
        const replacement = await rpc.captureStudioCardSource({
            targetRevision: adopted.targetRevision,
            acceptCurrentSourceRevision: true,
        })
        const replacementTargetRevision = replacement.targetRevision
        const replacementCaptureRevision = replacement.captureRevision
        replacement.targetRevision = adopted.targetRevision
        replacement.captureRevision = adopted.captureRevision
        settle(replacement, 'rollback')
        await expect(h.service.listStudioCardAssets({ captureRevision: adopted.captureRevision }))
            .resolves.toBeDefined()
        await expect(h.service.listStudioCardAssets({ captureRevision: replacementCaptureRevision }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(h.service.captureStudioCardSource({
            targetRevision: replacementTargetRevision,
            expectedSourceRevision: adopted.sourceRevision,
        })).rejects.toMatchObject({ code: 'NOT_FOUND' })

        const descriptors = await h.service.listStudioCardAssets({ captureRevision: adopted.captureRevision })
        const retainedAccess = await h.service.resolveStudioCardAssetHandles({
            captureRevision: adopted.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        const recapture = await rpc.captureStudioCardSource({
            targetRevision: adopted.targetRevision,
            expectedSourceRevision: adopted.sourceRevision,
        })
        const recaptureRevision = recapture.captureRevision
        recapture.targetRevision = replacementTargetRevision
        recapture.captureRevision = adopted.captureRevision
        settle(recapture, 'rollback')
        await expect(h.service.listStudioCardAssets({ captureRevision: adopted.captureRevision }))
            .resolves.toBeDefined()
        await expect(h.service.listStudioCardAssets({ captureRevision: recaptureRevision }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(h.registry.lookup(retainedAccess.assets[0].asset.assetId, h.context)).toBeDefined()

        const lostAccess = await rpc.resolveStudioCardAssetHandles({
            captureRevision: adopted.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        const lostAccessRevision = lostAccess.accessRevision
        const lostAssetId = lostAccess.assets[0].asset.assetId
        lostAccess.accessRevision = retainedAccess.accessRevision
        lostAccess.assets[0].asset.assetId = retainedAccess.assets[0].asset.assetId
        settle(lostAccess, 'rollback')
        expect(h.registry.lookup(retainedAccess.assets[0].asset.assetId, h.context)).toBeDefined()
        expect(() => h.registry.lookup(lostAssetId, h.context))
            .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
        await expect(h.service.releaseStudioCardAssetAccess(lostAccessRevision))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })

        const separate = studioHarness({ cardIds: Array.from({ length: 25 }, (_, index) => `lost-${index}`) })
        separate.catalogue.hostActiveCardId = undefined
        separate.catalogue.records.forEach((record, index) => {
            record.portrait = {
                revision: sha(`lost-portrait-${index}`), name: `${index}.png`, mediaType: 'image/png',
                locator: {
                    ownerCardId: record.cardId,
                    ownerRevision: sha(`lost-owner-${index}`),
                    storageRevision: sha(`lost-storage-${index}`),
                    nativeSlot: index,
                },
            }
        })
        const separateRpc = createStudioCardResourceRpcApi(separate.service)
        const lostCatalogue = await separateRpc.listStudioCards({ limit: 24 })
        const lostCatalogueRevision = lostCatalogue.catalogueRevision
        expect(lostCatalogue.nextCursor).toBeDefined()
        expect(separate.registry.size()).toBe(24)
        lostCatalogue.catalogueRevision = firstPage.catalogueRevision
        settle(lostCatalogue, 'rollback')
        expect(separate.registry.size()).toBe(0)
        await expect(separate.service.releaseStudioCardCatalogue(lostCatalogueRevision))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('defers four-target LRU retirement until transport commit and preserves the victim on rollback', async () => {
        let now = 0
        const h = studioHarness({
            cardIds: Array.from({ length: 5 }, (_, index) => `target-${index}`),
            now: () => now,
        })
        const page = await h.service.listStudioCards({ limit: 24 })
        const retained: Array<{ targetRevision: string; sourceRevision: string }> = []
        for (let index = 0; index < 4; index++) {
            now = index * 10
            const captured = await h.service.captureStudioCardSource({
                cardId: page.items[index].cardId,
                expectedCatalogueItemRevision: page.items[index].catalogueItemRevision,
                catalogueRevision: page.catalogueRevision,
            })
            retained.push(captured)
            await h.service.releaseStudioCardSource(captured.captureRevision)
        }
        const rpc = createStudioCardResourceRpcApi(h.service)
        const captureFifth = () => rpc.captureStudioCardSource({
            cardId: page.items[4].cardId,
            expectedCatalogueItemRevision: page.items[4].catalogueItemRevision,
            catalogueRevision: page.catalogueRevision,
        })

        now = 100
        const lost = await captureFifth()
        takeStudioCardRpcFinalizer(lost)!.rollback()
        const preserved = await h.service.captureStudioCardSource({
            targetRevision: retained[0].targetRevision,
            expectedSourceRevision: retained[0].sourceRevision,
        })
        await h.service.releaseStudioCardSource(preserved.captureRevision)

        now = 200
        const delivered = await captureFifth()
        takeStudioCardRpcFinalizer(delivered)!.commit()
        await expect(h.service.captureStudioCardSource({
            targetRevision: retained[1].targetRevision,
            expectedSourceRevision: retained[1].sourceRevision,
        })).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(h.service.listStudioCardAssets({ captureRevision: delivered.captureRevision }))
            .resolves.toBeDefined()
    })

    it('claims one later-page cursor before transport delivery and publishes only live page authority', async () => {
        const h = studioHarness({
            cardIds: Array.from({ length: 73 }, (_, index) => `cursor-${index.toString().padStart(2, '0')}`),
        })
        h.catalogue.hostActiveCardId = undefined
        h.catalogue.records.forEach((record, index) => {
            record.portrait = {
                revision: sha(`cursor-portrait-${index}`),
                name: `${index}.png`,
                mediaType: 'image/png',
                locator: {
                    ownerCardId: record.cardId,
                    ownerRevision: sha(`cursor-owner-${index}`),
                    storageRevision: sha(`cursor-storage-${index}`),
                    nativeSlot: index,
                },
            }
        })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const first = await rpc.listStudioCards({ limit: 24 })
        takeStudioCardRpcFinalizer(first)!.commit()
        const request = {
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        }

        const outcomes = await Promise.allSettled([
            rpc.listStudioCards(request),
            rpc.listStudioCards(request),
        ])
        const pages = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : [])
        const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : [])

        expect(pages).toHaveLength(1)
        expect(failures).toHaveLength(1)
        expect(failures[0]).toMatchObject({ code: 'INVALID_ARGUMENT' })
        const page = pages[0]
        const portraitId = page.items[0].portrait!.assetId
        expect(() => takeStudioCardRpcFinalizer(page)!.commit()).not.toThrow()
        expect(h.registry.lookup(portraitId, h.context)).toBeDefined()
        const third = await h.service.listStudioCards({
            limit: 24,
            cursor: page.nextCursor,
            catalogueRevision: page.catalogueRevision,
        })
        expect(third.items[0].cardId).toBe('cursor-48')
    })

    it('claims one terminal-page cursor before producing a transport result', async () => {
        const h = studioHarness({
            cardIds: Array.from({ length: 25 }, (_, index) => `terminal-${index.toString().padStart(2, '0')}`),
        })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const first = await rpc.listStudioCards({ limit: 24 })
        takeStudioCardRpcFinalizer(first)!.commit()
        const request = {
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        }

        const outcomes = await Promise.allSettled([
            rpc.listStudioCards(request),
            rpc.listStudioCards(request),
        ])
        const pages = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : [])
        const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : [])

        expect(pages).toHaveLength(1)
        expect(pages[0].nextCursor).toBeUndefined()
        expect(failures).toHaveLength(1)
        expect(failures[0]).toMatchObject({ code: 'INVALID_ARGUMENT' })
        expect(() => takeStudioCardRpcFinalizer(pages[0])!.commit()).not.toThrow()
    })

    it('reserves both candidate-page slots while transport results are pending', async () => {
        const h = studioHarness({ sourceFor: (cardId) => nativeSource(cardId, 4) })
        const capture = await selectCard(h)
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const access = (logicalAssetId: string) => ({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [logicalAssetId],
            purpose: 'candidate-page' as const,
        })
        const old = [
            await h.service.resolveStudioCardAssetHandles(access(descriptors.assets[0].logicalAssetId)),
            await h.service.resolveStudioCardAssetHandles(access(descriptors.assets[1].logicalAssetId)),
        ]
        const rpc = createStudioCardResourceRpcApi(h.service)

        const pending = await Promise.all([
            rpc.resolveStudioCardAssetHandles(access(descriptors.assets[2].logicalAssetId)),
            rpc.resolveStudioCardAssetHandles(access(descriptors.assets[3].logicalAssetId)),
        ])
        for (const batch of old) expect(h.registry.lookup(batch.assets[0].asset.assetId, h.context)).toBeDefined()
        for (const batch of pending) takeStudioCardRpcFinalizer(batch)!.commit()

        for (const batch of old) {
            expect(() => h.registry.lookup(batch.assets[0].asset.assetId, h.context))
                .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
        }
        for (const batch of pending) {
            expect(h.registry.lookup(batch.assets[0].asset.assetId, h.context)).toBeDefined()
        }
    })

    it('claims the selected access slot before transport delivery and preserves its old authority until commit', async () => {
        const h = studioHarness({ sourceFor: (cardId) => nativeSource(cardId, 3) })
        const capture = await selectCard(h)
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const access = (logicalAssetId: string) => ({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [logicalAssetId],
            purpose: 'selected' as const,
        })
        const old = await h.service.resolveStudioCardAssetHandles(access(descriptors.assets[0].logicalAssetId))
        const rpc = createStudioCardResourceRpcApi(h.service)

        const outcomes = await Promise.allSettled([
            rpc.resolveStudioCardAssetHandles(access(descriptors.assets[1].logicalAssetId)),
            rpc.resolveStudioCardAssetHandles(access(descriptors.assets[2].logicalAssetId)),
        ])
        const selected = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : [])
        const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : [])

        expect(selected).toHaveLength(1)
        expect(failures).toHaveLength(1)
        expect(failures[0]).toMatchObject({ code: 'CONFLICT' })
        expect(h.registry.lookup(old.assets[0].asset.assetId, h.context)).toBeDefined()
        expect(() => takeStudioCardRpcFinalizer(selected[0])!.commit()).not.toThrow()
        expect(() => h.registry.lookup(old.assets[0].asset.assetId, h.context))
            .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
        expect(h.registry.lookup(selected[0].assets[0].asset.assetId, h.context)).toBeDefined()
    })

    it('counts each pending first-page admission once and retires only the required catalogue victim', async () => {
        let now = 0
        const h = studioHarness({ now: () => now })
        const retained: Array<{ catalogueRevision: string }> = []
        for (let index = 0; index < 3; index++) {
            now = index * 10
            retained.push(await h.service.listStudioCards({ limit: 24 }))
        }
        const rpc = createStudioCardResourceRpcApi(h.service)

        now = 100
        const firstPending = await rpc.listStudioCards({ limit: 24 })
        now = 110
        const secondPending = await rpc.listStudioCards({ limit: 24 })
        takeStudioCardRpcFinalizer(firstPending)!.commit()
        takeStudioCardRpcFinalizer(secondPending)!.commit()

        const oldReleases = await Promise.allSettled(retained.map((page) =>
            h.service.releaseStudioCardCatalogue(page.catalogueRevision)))
        expect(oldReleases.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2)
        await expect(h.service.releaseStudioCardCatalogue(firstPending.catalogueRevision)).resolves.toBeUndefined()
        await expect(h.service.releaseStudioCardCatalogue(secondPending.catalogueRevision)).resolves.toBeUndefined()
    })

    it('keeps transport-pending page and access parents alive until their exact commit', async () => {
        const h = studioHarness({
            cardIds: Array.from({ length: 25 }, (_, index) => `parent-${index.toString().padStart(2, '0')}`),
            sourceFor: (cardId) => nativeSource(cardId, 1),
        })
        h.catalogue.hostActiveCardId = undefined
        h.catalogue.records.forEach((record, index) => {
            record.portrait = {
                revision: sha(`parent-portrait-${index}`), name: `${index}.png`, mediaType: 'image/png',
                locator: {
                    ownerCardId: record.cardId,
                    ownerRevision: sha(`parent-owner-${index}`),
                    storageRevision: sha(`parent-storage-${index}`),
                    nativeSlot: index,
                },
            }
        })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const first = await rpc.listStudioCards({ limit: 24 })
        takeStudioCardRpcFinalizer(first)!.commit()
        const pendingPage = await rpc.listStudioCards({
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        })

        await expect(h.service.releaseStudioCardCatalogue(first.catalogueRevision))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        takeStudioCardRpcFinalizer(pendingPage)!.commit()
        expect(h.registry.lookup(pendingPage.items[0].portrait!.assetId, h.context)).toBeDefined()

        const capture = await h.service.captureStudioCardSource({
            cardId: first.items[0].cardId,
            expectedCatalogueItemRevision: first.items[0].catalogueItemRevision,
            catalogueRevision: first.catalogueRevision,
        })
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const pendingAccess = await rpc.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })

        await expect(h.service.releaseStudioCardSource(capture.captureRevision))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        takeStudioCardRpcFinalizer(pendingAccess)!.commit()
        expect(h.registry.lookup(pendingAccess.assets[0].asset.assetId, h.context)).toBeDefined()
        await expect(h.service.releaseStudioCardSource(capture.captureRevision)).resolves.toBeUndefined()
    })

    it('pins a catalogue with a transport-pending later page against LRU retirement', async () => {
        let now = 0
        const h = studioHarness({
            cardIds: Array.from({ length: 25 }, (_, index) => `lru-parent-${index.toString().padStart(2, '0')}`),
            now: () => now,
        })
        h.catalogue.hostActiveCardId = undefined
        h.catalogue.records.forEach((record, index) => {
            record.portrait = {
                revision: sha(`lru-parent-portrait-${index}`), name: `${index}.png`, mediaType: 'image/png',
                locator: {
                    ownerCardId: record.cardId,
                    ownerRevision: sha(`lru-parent-owner-${index}`),
                    storageRevision: sha(`lru-parent-storage-${index}`),
                    nativeSlot: index,
                },
            }
        })
        const catalogues: Array<{ catalogueRevision: string; nextCursor?: string }> = []
        for (let index = 0; index < 4; index++) {
            now = index * 10
            catalogues.push(await h.service.listStudioCards({ limit: 24 }))
        }
        const rpc = createStudioCardResourceRpcApi(h.service)
        const pendingPage = await rpc.listStudioCards({
            limit: 24,
            cursor: catalogues[0].nextCursor,
            catalogueRevision: catalogues[0].catalogueRevision,
        })

        now = 100
        const replacement = await rpc.listStudioCards({ limit: 24 })
        takeStudioCardRpcFinalizer(replacement)!.commit()
        takeStudioCardRpcFinalizer(pendingPage)!.commit()

        expect(h.registry.lookup(pendingPage.items[0].portrait!.assetId, h.context)).toBeDefined()
        await expect(h.service.releaseStudioCardCatalogue(catalogues[0].catalogueRevision))
            .resolves.toBeUndefined()
    })

    it('rejects a reserved LRU retirement when its victim gains a pending page before admission', async () => {
        let now = 0
        const h = studioHarness({
            cardIds: Array.from({ length: 25 }, (_, index) => `late-pin-${index.toString().padStart(2, '0')}`),
            now: () => now,
        })
        h.catalogue.hostActiveCardId = undefined
        h.catalogue.records.forEach((record, index) => {
            record.portrait = {
                revision: sha(`late-pin-portrait-${index}`), name: `${index}.png`, mediaType: 'image/png',
                locator: {
                    ownerCardId: record.cardId,
                    ownerRevision: sha(`late-pin-owner-${index}`),
                    storageRevision: sha(`late-pin-storage-${index}`),
                    nativeSlot: index,
                },
            }
        })
        const catalogues: Array<{ catalogueRevision: string; nextCursor?: string }> = []
        for (let index = 0; index < 4; index++) {
            now = index * 10
            catalogues.push(await h.service.listStudioCards({ limit: 24 }))
        }
        const gate = deferred<StudioCardNativeCatalogue>()
        h.captureCatalogue.mockImplementationOnce(() => gate.promise)
        const rpc = createStudioCardResourceRpcApi(h.service)
        now = 100
        const competingAdmission = rpc.listStudioCards({ limit: 24 })
        await waitFor(() => h.captureCatalogue.mock.calls.length === 5)
        const pendingPage = await rpc.listStudioCards({
            limit: 24,
            cursor: catalogues[0].nextCursor,
            catalogueRevision: catalogues[0].catalogueRevision,
        })

        gate.resolve(structuredClone(h.catalogue))
        await expect(competingAdmission).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        takeStudioCardRpcFinalizer(pendingPage)!.commit()
        expect(h.registry.lookup(pendingPage.items[0].portrait!.assetId, h.context)).toBeDefined()
    })

    it('rejects a stale LRU retirement after its victim page commits during admission', async () => {
        let now = 0
        const h = studioHarness({
            cardIds: Array.from({ length: 25 }, (_, index) => `committed-use-${index.toString().padStart(2, '0')}`),
            now: () => now,
        })
        const catalogues: Array<{ catalogueRevision: string; nextCursor?: string }> = []
        for (let index = 0; index < 4; index++) {
            now = index * 10
            catalogues.push(await h.service.listStudioCards({ limit: 24 }))
        }
        const gate = deferred<StudioCardNativeCatalogue>()
        h.captureCatalogue.mockImplementationOnce(() => gate.promise)
        const rpc = createStudioCardResourceRpcApi(h.service)
        now = 100
        const competingAdmission = rpc.listStudioCards({ limit: 24 })
        await waitFor(() => h.captureCatalogue.mock.calls.length === 5)
        const deliveredPage = await rpc.listStudioCards({
            limit: 24,
            cursor: catalogues[0].nextCursor,
            catalogueRevision: catalogues[0].catalogueRevision,
        })
        takeStudioCardRpcFinalizer(deliveredPage)!.commit()

        gate.resolve(structuredClone(h.catalogue))
        await expect(competingAdmission).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(h.service.captureStudioCardSource({
            cardId: deliveredPage.items[0].cardId,
            expectedCatalogueItemRevision: deliveredPage.items[0].catalogueItemRevision,
            catalogueRevision: deliveredPage.catalogueRevision,
        })).resolves.toBeDefined()
    })

    it('rejects a stale LRU retirement after its victim portrait is touched during admission', async () => {
        let now = 0
        const h = studioHarness({ now: () => now })
        h.catalogue.records[0].portrait = {
            revision: sha('retirement-touch-portrait'), name: 'portrait.png', mediaType: 'image/png',
            locator: {
                ownerCardId: h.catalogue.records[0].cardId,
                ownerRevision: sha('retirement-touch-owner'),
                storageRevision: sha('retirement-touch-storage'),
                nativeSlot: 0,
            },
        }
        let oldest: Awaited<ReturnType<StudioCardResourceService['listStudioCards']>> | undefined
        for (let index = 0; index < 4; index++) {
            now = index * 10
            const page = await h.service.listStudioCards({ limit: 24 })
            if (index === 0) oldest = page
        }
        const gate = deferred<StudioCardNativeCatalogue>()
        h.captureCatalogue.mockImplementationOnce(() => gate.promise)
        const rpc = createStudioCardResourceRpcApi(h.service)
        now = 100
        const competingAdmission = rpc.listStudioCards({ limit: 24 })
        await waitFor(() => h.captureCatalogue.mock.calls.length === 5)
        const authority = h.registry.lookup(oldest!.items[0].portrait!.assetId, h.context)
        if (authority.authorityKind !== 'studio-catalogue-portrait') {
            throw new Error('Expected Studio portrait authority')
        }
        authority.touch?.()

        gate.resolve(structuredClone(h.catalogue))
        await expect(competingAdmission).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(authority.validate()).resolves.toBeUndefined()
    })

    it('rejects a later page when a posted admission already owns its parent LRU retirement', async () => {
        let now = 0
        const h = studioHarness({
            cardIds: Array.from({ length: 25 }, (_, index) => `claimed-lru-${index.toString().padStart(2, '0')}`),
            now: () => now,
        })
        const catalogues: Array<{ catalogueRevision: string; nextCursor?: string }> = []
        for (let index = 0; index < 4; index++) {
            now = index * 10
            catalogues.push(await h.service.listStudioCards({ limit: 24 }))
        }
        const rpc = createStudioCardResourceRpcApi(h.service)
        now = 100
        const pendingReplacement = await rpc.listStudioCards({ limit: 24 })

        await expect(rpc.listStudioCards({
            limit: 24,
            cursor: catalogues[0].nextCursor,
            catalogueRevision: catalogues[0].catalogueRevision,
        })).rejects.toMatchObject({ code: 'CONFLICT' })

        takeStudioCardRpcFinalizer(pendingReplacement)!.rollback()
        await expect(h.service.listStudioCards({
            limit: 24,
            cursor: catalogues[0].nextCursor,
            catalogueRevision: catalogues[0].catalogueRevision,
        })).resolves.toMatchObject({ items: [expect.objectContaining({ cardId: 'claimed-lru-24' })] })
    })

    it('keeps an LRU reservation victim through TTL cleanup until replacement rollback', async () => {
        let now = 0
        const h = studioHarness({
            cardIds: Array.from({ length: 25 }, (_, index) => `victim-ttl-${index.toString().padStart(2, '0')}`),
            now: () => now,
        })
        const oldest = await h.service.listStudioCards({ limit: 24 })
        for (let index = 1; index < 4; index++) {
            now = index * 10
            await h.service.listStudioCards({ limit: 24 })
        }
        const rpc = createStudioCardResourceRpcApi(h.service)
        now = 100
        const pendingReplacement = await rpc.listStudioCards({ limit: 24 })

        now = 300_001
        await expect(h.service.releaseStudioCardCatalogue(sha('missing-catalogue')))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        takeStudioCardRpcFinalizer(pendingReplacement)!.rollback()

        await expect(h.service.captureStudioCardSource({
            cardId: oldest.items[0].cardId,
            expectedCatalogueItemRevision: oldest.items[0].catalogueItemRevision,
            catalogueRevision: oldest.catalogueRevision,
        })).resolves.toBeDefined()
    })

    it('blocks target release while one of its captures has a pending access result', async () => {
        const h = studioHarness({ sourceFor: (cardId) => nativeSource(cardId, 1) })
        const capture = await selectCard(h)
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const pendingAccess = await rpc.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })

        await expect(h.service.releaseStudioCardTarget(capture.targetRevision))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        takeStudioCardRpcFinalizer(pendingAccess)!.commit()
        expect(h.registry.lookup(pendingAccess.assets[0].asset.assetId, h.context)).toBeDefined()
        await expect(h.service.releaseStudioCardTarget(capture.targetRevision)).resolves.toBeUndefined()
    })

    it('keeps all posted transport commits nonthrowing when the injected clock fails', async () => {
        let throwClock = false
        const h = studioHarness({
            cardIds: Array.from({ length: 25 }, (_, index) => `clock-${index.toString().padStart(2, '0')}`),
            sourceFor: (cardId) => nativeSource(cardId, 1),
            now: () => {
                if (throwClock) throw new Error('clock failed')
                return 0
            },
        })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const page = await rpc.listStudioCards({ limit: 24 })
        throwClock = true
        expect(() => takeStudioCardRpcFinalizer(page)!.commit()).not.toThrow()
        throwClock = false
        await expect(h.service.listStudioCards({
            limit: 24,
            cursor: page.nextCursor,
            catalogueRevision: page.catalogueRevision,
        })).resolves.toMatchObject({ items: [expect.objectContaining({ cardId: 'clock-24' })] })

        const capture = await rpc.captureStudioCardSource({
            cardId: page.items[0].cardId,
            expectedCatalogueItemRevision: page.items[0].catalogueItemRevision,
            catalogueRevision: page.catalogueRevision,
        })
        throwClock = true
        expect(() => takeStudioCardRpcFinalizer(capture)!.commit()).not.toThrow()
        throwClock = false
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const access = await rpc.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        throwClock = true
        expect(() => takeStudioCardRpcFinalizer(access)!.commit()).not.toThrow()
        throwClock = false
        await expect(h.service.releaseStudioCardAssetAccess(access.accessRevision)).resolves.toBeUndefined()
        await expect(h.service.releaseStudioCardSource(capture.captureRevision)).resolves.toBeUndefined()
    })

    it('refreshes a delayed page rollback so its exact cursor and parent can be retried', async () => {
        let now = 0
        const h = studioHarness({
            cardIds: Array.from({ length: 25 }, (_, index) => `rollback-page-${index.toString().padStart(2, '0')}`),
            now: () => now,
        })
        const first = await h.service.listStudioCards({ limit: 24 })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const pendingPage = await rpc.listStudioCards({
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        })

        now = 300_001
        takeStudioCardRpcFinalizer(pendingPage)!.rollback()

        await expect(h.service.listStudioCards({
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        })).resolves.toMatchObject({ items: [expect.objectContaining({ cardId: 'rollback-page-24' })] })
    })

    it('refreshes prior access authority and ancestors after a delayed replacement rollback', async () => {
        let now = 0
        const h = studioHarness({ now: () => now, sourceFor: (cardId) => nativeSource(cardId, 2) })
        const capture = await selectCard(h)
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const oldAccess = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const pendingAccess = await rpc.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[1].logicalAssetId],
            purpose: 'selected',
        })

        now = 300_001
        takeStudioCardRpcFinalizer(pendingAccess)!.rollback()

        const authority = h.registry.lookup(oldAccess.assets[0].asset.assetId, h.context)
        if (authority.authorityKind !== 'studio-card-capture') throw new Error('Expected Studio authority')
        await expect(authority.validate()).resolves.toBeUndefined()
        await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
            .resolves.toBeDefined()
    })

    it('does not let a premature read evict a transport-pending cursor after TTL', async () => {
        let now = 0
        const h = studioHarness({
            cardIds: Array.from({ length: 49 }, (_, index) => `pending-read-${index.toString().padStart(2, '0')}`),
            now: () => now,
            cursorRegistry: new CursorRegistry({ now: () => now }),
        })
        const first = await h.service.listStudioCards({ limit: 24 })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const pendingPage = await rpc.listStudioCards({
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        })

        now = 300_001
        await expect(h.service.listStudioCards({
            limit: 24,
            cursor: pendingPage.nextCursor,
            catalogueRevision: pendingPage.catalogueRevision,
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        takeStudioCardRpcFinalizer(pendingPage)!.commit()

        await expect(h.service.listStudioCards({
            limit: 24,
            cursor: pendingPage.nextCursor,
            catalogueRevision: pendingPage.catalogueRevision,
        })).resolves.toMatchObject({ items: [expect.objectContaining({ cardId: 'pending-read-48' })] })
    })

    it('pins a transport-pending page and cursor through TTL cleanup until delivery', async () => {
        let now = 0
        const h = studioHarness({
            cardIds: Array.from({ length: 49 }, (_, index) => `ttl-parent-${index.toString().padStart(2, '0')}`),
            now: () => now,
        })
        h.catalogue.hostActiveCardId = undefined
        h.catalogue.records.forEach((record, index) => {
            record.portrait = {
                revision: sha(`ttl-parent-portrait-${index}`), name: `${index}.png`, mediaType: 'image/png',
                locator: {
                    ownerCardId: record.cardId,
                    ownerRevision: sha(`ttl-parent-owner-${index}`),
                    storageRevision: sha(`ttl-parent-storage-${index}`),
                    nativeSlot: index,
                },
            }
        })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const first = await rpc.listStudioCards({ limit: 24 })
        takeStudioCardRpcFinalizer(first)!.commit()
        const pendingPage = await rpc.listStudioCards({
            limit: 24,
            cursor: first.nextCursor,
            catalogueRevision: first.catalogueRevision,
        })

        now = 300_001
        await expect(h.service.releaseStudioCardCatalogue(first.catalogueRevision))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        takeStudioCardRpcFinalizer(pendingPage)!.commit()

        expect(h.registry.lookup(pendingPage.items[0].portrait!.assetId, h.context)).toBeDefined()
        await expect(h.service.listStudioCards({
            limit: 24,
            cursor: pendingPage.nextCursor,
            catalogueRevision: pendingPage.catalogueRevision,
        })).resolves.toMatchObject({ items: [expect.objectContaining({ cardId: 'ttl-parent-48' })] })
    })

    it('pins a transport-pending access through capture and target TTL cleanup until delivery', async () => {
        let now = 0
        const h = studioHarness({
            now: () => now,
            sourceFor: (cardId) => nativeSource(cardId, 2),
        })
        const capture = await selectCard(h)
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const old = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        const rpc = createStudioCardResourceRpcApi(h.service)
        const pendingAccess = await rpc.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[1].logicalAssetId],
            purpose: 'selected',
        })

        now = 1_800_001
        await expect(h.service.releaseStudioCardSource(capture.captureRevision))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        expect(h.registry.lookup(old.assets[0].asset.assetId, h.context)).toBeDefined()
        takeStudioCardRpcFinalizer(pendingAccess)!.commit()

        expect(() => h.registry.lookup(old.assets[0].asset.assetId, h.context))
            .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
        expect(h.registry.lookup(pendingAccess.assets[0].asset.assetId, h.context)).toBeDefined()
        await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
            .resolves.toBeDefined()
    })

    it('invalidates all descendants on unload and rejects source deletion or revision drift atomically', async () => {
        const h = studioHarness()
        const capture = await selectCard(h)
        const descriptors = await h.service.listStudioCardAssets({ captureRevision: capture.captureRevision })
        const access = await h.service.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })
        h.captureSource.mockImplementationOnce(async () => null)
        await expect(h.service.captureStudioCardSource({
            targetRevision: capture.targetRevision,
            expectedSourceRevision: capture.sourceRevision,
        })).rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
            .resolves.toBeDefined()

        const changed = nativeSource('card-1')
        changed.card.lorebook.push({ id: 'changed', name: 'Changed', content: 'Changed lore', enabled: true })
        h.captureSource.mockImplementationOnce(async () => changed)
        await expect(h.service.captureStudioCardSource({
            targetRevision: capture.targetRevision,
            expectedSourceRevision: capture.sourceRevision,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
            .resolves.toBeDefined()

        const driftedSources = [
            (() => {
                const source = nativeSource('card-1')
                source.card.textSections[0].content = 'Changed text'
                return source
            })(),
            (() => {
                const source = nativeSource('card-1')
                source.assets[0].revision = sha('changed-asset-revision')
                return source
            })(),
            (() => {
                const source = nativeSource('card-1')
                source.assets = []
                return source
            })(),
            (() => {
                const source = nativeSource('card-1')
                source.assets.push(nativeAsset('card-1', 1))
                return source
            })(),
        ]
        for (const source of driftedSources) {
            h.captureSource.mockImplementationOnce(async () => source)
            await expect(h.service.captureStudioCardSource({
                targetRevision: capture.targetRevision,
                expectedSourceRevision: capture.sourceRevision,
            })).rejects.toMatchObject({ code: 'CONFLICT' })
            await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
                .resolves.toBeDefined()
        }

        h.abortController.abort()
        await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
            .rejects.toMatchObject({ code: 'ABORTED' })
        expect(() => h.registry.lookup(access.assets[0].asset.assetId, h.context))
            .toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    })

    it('rejects direct-member drift while preserving the adopted group capture', async () => {
        const h = studioHarness({ cardIds: ['group-1'] })
        const memberIds = ['member-a', 'member-b']
        h.catalogue.records[0].kind = 'group'
        h.catalogue.records[0].groupMemberIds = memberIds
        const original = nativeSource('group-1', 0)
        original.card = card('group-1', 'Group', 'group')
        original.card.groupMemberIds = memberIds
        original.groupMembers = memberIds.map((memberId) => card(memberId))
        h.captureSource.mockImplementation(async () => structuredClone(original))
        const capture = await selectCard(h)

        const changed = structuredClone(original)
        changed.groupMembers[0].textSections[0].content = 'Changed member text'
        h.captureSource.mockImplementationOnce(async () => changed)
        await expect(h.service.captureStudioCardSource({
            targetRevision: capture.targetRevision,
            expectedSourceRevision: capture.sourceRevision,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(h.service.listStudioCardAssets({ captureRevision: capture.captureRevision }))
            .resolves.toBeDefined()
    })
})
