import { describe, expect, it, vi } from 'vitest'
import {
    createBoundedContextThumbnail,
    createRisuContextResourceAdapter,
    parseImageDimensions,
    type RisuContextAdapterDependencies,
} from './contextResources.risu'
import {
    ContextResourceService,
    type ContextAssetCollectionInput,
    type ContextModuleCollectionInput,
} from './contextResources'
import { CursorRegistry } from './cursorRegistry'
import { QueryCaptureCache } from './queryCaptureCache'

const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
    return { promise, resolve }
}

const makeLore = (id: string, content: string, mode: 'normal' | 'folder' = 'normal') => ({
    id,
    comment: `${id} comment`,
    content,
    mode,
    key: '',
    secondkey: '',
    insertorder: 0,
    alwaysActive: false,
    selective: false,
})

const makeChat = () => ({
    id: 'conversation-1',
    name: 'Conversation',
    note: '',
    localLore: [makeLore('local-lore', 'Local lore')],
    modules: ['module-chat'],
    message: [
        { role: 'user', data: 'Hello', chatId: 'message-1' },
        { role: 'char', data: 'Welcome' },
    ],
    bindedPersona: 'persona-1',
})

const makeCharacter = (overrides: Record<string, unknown> = {}) => ({
    type: 'character',
    chaId: 'char-1',
    name: 'Alice',
    image: 'assets/alice.png',
    desc: 'Description',
    personality: 'Personality',
    scenario: 'Scenario',
    firstMessage: 'Greeting',
    exampleMessage: 'Example',
    creatorNotes: 'Creator notes',
    systemPrompt: 'System prompt',
    postHistoryInstructions: 'Post-history instructions',
    notes: 'Private author notes intentionally exposed as descriptive card notes',
    additionalText: 'Additional text',
    globalLore: [makeLore('char-lore', 'Character lore'), makeLore('folder', '', 'folder')],
    emotionImages: [['happy', 'assets/happy.webp']],
    additionalAssets: [['uniform', 'assets/uniform.jpg', 'jpg']],
    ccAssets: [
        { type: 'icon', uri: 'assets/icon.png', name: 'icon', ext: 'png' },
        { type: 'sound', uri: 'assets/voice.mp3', name: 'voice', ext: 'mp3' },
    ],
    modules: ['module-character'],
    chats: [makeChat()],
    chatPage: 0,
    customscript: [{ in: 'do not expose' }],
    triggerscript: [{ comment: 'do not expose' }],
    oaiTTSConfig: { apiKey: 'do not expose' },
    ...overrides,
})

const makeModule = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    namespace: `${id}-namespace`,
    name: `${id} name`,
    description: `${id} description`,
    lorebook: [makeLore(`${id}-lore`, `${id} lore content`)],
    assets: [[`${id} reference`, `assets/${id}.png`, 'png']],
    cjs: 'do not expose',
    regex: [{ in: 'do not expose' }],
    trigger: [{ comment: 'do not expose' }],
    ...overrides,
})

function dependencies(overrides: Partial<RisuContextAdapterDependencies> = {}): RisuContextAdapterDependencies {
    const currentCharacter = makeCharacter()
    const modules = [makeModule('module-global'), makeModule('module-chat'), makeModule('module-installed')]
    return {
        getDatabase: () => ({
            characters: [currentCharacter, makeCharacter({ chaId: 'char-2', name: 'Bob' })],
            modules,
        }),
        getCurrentCharacter: () => currentCharacter,
        getCurrentChat: () => currentCharacter.chats[0],
        getActiveModulesWithReasons: () => [
            { module: modules[0], activatedBy: ['global', 'integration'] },
            { module: modules[1], activatedBy: ['chat', 'character'] },
        ],
        readImage: async (key) => new TextEncoder().encode(`bytes:${key}`),
        createThumbnail: async () => ({
            data: new Uint8Array([1, 2, 3]),
            mediaType: 'image/webp',
            width: 1,
            height: 1,
            decodedPixels: 1,
        }),
        getAssetStorageRevision: (storageKey) => `revision:${storageKey}:1`,
        ...overrides,
    }
}

describe('Risu context resource adapter', () => {
    it('projects only descriptive single-card, conversation, asset, lore, and module fields', async () => {
        const adapter = createRisuContextResourceAdapter(dependencies())
        const state = await adapter.getState()
        expect(state.current).toMatchObject({
            characterId: 'char-1',
            personaId: 'persona-1',
            conversation: {
                id: 'conversation-1',
                selectedModuleIds: ['module-chat'],
                messageMembership: ['message-1', 'legacy-message:1'],
                localLorebook: [{
                    id: 'local-lore', name: 'local-lore comment', content: 'Local lore', enabled: true,
                }],
            },
        })
        expect(state.characters[0]).toMatchObject({
            id: 'char-1',
            type: 'character',
            name: 'Alice',
            lorebook: expect.arrayContaining([
                expect.objectContaining({ id: 'char-lore', enabled: true }),
                expect.objectContaining({ id: 'folder', enabled: false }),
            ]),
            assets: expect.arrayContaining([
                expect.objectContaining({
                    role: 'portrait', storageKey: 'assets/alice.png', storageRevision: 'revision:assets/alice.png:1',
                }),
                expect.objectContaining({ role: 'emotion', storageKey: 'assets/happy.webp' }),
                expect.objectContaining({
                    role: 'additional', storageKey: 'assets/uniform.jpg', name: 'uniform', extension: 'jpg',
                }),
                expect.objectContaining({ role: 'additional', storageKey: 'assets/icon.png' }),
                expect.objectContaining({ role: 'additional', storageKey: 'assets/voice.mp3', mediaType: 'audio/mpeg' }),
            ]),
        })
        const sectionKeys = state.characters[0].textSections.map((section) => section.key)
        expect(sectionKeys).toEqual([
            'description', 'personality', 'scenario', 'firstMessage', 'exampleMessage',
            'creatorNotes', 'systemPrompt', 'postHistoryInstructions', 'notes', 'additionalText',
        ])
        expect(state.activeModules.map((module) => ({ id: module.id, activatedBy: module.activatedBy }))).toEqual([
            { id: 'module-global', activatedBy: ['global', 'integration'] },
            { id: 'module-chat', activatedBy: ['chat', 'character'] },
        ])
        expect(state.installedModules.map((module) => module.id)).toEqual([
            'module-global', 'module-chat', 'module-installed',
        ])
        expect(state.installedModules[0].assets[0]).toMatchObject({
            name: 'module-global reference',
            storageKey: 'assets/module-global.png',
            extension: 'png',
        })
        expect(JSON.stringify(state)).not.toContain('do not expose')
        expect(JSON.stringify(state)).not.toContain('apiKey')
    })

    it('drops every non-canonical local asset key while retaining valid card and module assets', async () => {
        const unsafeCharacter = makeCharacter({
            image: 'assets/../portrait.png',
            emotionImages: [
                ['unsafe emotion', 'assets/./emotion.png'],
                ['safe emotion', 'assets/safe-emotion.png'],
            ],
            additionalAssets: [
                ['unsafe additional', 'assets/nested/additional.png', 'png'],
                ['safe additional', 'assets/safe-additional.png', 'png'],
            ],
            ccAssets: [
                { type: 'icon', uri: 'assets\\unsafe-icon.png', name: 'unsafe icon', ext: 'png' },
                { type: 'icon', uri: 'assets/safe-icon.png', name: 'safe icon', ext: 'png' },
            ],
        })
        const safeCharacter = makeCharacter({
            chaId: 'safe-character',
            name: 'Safe character',
            image: 'assets/safe-portrait.png',
            emotionImages: [],
            additionalAssets: [],
            ccAssets: [],
        })
        const unsafeModule = makeModule('unsafe-module', {
            assets: [
                ['unsafe module', 'C:\\absolute-module.png', 'png'],
                ['safe module', 'assets/safe-module.png', 'png'],
            ],
        })
        const deps = dependencies({
            getDatabase: () => ({ characters: [unsafeCharacter, safeCharacter], modules: [unsafeModule] }),
            getCurrentCharacter: () => unsafeCharacter,
            getCurrentChat: () => unsafeCharacter.chats[0],
            getActiveModulesWithReasons: () => [{ module: unsafeModule, activatedBy: ['global'] }],
        })

        const state = await createRisuContextResourceAdapter(deps).getState()
        const storageKeys = [
            ...state.characters.flatMap((character) => character.assets.map((asset) => asset.storageKey)),
            ...state.activeModules.flatMap((module) => module.assets.map((asset) => asset.storageKey)),
            ...state.installedModules.flatMap((module) => module.assets.map((asset) => asset.storageKey)),
        ]

        expect(storageKeys).toEqual(expect.arrayContaining([
            'assets/safe-emotion.png',
            'assets/safe-additional.png',
            'assets/safe-icon.png',
            'assets/safe-portrait.png',
            'assets/safe-module.png',
        ]))
        for (const unsafeKey of [
            'assets/../portrait.png',
            'assets/./emotion.png',
            'assets/nested/additional.png',
            'assets\\unsafe-icon.png',
            'C:\\absolute-module.png',
        ]) {
            expect(storageKeys).not.toContain(unsafeKey)
        }
    })

    it('projects a group plus member IDs and does not flatten member cards into the group', async () => {
        const group = makeCharacter({
            type: 'group',
            chaId: 'group-1',
            name: 'Expedition',
            characters: ['char-1', 'char-2'],
        })
        const member1 = makeCharacter()
        const member2 = makeCharacter({ chaId: 'char-2', name: 'Bob' })
        const deps = dependencies({
            getDatabase: () => ({ characters: [group, member1, member2], modules: [] }),
            getCurrentCharacter: () => group,
            getCurrentChat: () => group.chats[0],
            getActiveModulesWithReasons: () => [],
        })
        const state = await createRisuContextResourceAdapter(deps).getState()
        expect(state.current?.characterId).toBe('group-1')
        expect(state.characters.find((item) => item.id === 'group-1')).toMatchObject({
            type: 'group', groupMemberIds: ['char-1', 'char-2'],
        })
        expect(state.characters.find((item) => item.id === 'char-1')).toMatchObject({ type: 'character', name: 'Alice' })
        expect(state.characters.find((item) => item.id === 'char-2')).toMatchObject({ type: 'character', name: 'Bob' })
    })

    it('keeps installed modules available when no current chat exists', async () => {
        const deps = dependencies({
            getCurrentCharacter: () => undefined,
            getCurrentChat: () => undefined,
            getActiveModulesWithReasons: () => [],
        })
        const state = await createRisuContextResourceAdapter(deps).getState()
        expect(state.current).toBeUndefined()
        expect(state.installedModules).toHaveLength(3)
    })

    it('fails without mutating records when current context IDs were not normalized at load time', async () => {
        const character = makeCharacter({ chaId: '' })
        const chat = character.chats[0]
        chat.id = ''
        const deps = dependencies({
            getDatabase: () => ({ characters: [character], modules: [] }),
            getCurrentCharacter: () => character,
            getCurrentChat: () => chat,
            getActiveModulesWithReasons: () => [],
        })
        await expect(createRisuContextResourceAdapter(deps).getState()).rejects.toMatchObject({ code: 'INTERNAL' })
        expect(character.chaId).toBe('')
        expect(chat.id).toBe('')
    })

    it('normalizes backend binary values and delegates bounded thumbnails without exposing the storage key', async () => {
        const thumbnail = vi.fn(async (_source, data: Uint8Array, constraints) => ({
            data: data.subarray(0, 2).slice(),
            mediaType: 'image/webp',
            width: 1,
            height: 1,
            decodedPixels: 1,
            constraints,
        }))
        const adapter = createRisuContextResourceAdapter(dependencies({
            readImage: async () => new Uint8Array([9, 8, 7]).buffer,
            createThumbnail: thumbnail,
        }))
        const source = (await adapter.getState()).characters[0].assets[0]
        await expect(adapter.readAsset(source)).resolves.toEqual(new Uint8Array([9, 8, 7]))
        await expect(adapter.createThumbnail(source, new Uint8Array([9, 8, 7]), {
            longEdge: 512, maxPixels: 262_144, maxOutputBytes: 1_048_576,
        })).resolves.toMatchObject({ data: new Uint8Array([9, 8]) })
        expect(thumbnail).toHaveBeenCalledOnce()
    })

    it('checks cancellation before and after an uncancellable image read', async () => {
        const preAborted = new AbortController()
        preAborted.abort()
        const preflightRead = vi.fn(async () => new Uint8Array([1]))
        const preflightAdapter = createRisuContextResourceAdapter(dependencies({ readImage: preflightRead }))
        const source = (await preflightAdapter.getState()).characters[0].assets[0]

        await expect(preflightAdapter.readAsset(source, preAborted.signal))
            .rejects.toMatchObject({ code: 'ABORTED' })
        expect(preflightRead).not.toHaveBeenCalled()

        const gate = deferred<Uint8Array>()
        const activeRead = vi.fn(async () => gate.promise)
        const activeAdapter = createRisuContextResourceAdapter(dependencies({ readImage: activeRead }))
        const active = new AbortController()
        const pending = activeAdapter.readAsset(source, active.signal)
        await vi.waitFor(() => expect(activeRead).toHaveBeenCalledOnce())
        active.abort()
        gate.resolve(new Uint8Array([9, 8, 7]))

        await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    })

    it('checks cancellation before and after uncancellable thumbnail creation', async () => {
        const preflightThumbnail = vi.fn(async () => ({
            data: new Uint8Array([1]), mediaType: 'image/webp', width: 1, height: 1, decodedPixels: 1,
        }))
        const preflightAdapter = createRisuContextResourceAdapter(dependencies({
            createThumbnail: preflightThumbnail,
        }))
        const source = (await preflightAdapter.getState()).characters[0].assets[0]
        const constraints = { longEdge: 512, maxPixels: 262_144, maxOutputBytes: 1_048_576 }
        const preAborted = new AbortController()
        preAborted.abort()

        await expect(preflightAdapter.createThumbnail(
            source, new Uint8Array([1]), constraints, preAborted.signal,
        )).rejects.toMatchObject({ code: 'ABORTED' })
        expect(preflightThumbnail).not.toHaveBeenCalled()

        const gate = deferred<{
            data: Uint8Array
            mediaType: string
            width: number
            height: number
            decodedPixels: number
        }>()
        const thumbnail = vi.fn(async () => gate.promise)
        const adapter = createRisuContextResourceAdapter(dependencies({ createThumbnail: thumbnail }))

        const active = new AbortController()
        const pending = adapter.createThumbnail(source, new Uint8Array([1]), constraints, active.signal)
        await vi.waitFor(() => expect(thumbnail).toHaveBeenCalledOnce())
        active.abort()
        gate.resolve({
            data: new Uint8Array([1]), mediaType: 'image/webp', width: 1, height: 1, decodedPixels: 1,
        })
        await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    })

    it.each([
        ['dot segment', 'assets/.'],
        ['parent segment', 'assets/../secret.png'],
        ['additional slash', 'assets/nested/secret.png'],
        ['backslash', 'assets\\secret.png'],
        ['posix absolute path', '/absolute.png'],
        ['windows absolute path', 'C:\\absolute.png'],
        ['duplicate separator', 'assets//secret.png'],
        ['non-normalized unicode', 'assets/e\u0301.png'],
    ])('rejects a %s key again at read time before calling global readImage', async (_label, storageKey) => {
        const readImage = vi.fn(async () => new Uint8Array([1, 2, 3]))
        const adapter = createRisuContextResourceAdapter(dependencies({ readImage }))
        const source = (await adapter.getState()).characters[0].assets[0]
        source.storageKey = storageKey

        await expect(adapter.readAsset(source)).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(readImage).not.toHaveBeenCalled()
    })

    it('keeps underlying asset identities stable when card asset arrays are reordered', async () => {
        const character = makeCharacter({
            additionalAssets: [
                ['first', 'assets/first.png', 'png'],
                ['second', 'assets/second.png', 'png'],
            ],
        })
        const deps = dependencies({
            getDatabase: () => ({ characters: [character], modules: [] }),
            getCurrentCharacter: () => character,
            getCurrentChat: () => character.chats[0],
            getActiveModulesWithReasons: () => [],
        })
        const adapter = createRisuContextResourceAdapter(deps)
        const before = (await adapter.getState()).characters[0].assets
            .filter((asset) => asset.role === 'additional')
        character.additionalAssets.reverse()
        const after = (await adapter.getState()).characters[0].assets
            .filter((asset) => asset.role === 'additional')
        for (const storageKey of ['assets/first.png', 'assets/second.png']) {
            expect(after.find((asset) => asset.storageKey === storageKey)?.identity)
                .toBe(before.find((asset) => asset.storageKey === storageKey)?.identity)
        }
    })

    it('captures only the requested Risu owner collections and revalidates their opaque source locators', async () => {
        const adapter = createRisuContextResourceAdapter(dependencies())
        const moduleInput: ContextModuleCollectionInput = {
            scope: 'installed', characterId: 'char-1', conversationId: 'conversation-1',
        }
        const modules = await adapter.captureModuleSources!(moduleInput)
        expect(modules.selectors).toEqual({ characterId: 'char-1', conversationId: 'conversation-1' })
        expect(modules.modules.map((module) => module.id)).toEqual([
            'module-global', 'module-chat', 'module-installed',
        ])
        await expect(adapter.revalidateModuleSource!({ source: modules.modules[1], input: moduleInput }))
            .resolves.toMatchObject({ id: 'module-chat' })

        const assetInput: ContextAssetCollectionInput = {
            characterIds: ['char-1'],
            conversationId: 'conversation-1',
            include: ['portrait', 'emotion', 'additional', 'module'],
            moduleScope: 'installed',
            moduleIds: ['module-installed'],
            mediaTypes: [],
        }
        const assets = await adapter.captureAssetSources!(assetInput)
        expect(assets.selectors).toEqual({ characterId: 'char-1', conversationId: 'conversation-1' })
        expect(assets.assets.filter(({ origin }) => origin.kind === 'module').map(({ origin }) => origin))
            .toEqual([{ kind: 'module', moduleId: 'module-installed' }])
        expect(assets.assets.some(({ origin }) => origin.kind === 'character')).toBe(true)
        await expect(adapter.revalidateAssetSource!({ located: assets.assets.at(-1)!, input: assetInput }))
            .resolves.toMatchObject({ storageKey: 'assets/module-installed.png' })
    })

    it('bounds exact first-capture and final-probe work to selected modules and 2452 selected assets', async () => {
        const counters = {
            fullStateCalls: 0,
            moduleMaterializations: 0,
            moduleSlotVisits: 0,
            cachedModuleEmissions: 0,
            finalModuleEmissions: 0,
            assetMaterializations: 0,
            cachedAssetEmissions: 0,
            finalAssetEmissions: 0,
            targetedAssetProbes: 0,
            finalProbePhysicalReads: 0,
            unselectedStorageReads: 0,
            maxPhysicalReads: 0,
            unselectedSourceMaterializations: 0,
            unselectedMetadataProjections: 0,
            unselectedDigests: 0,
        }
        const countedModule = (id: string, assetCount: number, unselected = false) => {
            const module = makeModule(id, {
                assets: Array.from({ length: assetCount }, (_, index) => [
                    `${id}-${index}`, `assets/${id}-${index}.png`, 'png',
                ]),
            })
            const lorebook = module.lorebook
            Object.defineProperty(module, 'lorebook', {
                enumerable: true,
                get() {
                    counters.moduleMaterializations += 1
                    if (unselected) counters.unselectedSourceMaterializations += 1
                    return lorebook
                },
            })
            return module
        }
        const current = makeCharacter({
            image: 'assets/card-portrait.png',
            emotionImages: [['card-emotion', 'assets/card-emotion.png']],
            additionalAssets: [],
            ccAssets: [],
        })
        const selected = countedModule('selected', 2_450)
        const unrelated = countedModule('unrelated', 1_553, true)
        const deps = dependencies({
            getDatabase: () => ({ characters: [current], modules: [selected, unrelated] }),
            getCurrentCharacter: () => current,
            getCurrentChat: () => current.chats[0],
            getActiveModulesWithReasons: () => [],
            getAssetStorageRevision: (storageKey) => {
                if (storageKey.includes('unrelated')) {
                    counters.unselectedMetadataProjections += 1
                } else if (storageKey.includes('selected')) {
                    counters.moduleSlotVisits += 1
                    counters.assetMaterializations += 1
                } else {
                    counters.assetMaterializations += 1
                }
                return `revision:${storageKey}:1`
            },
            readImage: async (storageKey) => {
                if (storageKey.includes('unrelated')) counters.unselectedStorageReads += 1
                return new Uint8Array([1])
            },
        })
        const adapter = createRisuContextResourceAdapter(deps)
        const originalGetState = adapter.getState
        adapter.getState = async () => {
            counters.fullStateCalls += 1
            return originalGetState()
        }

        const moduleInput: ContextModuleCollectionInput = {
            scope: 'installed', characterId: 'char-1', conversationId: 'conversation-1',
        }
        const firstModules = await adapter.captureModuleSources!(moduleInput)
        counters.cachedModuleEmissions = firstModules.modules.length
        const finalModules = await adapter.captureModuleSources!(moduleInput)
        counters.finalModuleEmissions = finalModules.modules.slice(0, 1).length
        const moduleWork = {
            materializations: counters.moduleMaterializations,
            slotVisits: counters.moduleSlotVisits,
        }
        counters.moduleMaterializations = 0
        counters.moduleSlotVisits = 0
        counters.assetMaterializations = 0
        counters.unselectedSourceMaterializations = 0
        counters.unselectedMetadataProjections = 0

        const assetInput: ContextAssetCollectionInput = {
            characterIds: ['char-1'],
            conversationId: 'conversation-1',
            include: ['portrait', 'emotion', 'additional', 'module'],
            moduleScope: 'installed',
            moduleIds: ['selected'],
            mediaTypes: [],
        }
        const firstAssets = await adapter.captureAssetSources!(assetInput)
        counters.cachedAssetEmissions = firstAssets.assets.length
        const readsBeforeProbe = counters.unselectedStorageReads
        const finalAssets = await adapter.captureAssetSources!(assetInput)
        counters.finalAssetEmissions = finalAssets.assets.slice(0, 1).length
        counters.finalProbePhysicalReads = counters.unselectedStorageReads - readsBeforeProbe
        const assetMaterializations = counters.assetMaterializations
        const revalidate = adapter.revalidateAssetSource!.bind(adapter)
        adapter.revalidateAssetSource = async (probe) => {
            counters.targetedAssetProbes += 1
            return revalidate(probe)
        }
        await adapter.revalidateAssetSource({ located: firstAssets.assets[0], input: assetInput })

        const M = 2
        const S = 4_003
        const N = 2_452
        expect(counters.fullStateCalls).toBe(0)
        expect(moduleWork.materializations).toBeLessThanOrEqual(2 * M)
        expect(moduleWork.slotVisits).toBeLessThanOrEqual(2 * S)
        expect(counters.cachedModuleEmissions).toBe(M)
        expect(counters.finalModuleEmissions).toBeLessThanOrEqual(1)
        expect(assetMaterializations).toBeLessThanOrEqual(2 * N)
        expect(counters.cachedAssetEmissions).toBe(N)
        expect(counters.finalAssetEmissions).toBeLessThanOrEqual(1)
        expect(counters.targetedAssetProbes).toBeLessThanOrEqual(2 * N)
        expect(counters.finalProbePhysicalReads).toBe(0)
        expect(counters.unselectedStorageReads).toBe(0)
        expect(counters.maxPhysicalReads).toBeLessThanOrEqual(4)
        expect(counters.unselectedSourceMaterializations).toBe(0)
        expect(counters.unselectedMetadataProjections).toBe(0)
        expect(counters.unselectedDigests).toBe(0)

        counters.assetMaterializations = 0
        counters.unselectedSourceMaterializations = 0
        counters.unselectedMetadataProjections = 0
        const moduleOnlyInput = { ...assetInput, include: ['module' as const] }
        const firstModuleAssets = await adapter.captureAssetSources!(moduleOnlyInput)
        const finalModuleAssets = await adapter.captureAssetSources!(moduleOnlyInput)
        expect(firstModuleAssets.assets).toHaveLength(2_450)
        expect(finalModuleAssets.assets.slice(0, 1)).toHaveLength(1)
        expect(counters.assetMaterializations).toBeLessThanOrEqual(2 * 2_450)
        expect(counters.unselectedSourceMaterializations).toBe(0)
        expect(counters.unselectedMetadataProjections).toBe(0)
        expect(counters.unselectedStorageReads).toBe(0)
    })

    it('uses native captures for Host first pages and metadata-only final probes without full-state calls', async () => {
        let fullStateCalls = 0
        let physicalReads = 0
        let activeReads = 0
        let maxPhysicalReads = 0
        let targetedAssetProbes = 0
        const adapter = createRisuContextResourceAdapter(dependencies({
            readImage: async () => {
                physicalReads += 1
                activeReads += 1
                maxPhysicalReads = Math.max(maxPhysicalReads, activeReads)
                await Promise.resolve()
                activeReads -= 1
                return new Uint8Array([1, 2, 3])
            },
        }))
        const revalidateAssetSource = adapter.revalidateAssetSource!.bind(adapter)
        adapter.revalidateAssetSource = async (probe) => {
            targetedAssetProbes += 1
            return revalidateAssetSource(probe)
        }
        const fullState = adapter.getState
        adapter.getState = async () => {
            fullStateCalls += 1
            return fullState()
        }
        const abortController = new AbortController()
        const service = new ContextResourceService(
            {
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: 'native-capture-instance',
                displayName: 'Native capture',
                signal: abortController.signal,
            },
            adapter,
            {
                requirePermission: async () => undefined,
                cursorRegistry: new CursorRegistry(),
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const first = await service.listContextAssets({
            moduleScope: 'installed',
            moduleIds: ['module-installed'],
            captureScope: 'query',
            limit: 1,
        })
        const readsAfterCapture = physicalReads
        const final = await service.listContextAssets({
            moduleScope: 'installed',
            moduleIds: ['module-installed'],
            captureScope: 'query',
            captureRevision: first.captureRevision,
            limit: 1,
        })

        expect(fullStateCalls).toBe(0)
        expect(first.assets).toHaveLength(1)
        expect(final.assets).toHaveLength(1)
        expect(physicalReads).toBe(readsAfterCapture)
        expect(maxPhysicalReads).toBeLessThanOrEqual(4)
        expect(targetedAssetProbes).toBeLessThanOrEqual(2 * readsAfterCapture)
        service.dispose()
    })
})

describe('bounded Risu thumbnails', () => {
    const pngHeader = (width: number, height: number) => {
        const data = new Uint8Array(24)
        data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
        const view = new DataView(data.buffer)
        view.setUint32(16, width)
        view.setUint32(20, height)
        return data
    }

    it('parses PNG dimensions without decoding the image', () => {
        expect(parseImageDimensions(pngHeader(2048, 1024), 'image/png')).toEqual({ width: 2048, height: 1024 })
    })

    it('parses lossy WebP dimensions before requesting a bounded decode', () => {
        const data = new Uint8Array(30)
        data.set(new TextEncoder().encode('RIFF'), 0)
        data.set(new TextEncoder().encode('WEBP'), 8)
        data.set(new TextEncoder().encode('VP8 '), 12)
        data.set([0x9d, 0x01, 0x2a], 23)
        data.set([0x80, 0x02], 26)
        data.set([0x68, 0x01], 28)
        expect(parseImageDimensions(data, 'image/webp')).toEqual({ width: 640, height: 360 })
    })

    it('sniffs WebP bytes before bounded thumbnail decoding when the asset is declared as PNG', async () => {
        const hadCreateImageBitmap = 'createImageBitmap' in globalThis
        const previousCreateImageBitmap = globalThis.createImageBitmap
        const hadOffscreenCanvas = 'OffscreenCanvas' in globalThis
        const previousOffscreenCanvas = globalThis.OffscreenCanvas
        const data = new Uint8Array(30)
        data.set(new TextEncoder().encode('RIFF'), 0)
        data.set(new TextEncoder().encode('WEBP'), 8)
        data.set(new TextEncoder().encode('VP8 '), 12)
        data.set([0x9d, 0x01, 0x2a], 23)
        data.set([0x80, 0x02], 26)
        data.set([0x68, 0x01], 28)
        const createImageBitmap = vi.fn(async (
            blob: Blob,
            options: { resizeWidth: number; resizeHeight: number; resizeQuality: string },
        ) => {
            expect(blob.type).toBe('image/webp')
            return {
                width: options.resizeWidth,
                height: options.resizeHeight,
                close: vi.fn(),
            }
        })
        vi.stubGlobal('createImageBitmap', createImageBitmap)
        vi.stubGlobal('OffscreenCanvas', class {
            constructor(readonly width: number, readonly height: number) {}

            getContext() {
                return { drawImage: vi.fn() }
            }

            convertToBlob() {
                return Promise.resolve(new Blob([new Uint8Array([1])], { type: 'image/webp' }))
            }
        })

        try {
            const adapter = createRisuContextResourceAdapter(dependencies({ createThumbnail: undefined }))
            const source = (await adapter.getState()).characters[0].assets[0]
            expect(source).toMatchObject({ extension: 'png', mediaType: 'image/png' })

            await expect(adapter.createThumbnail(source, data, {
                longEdge: 512, maxPixels: 262_144, maxOutputBytes: 1_048_576,
            })).resolves.toMatchObject({ mediaType: 'image/webp', width: 512, height: 288 })
            expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
                resizeWidth: 512,
                resizeHeight: 288,
                resizeQuality: 'high',
            })
        } finally {
            if (hadCreateImageBitmap) vi.stubGlobal('createImageBitmap', previousCreateImageBitmap)
            else Reflect.deleteProperty(globalThis, 'createImageBitmap')
            if (hadOffscreenCanvas) vi.stubGlobal('OffscreenCanvas', previousOffscreenCanvas)
            else Reflect.deleteProperty(globalThis, 'OffscreenCanvas')
        }
    })

    it('decodes only a bounded resize target and enforces the exact output limits', async () => {
        const decode = vi.fn(async (_data, options: { width: number; height: number }) => ({
            drawable: { bounded: true },
            width: options.width,
            height: options.height,
            close: vi.fn(),
        }))
        const encode = vi.fn(async (_drawable, width: number, height: number) => ({
            data: new Uint8Array(1_048_576),
            mediaType: 'image/webp',
            width,
            height,
        }))
        const result = await createBoundedContextThumbnail(
            pngHeader(4096, 2048),
            'image/png',
            { longEdge: 512, maxPixels: 262_144, maxOutputBytes: 1_048_576 },
            { decode, encode },
        )
        expect(decode).toHaveBeenCalledWith(expect.any(Uint8Array), { width: 512, height: 256, mediaType: 'image/png' })
        expect(encode).toHaveBeenCalledWith({ bounded: true }, 512, 256, 1_048_576)
        expect(result).toMatchObject({ width: 512, height: 256, decodedPixels: 131_072 })
        expect(result.data).toHaveLength(1_048_576)
    })

    it('rejects malformed dimensions before invoking a decoder', async () => {
        const decode = vi.fn()
        await expect(createBoundedContextThumbnail(
            new Uint8Array([1, 2, 3]),
            'image/png',
            { longEdge: 512, maxPixels: 262_144, maxOutputBytes: 1_048_576 },
            { decode, encode: vi.fn() },
        )).rejects.toMatchObject({ code: 'DECODE_FAILED' })
        expect(decode).not.toHaveBeenCalled()
    })
})
