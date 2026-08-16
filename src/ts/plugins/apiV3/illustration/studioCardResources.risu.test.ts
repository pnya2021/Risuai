import { afterEach, describe, expect, it, vi } from 'vitest'
import { SvelteMap } from 'svelte/reactivity'
import { ContextAssetAuthorityRegistry } from './contextAssetAuthorityRegistry'
import { ContextAssetReadCoordinator } from './contextAssetReadCoordinator'
import { ContextResourceService, type ContextHostState } from './contextResources'
import { CursorRegistry } from './cursorRegistry'
import { createStudioCardCatalogueIndex } from './studioCardCatalogueIndex.svelte'
import { createRisuStudioCardResourceAdapter } from './studioCardResources.risu'
import { createStudioCardResourceService, type StudioCardResourceService } from './studioCardResources'

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

function harness(cards: unknown[], selectedIndex = -1, storageRevisions = new Map<string, string>()) {
    const database = { characters: cards }
    const selected = { value: selectedIndex }
    const readImage = vi.fn(async () => new Uint8Array([1, 2, 3, 4]))
    const getAssetStorageRevision = vi.fn((storageKey: string) =>
        storageRevisions.get(storageKey) ?? `storage:${storageKey}:1`)
    const adapter = createRisuStudioCardResourceAdapter({
        getDatabase: () => database,
        getSelectedCharacterIndex: () => selected.value,
        readImage,
        getAssetStorageRevision,
    })
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

describe('Risu Studio card native projection', () => {
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
        const root = new Proxy(rawRoot, {
            getOwnPropertyDescriptor(target, property) {
                const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
                if (armed && !tripped && trigger === 'root' && property === 'additionalAssets') {
                    tripped = true
                    mutate(target, rawMember, revisions)
                }
                return descriptor
            },
        })
        const member = new Proxy(rawMember, {
            getOwnPropertyDescriptor(target, property) {
                const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
                if (armed && !tripped && trigger === 'member' && property === 'additionalText') {
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

    it('enumerates 4,902 logical descriptors without authority and reads only exact resolved batches', async () => {
        const alice = character('alice', 'Alice')
        alice.additionalAssets = Array.from({ length: 4_902 }, (_, index) => [
            `asset-${index}.png`, `assets/asset-${index}.png`, 'png',
        ])
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

        expect(descriptors).toHaveLength(4_903)
        expect(new Set(descriptors.map(({ logicalAssetId }) => logicalAssetId)).size).toBe(4_903)
        expect(descriptors.map(({ assetRevision }) => assetRevision)).not.toContainEqual(
            expect.stringContaining('assets/'),
        )
        expect(h.registry.size()).toBe(authorityCountBeforeEnumeration)
        expect(h.readImage).not.toHaveBeenCalled()

        const arbitrary = Array.from({ length: 24 }, (_, index) =>
            descriptors[(index * 197 + 31) % descriptors.length].logicalAssetId)
        const candidate = await h.studio.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: arbitrary,
            purpose: 'candidate-page',
        })
        const selected = await h.studio.resolveStudioCardAssetHandles({
            captureRevision: capture.captureRevision,
            logicalAssetIds: descriptors.slice(-3).map(({ logicalAssetId }) => logicalAssetId),
            purpose: 'selected',
        })
        expect(candidate.assets).toHaveLength(24)
        expect(selected.assets).toHaveLength(3)
        expect(candidate.assets.map(({ logicalAssetId }) => logicalAssetId)).toEqual(arbitrary)
        expect(h.readImage).not.toHaveBeenCalled()

        const read = await h.reader().readContextAsset(candidate.assets[7].asset.assetId, { variant: 'original' })
        expect(read.data).toEqual(new Uint8Array([1, 2, 3, 4]))
        expect(h.readImage).toHaveBeenCalledTimes(1)
    }, 30_000)
})
