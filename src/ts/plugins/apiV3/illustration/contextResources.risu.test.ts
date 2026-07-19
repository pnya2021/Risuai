import { describe, expect, it, vi } from 'vitest'
import {
    createBoundedContextThumbnail,
    createRisuContextResourceAdapter,
    parseImageDimensions,
    type RisuContextAdapterDependencies,
} from './contextResources.risu'

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
