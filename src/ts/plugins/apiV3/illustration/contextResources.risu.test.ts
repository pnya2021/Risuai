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
import { ContextAssetReadCoordinator } from './contextAssetReadCoordinator'
import { QueryCaptureCache } from './queryCaptureCache'

const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
    return { promise, resolve }
}

const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('Timed out waiting for test condition')
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
            moduleIdsSpecified: true,
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

    it('treats an explicit empty installed-module filter as no module source while an omitted filter remains inclusive', async () => {
        const adapter = createRisuContextResourceAdapter(dependencies())
        const base: Omit<ContextAssetCollectionInput, 'moduleIds'> = {
            characterIds: ['char-1'],
            conversationId: 'conversation-1',
            include: ['module'],
            moduleScope: 'installed',
            mediaTypes: [],
        }
        const omitted = await adapter.captureAssetSources!({ ...base, moduleIds: [] })
        const explicitEmpty = await adapter.captureAssetSources!({
            ...base, moduleIds: [], moduleIdsSpecified: true,
        })
        expect(omitted.assets.filter(({ origin }) => origin.kind === 'module')).toHaveLength(3)
        expect(explicitEmpty.assets.filter(({ origin }) => origin.kind === 'module')).toHaveLength(0)
    })

    it('bounds real-size Host first-capture and final-probe work to selected modules and assets', async () => {
        const counters = {
            fullStateCalls: 0,
            moduleMaterializations: 0,
            moduleMetadataVisits: 0,
            moduleCollectionProbes: 0,
            modulePhysicalReads: 0,
            cachedModuleEmissions: 0,
            finalModuleEmissions: 0,
        }
        const countedModule = (id: string, assetCount: number) => {
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
        const unrelated = countedModule('unrelated', 1_553)
        const deps = dependencies({
            getDatabase: () => ({ characters: [current], modules: [selected, unrelated] }),
            getCurrentCharacter: () => current,
            getCurrentChat: () => current.chats[0],
            getActiveModulesWithReasons: () => [],
            getAssetStorageRevision: (storageKey) => {
                counters.moduleMetadataVisits += 1
                return `revision:${storageKey}:1`
            },
            readImage: async () => {
                counters.modulePhysicalReads += 1
                return new Uint8Array([1])
            },
        })
        const adapter = createRisuContextResourceAdapter(deps)
        const revalidateModuleCollection = adapter.revalidateModuleCollection!.bind(adapter)
        adapter.revalidateModuleCollection = async (probe) => {
            counters.moduleCollectionProbes += 1
            return revalidateModuleCollection(probe)
        }
        const originalGetState = adapter.getState
        adapter.getState = async () => {
            counters.fullStateCalls += 1
            return originalGetState()
        }
        const moduleService = new ContextResourceService(
            {
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: 'real-size-module-workload',
                displayName: 'Real-size module workload',
                signal: new AbortController().signal,
            },
            adapter,
            {
                requirePermission: async () => undefined,
                cursorRegistry: new CursorRegistry(),
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const firstModules = await moduleService.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 100,
        })
        counters.cachedModuleEmissions = firstModules.items.length
        const finalModules = await moduleService.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query',
            captureRevision: firstModules.captureRevision, limit: 1,
        })
        counters.finalModuleEmissions = finalModules.items.length
        const moduleWork = {
            materializations: counters.moduleMaterializations,
            metadataVisits: counters.moduleMetadataVisits,
            collectionProbes: counters.moduleCollectionProbes,
            physicalReads: counters.modulePhysicalReads,
        }
        moduleService.dispose()

        const M = 2
        const S = 4_003
        expect(counters.fullStateCalls).toBe(0)
        expect(moduleWork.materializations).toBeLessThanOrEqual(2 * M)
        expect(moduleWork.metadataVisits).toBeLessThanOrEqual(2 * S)
        expect(moduleWork.collectionProbes).toBe(0)
        expect(moduleWork.physicalReads).toBe(0)
        expect(counters.cachedModuleEmissions).toBe(M)
        expect(counters.finalModuleEmissions).toBeLessThanOrEqual(1)

        const runAssetQuery = async (
            include: Array<'portrait' | 'emotion' | 'additional' | 'module'>,
            N: number,
            instanceId: string,
        ) => {
            const queryCounters = {
                fullStateCalls: 0,
                assetMaterializations: 0,
                cachedAssetEmissions: 0,
                fullCollectionFenceModuleProjections: 0,
                finalAssetEmissions: 0,
                targetedAssetProbes: 0,
                physicalReads: 0,
                digests: 0,
                finalProbePhysicalReads: 0,
                activeReads: 0,
                maxPhysicalReads: 0,
                unselectedSourceMaterializations: 0,
                unselectedMetadataProjections: 0,
                unselectedDigests: 0,
                unselectedStorageReads: 0,
            }
            let fullCollectionFenceActive = false
            const queryCurrent = makeCharacter({
                image: 'assets/card-portrait.png',
                emotionImages: [['card-emotion', 'assets/card-emotion.png']],
                additionalAssets: [],
                ccAssets: [],
            })
            const queryCountedModule = (id: string, assetCount: number, unselected = false) => {
                const module = makeModule(id, {
                    assets: Array.from({ length: assetCount }, (_, index) => [
                        `${id}-${index}`, `assets/${id}-${index}.png`, 'png',
                    ]),
                })
                const lorebook = module.lorebook
                Object.defineProperty(module, 'lorebook', {
                    enumerable: true,
                    get() {
                        if (unselected) queryCounters.unselectedSourceMaterializations += 1
                        return lorebook
                    },
                })
                return module
            }
            const querySelected = queryCountedModule('selected', 2_450)
            const queryUnrelated = queryCountedModule('unrelated', 1_553, true)
            const selectedAssets = querySelected.assets
            querySelected.assets = new Proxy(selectedAssets, {
                get(target, property, receiver) {
                    if (fullCollectionFenceActive
                        && typeof property === 'string'
                        && /^(0|[1-9][0-9]*)$/.test(property)) {
                        queryCounters.fullCollectionFenceModuleProjections += 1
                    }
                    return Reflect.get(target, property, receiver)
                },
            })
            const queryAdapter = createRisuContextResourceAdapter(dependencies({
                getDatabase: () => ({
                    characters: [queryCurrent], modules: [querySelected, queryUnrelated],
                }),
                getCurrentCharacter: () => queryCurrent,
                getCurrentChat: () => queryCurrent.chats[0],
                getActiveModulesWithReasons: () => [],
                getAssetStorageRevision: (storageKey) => {
                    if (storageKey.includes('unrelated')) {
                        queryCounters.unselectedMetadataProjections += 1
                    }
                    return `revision:${storageKey}:1`
                },
                readImage: async (storageKey) => {
                    queryCounters.physicalReads += 1
                    queryCounters.digests += 1
                    queryCounters.activeReads += 1
                    queryCounters.maxPhysicalReads = Math.max(
                        queryCounters.maxPhysicalReads, queryCounters.activeReads,
                    )
                    if (storageKey.includes('unrelated')) {
                        queryCounters.unselectedDigests += 1
                        queryCounters.unselectedStorageReads += 1
                    }
                    await Promise.resolve()
                    queryCounters.activeReads -= 1
                    return new Uint8Array([1])
                },
            }))
            const getState = queryAdapter.getState.bind(queryAdapter)
            queryAdapter.getState = async () => {
                queryCounters.fullStateCalls += 1
                return getState()
            }
            const captureAssets = queryAdapter.captureAssetSources!.bind(queryAdapter)
            let captureCalls = 0
            queryAdapter.captureAssetSources = async (input) => {
                const captured = await captureAssets(input)
                captureCalls += 1
                queryCounters.assetMaterializations += captured.assets.length
                return captured
            }
            const revalidateAsset = queryAdapter.revalidateAssetSource!.bind(queryAdapter)
            queryAdapter.revalidateAssetSource = async (probe) => {
                queryCounters.targetedAssetProbes += 1
                return revalidateAsset(probe)
            }
            const revalidateAssetCollection = queryAdapter.revalidateAssetCollection!.bind(queryAdapter)
            queryAdapter.revalidateAssetCollection = async (probe) => {
                fullCollectionFenceActive = true
                try {
                    return await revalidateAssetCollection(probe)
                } finally {
                    fullCollectionFenceActive = false
                }
            }
            const service = new ContextResourceService(
                {
                    principalId: '11111111-1111-4111-8111-111111111111',
                    instanceId,
                    displayName: 'Real-size asset workload',
                    signal: new AbortController().signal,
                },
                queryAdapter,
                {
                    requirePermission: async () => undefined,
                    cursorRegistry: new CursorRegistry(),
                    queryCaptureCache: new QueryCaptureCache(),
                    readCoordinator: new ContextAssetReadCoordinator(),
                },
            )
            const first = await service.listContextAssets({
                moduleScope: 'installed', moduleIds: ['selected'], include,
                captureScope: 'query', limit: 100,
            })
            expect(first.captureRevision).toMatch(/^sha256:[0-9a-f]{64}$/)
            const readsAfterCapture = queryCounters.physicalReads
            const digestsAfterCapture = queryCounters.digests
            let page = first
            let pageCount = 1
            queryCounters.cachedAssetEmissions += page.assets.length
            while (page.nextCursor) {
                page = await service.listContextAssets({
                    moduleScope: 'installed', moduleIds: ['selected'], include,
                    captureScope: 'query', captureRevision: first.captureRevision,
                    cursor: page.nextCursor, limit: 100,
                })
                pageCount += 1
                queryCounters.cachedAssetEmissions += page.assets.length
            }
            const final = await service.listContextAssets({
                moduleScope: 'installed', moduleIds: ['selected'], include,
                captureScope: 'query', captureRevision: first.captureRevision, limit: 1,
            })
            queryCounters.finalAssetEmissions = final.assets.length
            queryCounters.finalProbePhysicalReads = queryCounters.physicalReads - readsAfterCapture

            expect(queryCounters.fullStateCalls).toBe(0)
            expect(captureCalls).toBe(2)
            expect(queryCounters.assetMaterializations).toBe(2 * N)
            expect(pageCount).toBeGreaterThan(1)
            expect(queryCounters.fullCollectionFenceModuleProjections).toBe(2 * 2_450)
            expect(queryCounters.cachedAssetEmissions).toBe(N)
            expect(queryCounters.finalAssetEmissions).toBeLessThanOrEqual(1)
            expect(queryCounters.targetedAssetProbes).toBe(3 * N - first.assets.length)
            expect(readsAfterCapture).toBe(N)
            expect(digestsAfterCapture).toBe(N)
            expect(queryCounters.finalProbePhysicalReads).toBe(0)
            expect(queryCounters.unselectedStorageReads).toBe(0)
            expect(queryCounters.maxPhysicalReads).toBeLessThanOrEqual(4)
            expect(queryCounters.unselectedSourceMaterializations).toBe(0)
            expect(queryCounters.unselectedMetadataProjections).toBe(0)
            expect(queryCounters.unselectedDigests).toBe(0)
            service.dispose()
        }

        await runAssetQuery(
            ['portrait', 'emotion', 'additional', 'module'], 2_452, 'real-size-card-assets',
        )
        await runAssetQuery(['module'], 2_450, 'real-size-module-assets')
    }, 30_000)

    it('bounds a later module cursor page to its selected nested slots', async () => {
        const current = makeCharacter()
        const modules = [
            makeModule('first', {
                assets: Array.from({ length: 2_450 }, (_, index) => [
                    `first-${index}`, `assets/first-${index}.png`, 'png',
                ]),
            }),
            makeModule('second', {
                assets: Array.from({ length: 1_553 }, (_, index) => [
                    `second-${index}`, `assets/second-${index}.png`, 'png',
                ]),
            }),
        ]
        let metadataVisits = 0
        let physicalReads = 0
        const permissionCalls: string[] = []
        const service = new ContextResourceService(
            {
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: 'real-size-module-cursor-workload',
                displayName: 'Real-size module cursor workload',
                signal: new AbortController().signal,
            },
            createRisuContextResourceAdapter(dependencies({
                getDatabase: () => ({ characters: [current], modules }),
                getCurrentCharacter: () => current,
                getCurrentChat: () => current.chats[0],
                getActiveModulesWithReasons: () => [],
                getAssetStorageRevision: (storageKey) => {
                    metadataVisits += 1
                    return `revision:${storageKey}:1`
                },
                readImage: async () => {
                    physicalReads += 1
                    return new Uint8Array([1])
                },
            })),
            {
                requirePermission: async (permission) => { permissionCalls.push(permission) },
                cursorRegistry: new CursorRegistry(),
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const first = await service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 1,
        })
        expect(first.nextCursor).toBeTypeOf('string')
        metadataVisits = 0
        permissionCalls.length = 0

        const second = await service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query',
            cursor: first.nextCursor, limit: 1,
        })

        expect(second.items.map((item) => item.id)).toEqual(['second'])
        expect(metadataVisits).toBeLessThanOrEqual(1_553)
        expect(permissionCalls).toEqual([
            'installedModulesRead', 'contextAssets', 'installedModulesRead', 'contextAssets',
        ])
        expect(physicalReads).toBe(0)
        service.dispose()
    }, 30_000)

    it('rejects a later module page when its raw source changes before the final synchronous probe', async () => {
        const current = makeCharacter()
        const modules = [makeModule('first'), makeModule('second'), makeModule('third')]
        const cursorRegistry = new CursorRegistry()
        const adapter = createRisuContextResourceAdapter(dependencies({
            getDatabase: () => ({ characters: [current], modules }),
            getCurrentCharacter: () => current,
            getCurrentChat: () => current.chats[0],
            getActiveModulesWithReasons: () => [],
        }))
        type CollectionProbe = Parameters<NonNullable<typeof adapter.revalidateModuleCollection>>[0]
        type ModuleSource = Parameters<NonNullable<typeof adapter.revalidateModuleSource>>[0]['source']
        const nativeAdapter = adapter as typeof adapter & {
            revalidateModulePageSynchronously?: (
                probe: CollectionProbe & { pageSources: readonly ModuleSource[] },
            ) => void
        }
        const service = new ContextResourceService(
            {
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: 'module-page-source-linearization',
                displayName: 'Module page source linearization',
                signal: new AbortController().signal,
            },
            adapter,
            {
                requirePermission: async () => undefined,
                cursorRegistry,
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const first = await service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        })
        expect(first.nextCursor).toBeTypeOf('string')

        let mutated = false
        const mutateBeforeFinalProbe = () => {
            if (mutated) return
            mutated = true
            modules[1].name = 'changed before final synchronous probe'
        }
        if (nativeAdapter.revalidateModulePageSynchronously) {
            const revalidate = nativeAdapter.revalidateModulePageSynchronously.bind(nativeAdapter)
            nativeAdapter.revalidateModulePageSynchronously = (probe) => {
                mutateBeforeFinalProbe()
                revalidate(probe)
            }
        } else {
            const revalidate = adapter.revalidateModuleSource!.bind(adapter)
            adapter.revalidateModuleSource = async (probe) => {
                const source = await revalidate(probe)
                queueMicrotask(mutateBeforeFinalProbe)
                return source
            }
        }

        await expect(service.listContextModules({
            scope: 'installed', captureScope: 'query', cursor: first.nextCursor, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(mutated).toBe(true)
        expect(cursorRegistry.activeCount('11111111-1111-4111-8111-111111111111')).toBe(0)
        service.dispose()
    })

    it('rejects a later module page when permission generation resets before the final synchronous probe', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const current = makeCharacter()
        const modules = [makeModule('first'), makeModule('second'), makeModule('third')]
        let permissionGeneration = 0
        const cursorRegistry = new CursorRegistry()
        const adapter = createRisuContextResourceAdapter(dependencies({
            getDatabase: () => ({ characters: [current], modules }),
            getCurrentCharacter: () => current,
            getCurrentChat: () => current.chats[0],
            getActiveModulesWithReasons: () => [],
        }))
        type CollectionProbe = Parameters<NonNullable<typeof adapter.revalidateModuleCollection>>[0]
        type ModuleSource = Parameters<NonNullable<typeof adapter.revalidateModuleSource>>[0]['source']
        const nativeAdapter = adapter as typeof adapter & {
            revalidateModulePageSynchronously?: (
                probe: CollectionProbe & { pageSources: readonly ModuleSource[] },
            ) => void
        }
        const service = new ContextResourceService(
            {
                principalId,
                instanceId: 'module-page-generation-linearization',
                displayName: 'Module page generation linearization',
                signal: new AbortController().signal,
            },
            adapter,
            {
                requirePermission: async () => undefined,
                getPermissionGeneration: () => permissionGeneration,
                cursorRegistry,
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const first = await service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        })
        expect(first.nextCursor).toBeTypeOf('string')

        let reset = false
        const resetBeforeFinalProbe = () => {
            if (reset) return
            reset = true
            permissionGeneration += 1
        }
        if (nativeAdapter.revalidateModulePageSynchronously) {
            const revalidate = nativeAdapter.revalidateModulePageSynchronously.bind(nativeAdapter)
            nativeAdapter.revalidateModulePageSynchronously = (probe) => {
                resetBeforeFinalProbe()
                revalidate(probe)
            }
        } else {
            const revalidate = adapter.revalidateModuleSource!.bind(adapter)
            adapter.revalidateModuleSource = async (probe) => {
                const source = await revalidate(probe)
                queueMicrotask(resetBeforeFinalProbe)
                return source
            }
        }

        await expect(service.listContextModules({
            scope: 'installed', captureScope: 'query', cursor: first.nextCursor, limit: 1,
        })).rejects.toMatchObject({ code: 'ABORTED', retryable: false })
        expect(reset).toBe(true)
        expect(cursorRegistry.activeCount(principalId)).toBe(0)
        service.dispose()
    })

    it('commits a later module cursor before microtasks queued by the final synchronous probe', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const current = makeCharacter()
        const modules = [makeModule('first'), makeModule('second'), makeModule('third')]
        const cursorRegistry = new CursorRegistry()
        const adapter = createRisuContextResourceAdapter(dependencies({
            getDatabase: () => ({ characters: [current], modules }),
            getCurrentCharacter: () => current,
            getCurrentChat: () => current.chats[0],
            getActiveModulesWithReasons: () => [],
        }))
        type CollectionProbe = Parameters<NonNullable<typeof adapter.revalidateModuleCollection>>[0]
        type ModuleSource = Parameters<NonNullable<typeof adapter.revalidateModuleSource>>[0]['source']
        const nativeAdapter = adapter as typeof adapter & {
            revalidateModulePageSynchronously?: (
                probe: CollectionProbe & { pageSources: readonly ModuleSource[] },
            ) => void
        }
        const service = new ContextResourceService(
            {
                principalId,
                instanceId: 'module-page-hook-commit-order',
                displayName: 'Module page hook commit order',
                signal: new AbortController().signal,
            },
            adapter,
            {
                requirePermission: async () => undefined,
                cursorRegistry,
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const first = await service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        })
        expect(first.nextCursor).toBeTypeOf('string')
        expect(nativeAdapter.revalidateModulePageSynchronously).toBeTypeOf('function')
        if (!nativeAdapter.revalidateModulePageSynchronously) return

        let queuedMutationRan = false
        let mutationObservedAtCursorCommit: boolean | undefined
        const revalidate = nativeAdapter.revalidateModulePageSynchronously.bind(nativeAdapter)
        nativeAdapter.revalidateModulePageSynchronously = (probe) => {
            revalidate(probe)
            queueMicrotask(() => { queuedMutationRan = true })
        }
        const commitPrepared = cursorRegistry.commitPrepared.bind(cursorRegistry)
        vi.spyOn(cursorRegistry, 'commitPrepared').mockImplementation((preparation, value, commit) => {
            mutationObservedAtCursorCommit = queuedMutationRan
            return commitPrepared(preparation, value, commit)
        })

        const second = await service.listContextModules({
            scope: 'installed', captureScope: 'query', cursor: first.nextCursor, limit: 1,
        })

        expect(second.items.map((item) => item.id)).toEqual(['second'])
        expect(second.nextCursor).toBeTypeOf('string')
        expect(mutationObservedAtCursorCommit).toBe(false)
        expect(queuedMutationRan).toBe(true)
        service.dispose()
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

    it('binds an omitted-selector asset cursor to the context resolved on its first page', async () => {
        const firstCharacter = makeCharacter()
        const secondCharacter = makeCharacter({
            chaId: 'char-2',
            name: 'Bob',
            image: 'assets/bob.png',
            chats: [{ ...makeChat(), id: 'conversation-2' }],
        })
        let currentCharacter = firstCharacter
        const adapter = createRisuContextResourceAdapter(dependencies({
            getDatabase: () => ({ characters: [firstCharacter, secondCharacter], modules: [] }),
            getCurrentCharacter: () => currentCharacter,
            getCurrentChat: () => currentCharacter.chats[0],
            getActiveModulesWithReasons: () => [],
        }))
        const service = new ContextResourceService(
            {
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: 'selector-bound-cursor-instance',
                displayName: 'Selector-bound cursor',
                signal: new AbortController().signal,
            },
            adapter,
            {
                requirePermission: async () => undefined,
                cursorRegistry: new CursorRegistry(),
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const first = await service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })
        expect(first.nextCursor).toBeTypeOf('string')

        currentCharacter = secondCharacter
        await expect(service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', cursor: first.nextCursor, limit: 1,
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: 'Invalid or expired cursor' })
        service.dispose()
    })

    it('rejects a later asset cursor page when its emitted raw slot storage revision changes', async () => {
        const character = makeCharacter()
        const storageRevisions = new Map<string, number>()
        const adapter = createRisuContextResourceAdapter(dependencies({
            getDatabase: () => ({ characters: [character], modules: [] }),
            getCurrentCharacter: () => character,
            getCurrentChat: () => character.chats[0],
            getActiveModulesWithReasons: () => [],
            getAssetStorageRevision: (storageKey) =>
                `revision:${storageKey}:${storageRevisions.get(storageKey) ?? 1}`,
        }))
        const service = new ContextResourceService(
            {
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: 'asset-page-storage-revision-fence',
                displayName: 'Asset page storage revision fence',
                signal: new AbortController().signal,
            },
            adapter,
            {
                requirePermission: async () => undefined,
                cursorRegistry: new CursorRegistry(),
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const first = await service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })
        expect(first.nextCursor).toBeTypeOf('string')
        storageRevisions.set('assets/happy.webp', 2)

        await expect(service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', captureRevision: first.captureRevision,
            cursor: first.nextCursor, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        service.dispose()
    })

    it.each([
        ['append', (modules: Record<string, any>[]) => modules.push(makeModule('module-appended'))],
        ['delete', (modules: Record<string, any>[]) => modules.splice(2, 1)],
        ['reorder', (modules: Record<string, any>[]) => modules.splice(1, 2, modules[2], modules[1])],
    ])('atomically captures installed-module membership changed by %s during publication permission', async (_change, mutate) => {
        const character = makeCharacter()
        const modules = [makeModule('module-first'), makeModule('module-second'), makeModule('module-third')]
        const baselineService = new ContextResourceService(
            {
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: `module-collection-baseline-${_change}`,
                displayName: 'Module collection baseline',
                signal: new AbortController().signal,
            },
            createRisuContextResourceAdapter(dependencies({
                getDatabase: () => ({ characters: [character], modules }),
                getCurrentCharacter: () => character,
                getCurrentChat: () => character.chats[0],
                getActiveModulesWithReasons: () => [],
            })),
            {
                requirePermission: async () => undefined,
                cursorRegistry: new CursorRegistry(),
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const baseline = await baselineService.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 100,
        })
        baselineService.dispose()

        const publicationGate = deferred<void>()
        let publicationEntered = false
        let permissionCalls = 0
        const service = new ContextResourceService(
            {
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: `module-collection-fence-${_change}`,
                displayName: 'Module collection fence',
                signal: new AbortController().signal,
            },
            createRisuContextResourceAdapter(dependencies({
                getDatabase: () => ({ characters: [character], modules }),
                getCurrentCharacter: () => character,
                getCurrentChat: () => character.chats[0],
                getActiveModulesWithReasons: () => [],
            })),
            {
                requirePermission: async () => {
                    permissionCalls += 1
                    if (permissionCalls === 2) {
                        publicationEntered = true
                        await publicationGate.promise
                    }
                },
                cursorRegistry: new CursorRegistry(),
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const listing = service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        })
        await waitFor(() => publicationEntered)
        mutate(modules)
        publicationGate.resolve()

        const first = await listing
        expect(first.captureRevision).not.toBe(baseline.captureRevision)
        const remainder = await service.listContextModules({
            scope: 'installed', captureScope: 'query', cursor: first.nextCursor, limit: 100,
        })
        expect([...first.items, ...remainder.items].map((module) => module.id))
            .toEqual(modules.map((module) => module.id))
        await expect(service.listContextModules({
            scope: 'installed', captureScope: 'query', captureRevision: baseline.captureRevision, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        service.dispose()
    })

    it('publishes the post-permission module revision atomically and rejects an older final probe', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const character = makeCharacter()
        const modules = [makeModule('module-first'), makeModule('module-second')]
        const baselineService = new ContextResourceService(
            {
                principalId,
                instanceId: 'module-storage-revision-baseline',
                displayName: 'Module storage revision baseline',
                signal: new AbortController().signal,
            },
            createRisuContextResourceAdapter(dependencies({
                getDatabase: () => ({ characters: [character], modules }),
                getCurrentCharacter: () => character,
                getCurrentChat: () => character.chats[0],
                getActiveModulesWithReasons: () => [],
            })),
            {
                requirePermission: async () => undefined,
                cursorRegistry: new CursorRegistry(),
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const baseline = await baselineService.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 100,
        })
        baselineService.dispose()

        const cursorRegistry = new CursorRegistry()
        const publicationGate = deferred<void>()
        let publicationEntered = false
        let permissionCalls = 0
        const storageRevisions = new Map<string, number>()
        let physicalReads = 0
        const service = new ContextResourceService(
            {
                principalId,
                instanceId: 'module-storage-revision-fence',
                displayName: 'Module storage revision fence',
                signal: new AbortController().signal,
            },
            createRisuContextResourceAdapter(dependencies({
                getDatabase: () => ({ characters: [character], modules }),
                getCurrentCharacter: () => character,
                getCurrentChat: () => character.chats[0],
                getActiveModulesWithReasons: () => [],
                getAssetStorageRevision: (storageKey) =>
                    `revision:${storageKey}:${storageRevisions.get(storageKey) ?? 1}`,
                readImage: async () => {
                    physicalReads += 1
                    return new Uint8Array([1])
                },
            })),
            {
                requirePermission: async () => {
                    permissionCalls += 1
                    if (permissionCalls === 3) {
                        publicationEntered = true
                        await publicationGate.promise
                    }
                },
                cursorRegistry,
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const listing = service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 1,
        })
        await waitFor(() => publicationEntered)
        storageRevisions.set('assets/module-second.png', 2)
        publicationGate.resolve()

        const current = await listing
        expect(current.captureRevision).not.toBe(baseline.captureRevision)
        expect(current.nextCursor).toBeTypeOf('string')
        expect(cursorRegistry.activeCount(principalId)).toBe(1)

        await expect(service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query',
            captureRevision: baseline.captureRevision, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(cursorRegistry.activeCount(principalId)).toBe(1)

        const changed = await service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query',
            cursor: current.nextCursor, limit: 1,
        })
        expect(changed.items[0].assetCollectionRevision)
            .not.toBe(baseline.items[1].assetCollectionRevision)
        expect(physicalReads).toBe(0)
        expect(permissionCalls).toBe(12)
        service.dispose()
    })

    it.each([
        ['append', (character: Record<string, any>) => {
            character.additionalAssets.push(['appended', 'assets/appended.png', 'png'])
        }],
        ['delete', (character: Record<string, any>) => character.ccAssets.splice(1, 1)],
        ['reorder', (character: Record<string, any>) => character.ccAssets.reverse()],
    ])('rejects an asset page when off-page membership changes by %s before publication', async (_change, mutate) => {
        const character = makeCharacter()
        const publicationGate = deferred<void>()
        let publicationEntered = false
        let permissionCalls = 0
        const service = new ContextResourceService(
            {
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: `asset-collection-fence-${_change}`,
                displayName: 'Asset collection fence',
                signal: new AbortController().signal,
            },
            createRisuContextResourceAdapter(dependencies({
                getDatabase: () => ({ characters: [character], modules: [] }),
                getCurrentCharacter: () => character,
                getCurrentChat: () => character.chats[0],
                getActiveModulesWithReasons: () => [],
            })),
            {
                requirePermission: async () => {
                    permissionCalls += 1
                    if (permissionCalls === 7) {
                        publicationEntered = true
                        await publicationGate.promise
                    }
                },
                cursorRegistry: new CursorRegistry(),
                queryCaptureCache: new QueryCaptureCache(),
            },
        )
        const listing = service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })
        await waitFor(() => publicationEntered)
        mutate(character)
        publicationGate.resolve()

        await expect(listing).rejects.toMatchObject({ code: 'CONFLICT' })
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
