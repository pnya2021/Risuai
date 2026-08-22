import { afterEach, describe, expect, it, vi } from 'vitest'
import { SvelteMap } from 'svelte/reactivity'
import { proxy as deepState } from 'svelte/internal/client'
import { get as getStoreValue } from 'svelte/store'
import { ContextAssetAuthorityRegistry } from './contextAssetAuthorityRegistry'
import { ContextAssetReadCoordinator } from './contextAssetReadCoordinator'
import { ContextResourceService, type ContextHostState } from './contextResources'
import { CursorRegistry } from './cursorRegistry'
import { createStudioCardCatalogueIndex } from './studioCardCatalogueIndex.svelte'
import { createRisuStudioCardResourceAdapter } from './studioCardResources.risu'
import { createStudioCardResourceService, type StudioCardResourceService } from './studioCardResources'

vi.mock('../../../parser/parser.svelte', () => ({
    applyMarkdownToNode: vi.fn(),
    assetRegex: /$^/,
    hasher: vi.fn().mockResolvedValue('hash'),
    risuChatParser: vi.fn(),
    risuEscape: vi.fn((value: string) => value),
    risuUnescape: vi.fn((value: string) => value),
}))

type RawCard = Record<string, any>

const hiddenGetter = (name: string) => ({
    enumerable: false,
    get(): never { throw new Error(`${name} must not be read`) },
})

const protectChatAndExecutableFields = <T extends RawCard>(card: T): T => {
    Object.defineProperties(card, {
        chats: hiddenGetter('chats'),
        chatPage: hiddenGetter('chatPage'),
        message: hiddenGetter('message'),
        customscript: hiddenGetter('customscript'),
        scripts: hiddenGetter('scripts'),
        triggerScript: hiddenGetter('triggerScript'),
        secret: hiddenGetter('secret'),
        apiKey: hiddenGetter('apiKey'),
    })
    return card
}

const character = (id: string, name = id): RawCard => protectChatAndExecutableFields({
    chaId: id,
    type: 'character',
    name,
    image: `assets/${id}.png`,
    desc: `${name} description`,
    personality: `${name} personality`,
    scenario: `${name} scenario`,
    firstMessage: `${name} hello`,
    exampleMessage: `${name} example`,
    creatorNotes: `${name} notes`,
    systemPrompt: `${name} system`,
    postHistoryInstructions: `${name} post-history`,
    notes: `${name} private notes`,
    additionalText: `${name} additional`,
    globalLore: [{ id: `${id}-lore`, comment: 'World', content: `${name} lore`, mode: 'normal' }],
    emotionImages: [],
    additionalAssets: [],
    ccAssets: [],
})

const group = (id: string, memberIds: string[], name = id): RawCard => protectChatAndExecutableFields({
    ...character(id, name),
    type: 'group',
    characters: memberIds,
})

const live: Array<{ studio: StudioCardResourceService; reader?: ContextResourceService }> = []

afterEach(() => {
    for (const item of live.splice(0)) {
        item.reader?.dispose()
        item.studio.dispose()
    }
    vi.restoreAllMocks()
})

function harness(
    cards: unknown[],
    selectedIndex = -1,
    storageRevisions = new Map<string, string>(),
    catalogueReactivity: {
        reactive?: boolean
        getAssetStorageMutationGeneration?: () => string | number
    } = {},
) {
    const database = { characters: cards }
    const selected = { value: selectedIndex }
    const readImage = vi.fn(async () => new Uint8Array([1, 2, 3, 4]))
    const getAssetStorageRevision = vi.fn((storageKey: string) =>
        storageRevisions.get(storageKey) ?? `storage:${storageKey}:1`)
    const adapterDependencies = {
        getDatabase: () => database,
        getSelectedCharacterIndex: () => selected.value,
        readImage,
        getAssetStorageRevision,
        reactiveCatalogueIndex: catalogueReactivity.reactive,
        getAssetStorageMutationGeneration: catalogueReactivity.getAssetStorageMutationGeneration,
    }
    const adapter = createRisuStudioCardResourceAdapter(adapterDependencies)
    const registry = new ContextAssetAuthorityRegistry()
    const coordinator = new ContextAssetReadCoordinator()
    const context = {
        principalId: crypto.randomUUID(),
        instanceId: crypto.randomUUID(),
        displayName: 'Studio',
        signal: new AbortController().signal,
    }
    const studio = createStudioCardResourceService({
        context,
        adapter,
        assetAuthorityRegistry: registry,
        readCoordinator: coordinator,
        cursorRegistry: new CursorRegistry(),
        permissionGeneration: () => 'permission:1',
        requirePermission: async () => undefined,
    })
    const item: { studio: StudioCardResourceService; reader?: ContextResourceService } = { studio }
    live.push(item)
    const reader = () => {
        const state: ContextHostState = { characters: [], activeModules: [], installedModules: [] }
        item.reader = new ContextResourceService(context, {
            getState: async () => state,
            readAsset: async () => { throw new Error('current-context fallback must not run') },
            createThumbnail: async (_source, data) => ({
                data, mediaType: 'image/png', width: 1, height: 1, decodedPixels: 1,
            }),
        }, {
            requirePermission: async () => undefined,
            getPermissionGeneration: () => 'permission:1',
            assetAuthorityRegistry: registry,
            readCoordinator: coordinator,
        })
        return item.reader
    }
    return { adapter, studio, database, selected, readImage, getAssetStorageRevision, reader, registry }
}

async function select(h: ReturnType<typeof harness>, cardId: string) {
    const page = await h.studio.listStudioCards({ limit: 24 })
    const summary = page.items.find((item) => item.cardId === cardId) ?? page.hostActiveCard
    expect(summary?.cardId).toBe(cardId)
    return h.studio.captureStudioCardSource({
        cardId,
        expectedCatalogueItemRevision: summary!.catalogueItemRevision,
        catalogueRevision: page.catalogueRevision,
    })
}

const canonicalSourceBytes = (source: {
    card: unknown
    groupMembers: unknown[]
    assets: unknown[]
}) => new TextEncoder().encode(JSON.stringify({
    card: source.card,
    groupMembers: source.groupMembers,
    assets: source.assets,
})).byteLength

const captureBoundaryFixture = () => {
    const source = character('boundary', 'Boundary')
    source.image = ''
    for (const field of [
        'desc', 'personality', 'scenario', 'firstMessage', 'exampleMessage',
        'creatorNotes', 'systemPrompt', 'postHistoryInstructions', 'notes', 'additionalText',
    ]) source[field] = ''
    source.globalLore = []
    const storageRevisions = new Map<string, string>()
    source.additionalAssets = Array.from({ length: 19_999 }, (_, index) => {
        const storageKey = `assets/a-${index}.png`
        storageRevisions.set(storageKey, 'r')
        return ['x'.repeat(index < 62 ? 457 : 456), storageKey, 'png']
    })
    return { source, storageRevisions }
}

describe('Risu Studio card native projection', () => {
    it('accepts the exact 20,000-item canonical capture envelope', async () => {
        const fixture = captureBoundaryFixture()
        const h = harness([fixture.source], 0, fixture.storageRevisions)

        const captured = await h.adapter.captureSource('boundary')

        expect(captured).not.toBeNull()
        expect(1 + captured!.groupMembers.length + captured!.assets.length).toBe(20_000)
        expect(canonicalSourceBytes(captured!)).toBe(16_777_211)
    }, 120_000)

    it('rejects a 20,000-item canonical capture envelope above 16 MiB', async () => {
        const fixture = captureBoundaryFixture()
        const h = harness([fixture.source], 0, fixture.storageRevisions)
        const exact = await h.adapter.captureSource('boundary')
        expect(exact).not.toBeNull()
        const oversizedEnvelope = {
            card: exact!.card,
            groupMembers: exact!.groupMembers,
            assets: exact!.assets.map((asset, index) => index === 0
                ? { ...asset, name: `${asset.name}xxxxxx` }
                : asset),
        }
        expect(canonicalSourceBytes(oversizedEnvelope)).toBe(16_777_217)
        fixture.source.additionalAssets[0][0] += 'xxxxxx'

        await expect(h.adapter.captureSource('boundary')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    }, 120_000)

    it('reuses the reactive scalar index without reprojecting unchanged cards', () => {
        const raw = character('alice', 'Alice')
        let scalarReads = 0
        const tracked = new Proxy(raw, {
            getOwnPropertyDescriptor(target, property) {
                if (['chaId', 'type', 'name', 'image', 'characters', 'trashTime'].includes(String(property))) {
                    scalarReads += 1
                }
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
        })
        const cards = new SvelteMap<number, RawCard>([[0, tracked]])
        const dependencies = {
            getCharacters: () => [...cards.values()],
            getSelectedCharacterIndex: () => 0,
            getAssetStorageRevision: (storageKey) => `storage:${storageKey}:1`,
            reactive: true,
        }
        const index = createStudioCardCatalogueIndex(dependencies)

        expect(index.current().records.map(({ native }) => native.cardId)).toEqual(['alice'])
        const readsAfterColdBuild = scalarReads
        expect(index.current().records.map(({ native }) => native.cardId)).toEqual(['alice'])
        expect(scalarReads).toBe(readsAfterColdBuild)

        cards.set(1, character('bob', 'Bob'))
        expect(index.current().records.map(({ native }) => native.cardId)).toEqual(['alice', 'bob'])
        expect(scalarReads).toBeGreaterThan(readsAfterColdBuild)
    })

    it('bounds a 4,902-card reactive catalogue to one scalar build and one indexed-field rebuild', async () => {
        const visibleCardCount = 4_902
        const scalarKeys = new Set(['chaId', 'type', 'name', 'image', 'characters', 'trashTime'])
        let scalarReads = 0
        let fullCardCloneReads = 0
        const projectedTextOrLore = new Set<string>()
        const cards = Array.from({ length: visibleCardCount }, (_, index) => {
            const id = `card-${index.toString().padStart(4, '0')}`
            const raw = character(id, `Card ${index.toString().padStart(4, '0')}`)
            return new Proxy(raw, {
                getOwnPropertyDescriptor(target, property) {
                    if (scalarKeys.has(String(property))) scalarReads += 1
                    if (property === 'desc' || property === 'globalLore') projectedTextOrLore.add(id)
                    return Reflect.getOwnPropertyDescriptor(target, property)
                },
                ownKeys(target) {
                    fullCardCloneReads += 1
                    return Reflect.ownKeys(target)
                },
            })
        })
        const state = deepState({ characters: cards })
        const h = harness(state.characters, -1, new Map(), { reactive: true })

        const first = await h.studio.listStudioCards({ limit: 24 })
        expect(first.total).toBe(visibleCardCount)
        expect(first.items).toHaveLength(24)
        expect(scalarReads).toBe(visibleCardCount * scalarKeys.size * 4)
        expect(fullCardCloneReads).toBe(0)
        expect(projectedTextOrLore).toEqual(new Set())
        expect(h.registry.size()).toBe(24)

        const coldScalarReads = scalarReads
        const coldGeneration = h.adapter.captureGeneration()
        await h.studio.releaseStudioCardCatalogue(first.catalogueRevision)
        expect(h.registry.size()).toBe(0)
        await h.adapter.captureCatalogue()
        expect(scalarReads).toBe(coldScalarReads)
        expect(h.adapter.captureGeneration()).toBe(coldGeneration)
        expect(fullCardCloneReads).toBe(0)

        state.characters[1].name = 'Card 0001 renamed'
        const rebuilt = await h.studio.listStudioCards({ limit: 24 })
        const rebuildScalarReads = scalarReads - coldScalarReads
        const rebuiltGeneration = h.adapter.captureGeneration()
        expect(rebuildScalarReads).toBeGreaterThan(0)
        expect(rebuildScalarReads).toBeLessThanOrEqual(coldScalarReads)
        expect(rebuiltGeneration).not.toBe(coldGeneration)
        expect(rebuilt.items.some(({ name }) => name === 'Card 0001 renamed')).toBe(true)
        await h.adapter.captureCatalogue()
        expect(scalarReads).toBe(coldScalarReads + rebuildScalarReads)
        expect(h.adapter.captureGeneration()).toBe(rebuiltGeneration)
        expect(fullCardCloneReads).toBe(0)
        const retainedCatalogue = rebuilt

        state.characters[0].desc = 'selected text changed without rebuilding the catalogue'
        state.characters[0].globalLore[0].content = 'selected lore changed without rebuilding the catalogue'
        const selectedSummary = retainedCatalogue.items.find(({ cardId }) => cardId === 'card-0000')!
        const scalarReadsBeforeCapture = scalarReads
        const capture = await h.studio.captureStudioCardSource({
            cardId: selectedSummary.cardId,
            expectedCatalogueItemRevision: selectedSummary.catalogueItemRevision,
            catalogueRevision: retainedCatalogue.catalogueRevision,
        })

        expect(capture.card.textSections.find(({ key }) => key === 'description')?.content)
            .toBe('selected text changed without rebuilding the catalogue')
        expect(capture.card.lorebook[0].content)
            .toBe('selected lore changed without rebuilding the catalogue')
        expect(projectedTextOrLore).toEqual(new Set(['card-0000']))
        expect(scalarReads - scalarReadsBeforeCapture).toBeLessThanOrEqual(64)
        expect(h.adapter.captureGeneration()).toBe(rebuiltGeneration)
        expect(fullCardCloneReads).toBe(0)

        const reader = h.reader()
        const firstPortraitId = retainedCatalogue.items[0].portrait!.assetId
        const adjacent = await h.studio.listStudioCards({
            limit: 24,
            cursor: retainedCatalogue.nextCursor,
            catalogueRevision: retainedCatalogue.catalogueRevision,
        })
        expect(h.registry.size()).toBe(48)
        await expect(reader.readContextAsset(firstPortraitId, { variant: 'original' }))
            .resolves.toMatchObject({ data: new Uint8Array([1, 2, 3, 4]) })
        await expect(reader.readContextAsset(adjacent.items[0].portrait!.assetId, { variant: 'original' }))
            .resolves.toMatchObject({ data: new Uint8Array([1, 2, 3, 4]) })
        const readsBeforeReplacement = h.readImage.mock.calls.length

        const replacement = await h.studio.listStudioCards({
            limit: 24,
            cursor: adjacent.nextCursor,
            catalogueRevision: adjacent.catalogueRevision,
        })
        expect(h.registry.size()).toBe(48)
        await expect(reader.readContextAsset(firstPortraitId, { variant: 'original' }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(h.readImage).toHaveBeenCalledTimes(readsBeforeReplacement)
        await expect(reader.readContextAsset(adjacent.items[1].portrait!.assetId, { variant: 'original' }))
            .resolves.toBeDefined()
        await expect(reader.readContextAsset(replacement.items[1].portrait!.assetId, { variant: 'original' }))
            .resolves.toBeDefined()

        await h.studio.releaseStudioCardCatalogue(retainedCatalogue.catalogueRevision)
        expect(h.registry.size()).toBe(0)
        const unloadPage = await h.studio.listStudioCards({ limit: 24 })
        expect(unloadPage.items).toHaveLength(24)
        expect(h.registry.size()).toBe(24)
        h.studio.dispose()
        expect(h.registry.size()).toBe(0)
    }, 60_000)

    it.each([
        {
            change: 'card id',
            mutate: (cards: RawCard[]) => { cards[0].chaId = 'renamed' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.byId.has('party')).toBe(false)
                expect(snapshot.byId.has('renamed')).toBe(true)
            },
        },
        {
            change: 'card type',
            mutate: (cards: RawCard[]) => { cards[0].type = 'character' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native).toMatchObject({ kind: 'character', groupMemberIds: [] })
            },
        },
        {
            change: 'card name',
            mutate: (cards: RawCard[]) => { cards[0].name = 'Renamed party' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native.name).toBe('Renamed party')
            },
        },
        {
            change: 'portrait key',
            mutate: (cards: RawCard[]) => { cards[0].image = 'assets/replacement.png' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native.portrait?.name).toBe('Party.png')
                expect(snapshot.records[0].native.portrait?.locator.storageRevision)
                    .toBe('storage:assets/replacement.png:1')
            },
        },
        {
            change: 'direct member element',
            mutate: (cards: RawCard[]) => { cards[0].characters[0] = 'member-b' },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native.groupMemberIds).toEqual(['member-b'])
            },
        },
        {
            change: 'direct member array',
            mutate: (cards: RawCard[]) => { cards[0].characters = ['member-b'] },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.records[0].native.groupMemberIds).toEqual(['member-b'])
            },
        },
        {
            change: 'trash state',
            mutate: (cards: RawCard[]) => { cards[0].trashTime = 1 },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.byId.has('party')).toBe(false)
            },
        },
        {
            change: 'array slot identity',
            mutate: (cards: RawCard[]) => {
                cards[0] = { chaId: 'replacement', type: 'character', name: 'Replacement', image: 'assets/replacement.png' }
            },
            assertSnapshot: (snapshot: ReturnType<ReturnType<typeof createStudioCardCatalogueIndex>['current']>) => {
                expect(snapshot.byId.has('party')).toBe(false)
                expect(snapshot.byId.has('replacement')).toBe(true)
            },
        },
    ])('invalidates the actual deep rune scalar index after an in-place $change mutation', ({ mutate, assertSnapshot }) => {
        const state = deepState({
            characters: [
                { chaId: 'party', type: 'group', name: 'Party', image: 'assets/party.png', characters: ['member-a'] },
                { chaId: 'member-a', type: 'character', name: 'Member A', image: 'assets/member-a.png' },
                { chaId: 'member-b', type: 'character', name: 'Member B', image: 'assets/member-b.png' },
            ] as RawCard[],
        })
        const index = createStudioCardCatalogueIndex({
            getCharacters: () => state.characters,
            getSelectedCharacterIndex: () => 0,
            getAssetStorageRevision: (storageKey) => `storage:${storageKey}:1`,
            reactive: true,
        })
        const initial = index.current()

        mutate(state.characters)

        const changed = index.current()
        expect(changed).not.toBe(initial)
        expect(index.isCurrent(initial)).toBe(false)
        assertSnapshot(changed)
    })

    it('invalidates a warm portrait catalogue after an authoritative same-key storage replacement', async () => {
        const state = deepState({
            characters: [character('alice', 'Alice')],
            storageGeneration: 0,
        })
        const revisions = new Map([['assets/alice.png', 'storage:alice:1']])
        const h = harness(state.characters, 0, revisions, {
            reactive: true,
            getAssetStorageMutationGeneration: () => state.storageGeneration,
        })
        const reader = h.reader()
        const first = await h.studio.listStudioCards({ limit: 24 })
        const firstSummary = first.items[0]

        revisions.set('assets/alice.png', 'storage:alice:2')
        state.storageGeneration += 1

        const replacement = await h.studio.listStudioCards({ limit: 24 })
        const replacementSummary = replacement.items[0]
        expect(replacement.catalogueRevision).not.toBe(first.catalogueRevision)
        expect(replacementSummary.catalogueItemRevision).not.toBe(firstSummary.catalogueItemRevision)
        expect(replacementSummary.portrait?.revision).not.toBe(firstSummary.portrait?.revision)
        await expect(reader.readContextAsset(firstSummary.portrait!.assetId, { variant: 'original' }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(reader.readContextAsset(replacementSummary.portrait!.assetId, { variant: 'original' }))
            .resolves.toMatchObject({ data: new Uint8Array([1, 2, 3, 4]) })
        expect(h.readImage).toHaveBeenCalledTimes(1)
    })

    it('projects a bounded scalar catalogue without evaluating chat, executable, or secret fields', async () => {
        const alice = character('alice', 'Alice')
        const party = group('party', ['member-b', 'member-a', 'member-a'], 'Party')
        const hostCurrent = character('host-current', 'Zulu')
        const duplicateA = character('duplicate', 'Duplicate A')
        const duplicateB = character('duplicate', 'Duplicate B')
        const trashed = Object.assign(character('trashed'), { trashTime: 1 })
        const reservedTemp = character('§temp')
        const reservedPlayground = character('§playground')
        const malformedGroup = Object.assign(character('bad-group'), { type: 'group', characters: ['alice', 7] })
        const accessorId = Object.defineProperty({ name: 'Accessor' }, 'chaId', hiddenGetter('chaId'))
        const h = harness([
            duplicateA, alice, null, reservedTemp, party, accessorId, trashed,
            duplicateB, malformedGroup, reservedPlayground, hostCurrent,
        ], 10)

        const page = await h.studio.listStudioCards({ limit: 2 })

        expect(page.total).toBe(3)
        expect(page.items.map(({ cardId }) => cardId)).toEqual(['alice', 'party'])
        expect(page.hostActiveCard).toMatchObject({ cardId: 'host-current', name: 'Zulu', kind: 'character' })
        expect(page.items[1]).toMatchObject({ kind: 'group', groupMemberCount: 2 })
        expect(page.items.map(({ portrait }) => portrait?.revision ?? '')).not.toContainEqual(
            expect.stringContaining('assets/'),
        )
        expect(h.selected.value).toBe(10)
        expect(h.readImage).not.toHaveBeenCalled()

        const portrait = await h.reader().readContextAsset(page.items[0].portrait!.assetId, { variant: 'original' })
        expect(portrait.data).toEqual(new Uint8Array([1, 2, 3, 4]))
        expect(h.readImage).toHaveBeenCalledWith('assets/alice.png')
    })

    it('excludes an over-limit group before enumerating its direct-member array', async () => {
        let memberReads = 0
        const members = new Proxy(Array.from({ length: 101 }, (_, index) => `member-${index}`), {
            getOwnPropertyDescriptor(target, property) {
                if (/^\d+$/u.test(String(property))) memberReads += 1
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
        })
        const h = harness([group('oversized-group', members, 'Oversized group'), character('alice')], 1)

        const page = await h.studio.listStudioCards({ limit: 24 })

        expect(page.items.map(({ cardId }) => cardId)).toEqual(['alice'])
        expect(memberReads).toBe(0)
    })

    it('captures the latest non-current normal and group card-only sources with stable direct members', async () => {
        const alice = character('alice', 'Alice')
        const memberA = character('member-a', 'Member A')
        const memberB = character('member-b', 'Member B')
        const party = group('party', ['member-b', 'member-a', 'member-a'], 'Party')
        const h = harness([alice, memberA, party, memberB], 0)
        const catalogue = await h.studio.listStudioCards({ limit: 24 })
        const aliceSummary = catalogue.items.find(({ cardId }) => cardId === 'alice')!
        alice.desc = 'latest description after catalogue publication'

        const latest = await h.studio.captureStudioCardSource({
            cardId: 'alice',
            expectedCatalogueItemRevision: aliceSummary.catalogueItemRevision,
            catalogueRevision: catalogue.catalogueRevision,
        })
        expect(latest.card.textSections.find(({ key }) => key === 'description')?.content)
            .toBe('latest description after catalogue publication')
        expect(latest.groupMembers).toEqual([])
        expect(latest.sourceRevision).not.toBe(aliceSummary.catalogueItemRevision)

        const partySummary = catalogue.items.find(({ cardId }) => cardId === 'party')!
        const captured = await h.studio.captureStudioCardSource({
            cardId: 'party',
            expectedCatalogueItemRevision: partySummary.catalogueItemRevision,
            catalogueRevision: catalogue.catalogueRevision,
        })
        expect(captured.card).toMatchObject({ id: 'party', type: 'group', groupMemberIds: ['member-a', 'member-b'] })
        expect(captured.groupMembers.map(({ id }) => id)).toEqual(['member-a', 'member-b'])
        expect(captured.card.lorebook).toEqual([{
            id: 'party-lore', name: 'World', content: 'Party lore', enabled: true,
        }])
        expect(h.selected.value).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it('keeps retained A authority across Host navigation and unrelated C catalogue changes', async () => {
        const sourceA = character('source-a', 'Source A')
        const sourceB = character('source-b', 'Source B')
        const unrelatedC = character('source-c', 'Source C')
        const h = harness([sourceA, sourceB, unrelatedC], 0)
        const adopted = await select(h, 'source-a')
        const descriptors = await h.studio.listStudioCardAssets({ captureRevision: adopted.captureRevision })
        const access = await h.studio.resolveStudioCardAssetHandles({
            captureRevision: adopted.captureRevision,
            logicalAssetIds: [descriptors.assets[0].logicalAssetId],
            purpose: 'selected',
        })

        h.selected.value = 1
        unrelatedC.name = 'Unrelated C renamed'

        await expect(h.studio.listStudioCardAssets({ captureRevision: adopted.captureRevision }))
            .resolves.toMatchObject({ captureRevision: adopted.captureRevision })
        await expect(h.reader().readContextAsset(access.assets[0].asset.assetId, { variant: 'original' }))
            .resolves.toMatchObject({ data: new Uint8Array([1, 2, 3, 4]) })
        await expect(h.studio.captureStudioCardSource({
            targetRevision: adopted.targetRevision,
            expectedSourceRevision: adopted.sourceRevision,
        })).resolves.toMatchObject({
            targetRevision: adopted.targetRevision,
            sourceRevision: adopted.sourceRevision,
        })

        sourceA.desc = 'Source A genuinely changed'
        await expect(h.studio.captureStudioCardSource({
            targetRevision: adopted.targetRevision,
            expectedSourceRevision: adopted.sourceRevision,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(h.studio.listStudioCardAssets({ captureRevision: adopted.captureRevision }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it.each([
        ['root text', (root: RawCard) => { root.desc = 'changed during capture' }],
        ['global lore', (root: RawCard) => { root.globalLore[0].content = 'changed during capture' }],
        ['direct membership', (root: RawCard) => { root.characters = [] }],
        ['member text', (_root: RawCard, member: RawCard) => { member.desc = 'changed during capture' }, 'member'],
        ['asset revision', (_root: RawCard, _member: RawCard, revisions: Map<string, string>) => {
            revisions.set('assets/member-a.png', 'storage:member-a:2')
        }],
    ])('rejects atomic source capture when %s drifts during projection', async (_label, mutate, trigger = 'root') => {
        const revisions = new Map<string, string>()
        const rawMember = character('member-a', 'Member A')
        const rawRoot = group('party', ['member-a'], 'Party')
        let armed = false
        let tripped = false
        let rootTriggerReads = 0
        let memberTriggerReads = 0
        const root = new Proxy(rawRoot, {
            getOwnPropertyDescriptor(target, property) {
                const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
                if (armed && trigger === 'root' && property === 'additionalAssets') rootTriggerReads += 1
                if (armed && !tripped && trigger === 'root' && property === 'additionalAssets'
                    && rootTriggerReads === 3) {
                    tripped = true
                    mutate(target, rawMember, revisions)
                }
                return descriptor
            },
        })
        const member = new Proxy(rawMember, {
            getOwnPropertyDescriptor(target, property) {
                const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
                if (armed && trigger === 'member' && property === 'additionalText') memberTriggerReads += 1
                if (armed && !tripped && trigger === 'member' && property === 'additionalText'
                    && memberTriggerReads === 2) {
                    tripped = true
                    mutate(rawRoot, target, revisions)
                }
                return descriptor
            },
        })
        const h = harness([root, member], 0, revisions)
        const page = await h.studio.listStudioCards({ limit: 24 })
        const summary = page.items.find(({ cardId }) => cardId === 'party')!
        armed = true

        await expect(h.studio.captureStudioCardSource({
            cardId: 'party',
            expectedCatalogueItemRevision: summary.catalogueItemRevision,
            catalogueRevision: page.catalogueRevision,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it.each(['deleted', 'trashed'] as const)('fails closed when a selected card is %s after catalogue admission', async (change) => {
        const alice = character('alice', 'Alice')
        const h = harness([alice], 0)
        const page = await h.studio.listStudioCards({ limit: 24 })
        if (change === 'deleted') h.database.characters.splice(0, 1)
        else alice.trashTime = 1

        await expect(h.studio.captureStudioCardSource({
            cardId: 'alice',
            expectedCatalogueItemRevision: page.items[0].catalogueItemRevision,
            catalogueRevision: page.catalogueRevision,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it('rejects an over-limit raw asset collection before enumerating any asset entry', async () => {
        const alice = character('alice', 'Alice')
        let projectedEntries = 0
        alice.additionalAssets = new Proxy(
            Array.from({ length: 20_000 }, (_, index) => [
                `asset-${index}.png`, `assets/asset-${index}.png`, 'png',
            ]),
            {
                getOwnPropertyDescriptor(target, property) {
                    if (/^\d+$/u.test(String(property))) projectedEntries += 1
                    return Reflect.getOwnPropertyDescriptor(target, property)
                },
            },
        )
        const h = harness([alice], 0)

        await expect(select(h, 'alice')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(projectedEntries).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it('rejects an oversized first text field before projecting later card fields', async () => {
        const raw = character('alice', 'Alice')
        raw.desc = 'x'.repeat(524_289)
        let laterFieldReads = 0
        const alice = new Proxy(raw, {
            getOwnPropertyDescriptor(target, property) {
                if (property === 'personality') laterFieldReads += 1
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
        })
        const h = harness([alice], 0)

        await expect(select(h, 'alice')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(laterFieldReads).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it('rejects JSON-escaped text beyond the snapshot limit before projecting later card fields', async () => {
        const raw = character('alice', 'Alice')
        raw.desc = '\0'.repeat(400_000)
        let laterFieldReads = 0
        const alice = new Proxy(raw, {
            getOwnPropertyDescriptor(target, property) {
                if (property === 'personality') laterFieldReads += 1
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
        })
        const h = harness([alice], 0)

        await expect(select(h, 'alice')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(laterFieldReads).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it('rejects oversized lore metadata before copying later lore entries', async () => {
        const alice = character('alice', 'Alice')
        let laterLoreReads = 0
        alice.globalLore = new Proxy([
            { id: 'oversized', comment: 'Oversized', content: 'x'.repeat(524_289), mode: 'normal' },
            { id: 'later', comment: 'Later', content: 'must not be projected', mode: 'normal' },
        ], {
            getOwnPropertyDescriptor(target, property) {
                if (property === '1') laterLoreReads += 1
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
        })
        const h = harness([alice], 0)

        await expect(select(h, 'alice')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(laterLoreReads).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it('rejects aggregate source metadata before projecting fields beyond the 16 MiB boundary', async () => {
        const memberIds = Array.from({ length: 12 }, (_, index) => `member-${index}`)
        const members = memberIds.map((id) => Object.assign(character(id, id), {
            desc: 'd'.repeat(500_000),
            personality: 'p'.repeat(500_000),
            scenario: 's'.repeat(500_000),
        }))
        let beyondBoundaryReads = 0
        members[9] = new Proxy(members[9], {
            getOwnPropertyDescriptor(target, property) {
                if (property === 'personality') beyondBoundaryReads += 1
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
        })
        const h = harness([group('party', memberIds, 'Party'), ...members], 0)

        await expect(select(h, 'party')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(beyondBoundaryReads).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()
    }, 30_000)

    it('rejects JSON-escaped asset-name metadata beyond 16 MiB before source projection', async () => {
        const alice = character('alice', 'Alice')
        const escapedName = '\\'.repeat(400_000)
        let firstEntryReads = 0
        alice.additionalAssets = new Proxy(
            Array.from({ length: 40 }, (_, index) => [
                escapedName, `assets/escaped-${index}.png`, 'png',
            ]),
            {
                getOwnPropertyDescriptor(target, property) {
                    if (property === '0') {
                        firstEntryReads += 1
                        if (firstEntryReads > 1) throw new Error('source projection entered')
                    }
                    return Reflect.getOwnPropertyDescriptor(target, property)
                },
            },
        )
        const h = harness([alice], 0)

        await expect(select(h, 'alice')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(firstEntryReads).toBe(1)
        expect(h.readImage).not.toHaveBeenCalled()
    })

    it('rejects final descriptor structure beyond 16 MiB before mapping an exact 20,000-item source', async () => {
        const cardId = 'c'.repeat(300)
        const alice = character(cardId, 'Alice')
        alice.image = 'assets/portrait.png'
        let firstEntryReads = 0
        alice.additionalAssets = new Proxy(
            Array.from({ length: 19_998 }, (_, index) => [
                `asset-${index}.png`, `assets/asset-${index}.png`, 'png',
            ]),
            {
                getOwnPropertyDescriptor(target, property) {
                    if (property === '0') {
                        firstEntryReads += 1
                        if (firstEntryReads > 1) throw new Error('source descriptor mapping entered')
                    }
                    return Reflect.getOwnPropertyDescriptor(target, property)
                },
            },
        )
        const h = harness([alice], 0)

        await expect(select(h, cardId)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(firstEntryReads).toBe(1)
        expect(h.readImage).not.toHaveBeenCalled()
    }, 30_000)

    it('bounds arbitrary 4,902-asset access and recapture without bulk handle reissue', async () => {
        const alice = character('alice', 'Alice')
        alice.image = ''
        alice.additionalAssets = Array.from({ length: 4_902 }, (_, index) => [
            `asset-${index}.png`, `assets/asset-${index}.png`, 'png',
        ])
        const expectedStorageKeys = new Set(
            Array.from({ length: 4_902 }, (_, index) => `assets/asset-${index}.png`),
        )
        const h = harness([alice], 0)
        const capture = await select(h, 'alice')
        const authorityCountBeforeEnumeration = h.registry.size()
        const descriptors = []
        let cursor: string | undefined
        do {
            const page = await h.studio.listStudioCardAssets({
                captureRevision: capture.captureRevision,
                limit: 100,
                ...(cursor ? { cursor } : {}),
            })
            descriptors.push(...page.assets)
            cursor = page.nextCursor
        } while (cursor)

        expect(descriptors).toHaveLength(4_902)
        expect(new Set(descriptors.map(({ logicalAssetId }) => logicalAssetId)).size).toBe(4_902)
        expect(descriptors.map(({ assetRevision }) => assetRevision)).not.toContainEqual(
            expect.stringContaining('assets/'),
        )
        expect(h.registry.size()).toBe(authorityCountBeforeEnumeration)
        expect(authorityCountBeforeEnumeration).toBe(0)
        expect(h.readImage).not.toHaveBeenCalled()

        const ranked = Array.from({ length: descriptors.length }, (_, rank) =>
            descriptors[(rank * 197 + 31) % descriptors.length].logicalAssetId)
        expect(ranked.slice(0, 24)).not.toEqual(
            descriptors.slice(0, 24).map(({ logicalAssetId }) => logicalAssetId),
        )
        const firstIds = ranked.slice(0, 24)
        const adjacentIds = ranked.slice(2_111, 2_135)
        const selectedIds = ranked.slice(-3)
        const firstAccess = await h.studio.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: firstIds,
            purpose: 'candidate-page',
        })
        const adjacentAccess = await h.studio.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: adjacentIds,
            purpose: 'candidate-page',
        })
        const selectedAccess = await h.studio.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: selectedIds,
            purpose: 'selected',
        })
        expect(firstAccess.assets).toHaveLength(24)
        expect(adjacentAccess.assets).toHaveLength(24)
        expect(selectedAccess.assets).toHaveLength(3)
        expect(h.registry.size()).toBe(51)
        expect(h.readImage).not.toHaveBeenCalled()

        await expect(h.reader().readContextAsset(adjacentAccess.assets[7].asset.assetId, { variant: 'original' }))
            .resolves.toMatchObject({ data: new Uint8Array([1, 2, 3, 4]) })
        await expect(h.reader().readContextAsset(selectedAccess.assets[1].asset.assetId, { variant: 'original' }))
            .resolves.toMatchObject({ data: new Uint8Array([1, 2, 3, 4]) })
        expect(h.readImage).toHaveBeenCalledTimes(2)

        const currentAccess = await h.studio.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: ranked.slice(3_500, 3_524),
            purpose: 'candidate-page',
        })
        expect(h.registry.size()).toBe(51)
        await expect(h.reader().readContextAsset(firstAccess.assets[7].asset.assetId, { variant: 'original' }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(h.readImage).toHaveBeenCalledTimes(2)
        await expect(h.reader().readContextAsset(currentAccess.assets[7].asset.assetId, { variant: 'original' }))
            .resolves.toMatchObject({ data: new Uint8Array([1, 2, 3, 4]) })
        expect(h.readImage).toHaveBeenCalledTimes(3)

        h.getAssetStorageRevision.mockClear()
        const recapture = await h.studio.captureStudioCardSource({
            targetRevision: capture.targetRevision,
            expectedSourceRevision: capture.sourceRevision,
        })
        const recaptureStorageKeys = new Set(
            h.getAssetStorageRevision.mock.calls.map(([storageKey]) => storageKey),
        )
        expect(recaptureStorageKeys).toEqual(expectedStorageKeys)
        expect(recapture.sourceRevision).toBe(capture.sourceRevision)
        expect(recapture.captureRevision).not.toBe(capture.captureRevision)
        expect(h.registry.size()).toBe(51)
    }, 60_000)

    it('discovers the Studio catalogue through the real V3 SandboxHost without touching chat state', async () => {
        const stores = await import('../../../stores.svelte')
        const v3 = await import('../v3.svelte')
        const chatTouched = vi.fn(() => { throw new Error('capability discovery touched chat state') })
        let discovering = false
        const current = { ...character('capability-card', 'Capability Card') }
        Object.defineProperties(current, {
            chats: {
                enumerable: true,
                configurable: true,
                get: () => discovering ? chatTouched() : [],
            },
            chatPage: {
                enumerable: true,
                configurable: true,
                get: () => discovering ? chatTouched() : 0,
            },
        })
        const plugin = {
            name: `studio-capability-${crypto.randomUUID()}`,
            displayName: 'Studio capability test',
            script: '',
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            version: '3.0' as const,
            enabled: true,
            principalId: crypto.randomUUID(),
        }
        const previousCharacters = stores.DBState.db.characters
        const previousPlugins = stores.DBState.db.plugins
        const previousSelected = stores.selIdState.selId
        const previousSelectedStore = getStoreValue(stores.selectedCharID)
        let instance: ReturnType<typeof v3.getV3PluginInstance>
        try {
            stores.DBState.db.characters = [current] as any
            stores.DBState.db.plugins = [plugin] as any
            stores.selectedCharID.set(0)
            stores.selIdState.selId = 0
            await v3.executePluginV3(plugin as any)
            instance = v3.getV3PluginInstance(plugin.name)
            expect(instance).toBeDefined()

            discovering = true
            const descriptors = await (instance!.host as any).apiFactory.getCapabilities(
                ['context.cards-catalog.v1'],
            ).finally(() => { discovering = false })
            expect(descriptors['context.cards-catalog.v1']).toMatchObject({
                supported: true,
            })
            expect(chatTouched).not.toHaveBeenCalled()
        } finally {
            discovering = false
            if (instance) await v3.unloadV3Plugin(instance.instanceId)
            stores.DBState.db.characters = previousCharacters
            stores.DBState.db.plugins = previousPlugins
            stores.selectedCharID.set(previousSelectedStore)
            stores.selIdState.selId = previousSelected
        }
    }, 30_000)
})
