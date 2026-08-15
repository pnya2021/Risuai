import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from './database.svelte'

const durable = vi.hoisted(() => ({
    values: new Map<string, unknown>(),
    databaseWrites: [] as Uint8Array[],
}))

vi.mock('./autoStorage', () => ({
    AutoStorage: class {
        isAccount = false
        async getItem(key: string) { return durable.values.get(key) ?? null }
        async setItem(key: string, value: unknown) {
            durable.values.set(key, value)
            if (key === 'database/database.bin') {
                durable.databaseWrites.push(new Uint8Array(value as Uint8Array))
            }
        }
        async removeItem(key: string) { durable.values.delete(key) }
        async keys() { return [...durable.values.keys()] }
    },
}))
vi.mock('../drive/drive', () => ({ checkDriverInit: vi.fn(), syncDrive: vi.fn() }))
vi.mock('../kei/backup', () => ({ autoServerBackup: vi.fn(), saveDbKei: vi.fn() }))
vi.mock('../observer.svelte', () => ({ startObserveDom: vi.fn() }))
vi.mock('../hotkey', () => ({ initMobileGesture: vi.fn() }))
vi.mock('../process/modules', () => ({ moduleUpdate: vi.fn() }))
vi.mock('../parser/parser.svelte', () => ({
    applyMarkdownToNode: vi.fn(),
    assetRegex: /$^/,
    hasher: vi.fn().mockResolvedValue('hash'),
    risuChatParser: vi.fn(),
    risuEscape: vi.fn((value: string) => value),
    risuUnescape: vi.fn((value: string) => value),
}))
vi.mock('../plugins/apiV3/v3.svelte', () => ({ loadV3Plugins: vi.fn() }))

const database = (values: Partial<Database> = {}): Database => ({
    username: 'fixture user',
    characters: [],
    botPresets: [],
    modules: [],
    loadouts: [],
    plugins: [],
    pluginCustomStorage: {},
    nanogptRequestModel: 'hf:moonshotai/Kimi-K2.5',
    nanogptRequestModelName: 'Kimi K2.5',
    nanogptProvider: 'deepinfra',
    ...values,
}) as Database

let databaseModule: typeof import('./database.svelte')
let globalApi: typeof import('../globalApi.svelte')
let plugins: typeof import('../plugins/plugins.svelte')
let saveFormat: typeof import('./risuSave')
let stores: typeof import('../stores.svelte')
let createRevision: typeof import('../plugins/apiV3/illustration/revision').createRevision
let messageRevisionValue: typeof import('../plugins/apiV3/illustration/messageQuery').messageRevisionValue

const messageTarget = {
    characterId: 'character-1',
    conversationId: 'conversation-1',
    messageId: 'message-1',
}

const databaseWithMessage = (messageData: string, values: Partial<Database> = {}) => database({
    characters: [{
        type: 'character',
        chaId: messageTarget.characterId,
        chatPage: 0,
        chats: [{
            id: messageTarget.conversationId,
            message: [{ role: 'char', data: messageData, chatId: messageTarget.messageId }],
        }],
    }] as Database['characters'],
    ...values,
})

async function advanceUntil(predicate: () => boolean, message: string) {
    try {
        await vi.waitUntil(async () => {
            await vi.advanceTimersByTimeAsync(250)
            return predicate()
        }, { interval: 10, timeout: 4_000 })
    } catch {
        throw new Error(message)
    }
}

async function reload(bytes: Uint8Array) {
    return saveFormat.decodeRisuSave(bytes)
}

describe.sequential('database persistence consumer boundary', () => {
    beforeAll(async () => {
        vi.useFakeTimers()
        await import('../polyfill')
        globalApi = await import('../globalApi.svelte')
        databaseModule = await import('./database.svelte')
        plugins = await import('../plugins/plugins.svelte')
        saveFormat = await import('./risuSave')
        stores = await import('../stores.svelte')
        ;({ createRevision } = await import('../plugins/apiV3/illustration/revision'))
        ;({ messageRevisionValue } = await import('../plugins/apiV3/illustration/messageQuery'))
        databaseModule.setDatabaseLite(database())
        void globalApi.saveDb()
        await advanceUntil(() => durable.databaseWrites.length > 0, 'background save did not reach durable storage')
    }, 30_000)

    beforeEach(() => {
        durable.databaseWrites.length = 0
    })

    afterAll(() => {
        vi.useRealTimers()
    })

    it('does not reschedule a database save from its own committed snapshot', async () => {
        stores.DBState.db.username = 'one durable save'
        await advanceUntil(() => durable.databaseWrites.length === 1, 'mutation did not produce a durable save')
        await vi.advanceTimersByTimeAsync(2_000)

        expect(durable.databaseWrites).toHaveLength(1)
        expect((await reload(durable.databaseWrites[0])).username).toBe('one durable save')
    })

    it('preserves model settings across programmatic database replacement and restore', async () => {
        const api = plugins.getV2PluginAPIs(() => true, () => true)
        const replacement = api.getDatabase()
        replacement.username = 'programmatic replacement'
        await api.setDatabase(replacement)
        const restored = structuredClone(databaseModule.getDatabase({ snapshot: true }))
        restored.username = 'restored snapshot'
        await globalApi.replaceAndPersistDatabaseWithPluginRuntime(restored)

        expect({
            model: stores.DBState.db.nanogptRequestModel,
            name: stores.DBState.db.nanogptRequestModelName,
            provider: stores.DBState.db.nanogptProvider,
        }).toEqual({
            model: 'hf:moonshotai/Kimi-K2.5',
            name: 'Kimi K2.5',
            provider: 'deepinfra',
        })
    })

    it('persists a V2 descriptor-backed write across save and reload', async () => {
        stores.DBState.db.pluginCustomStorage.legacyPlugin = { nested: 'before' }
        const api = plugins.getV2PluginAPIs(() => true, () => true)
        const replacement = api.getDatabase()
        const descriptor = Object.getOwnPropertyDescriptor(replacement, 'legacyPlugin')
        expect(descriptor).toBeDefined()
        descriptor!.value.nested = 'descriptor value'

        await api.setDatabase(replacement)
        await advanceUntil(() => durable.databaseWrites.length > 0, 'V2 replacement did not reach durable storage')

        const reloaded = await reload(durable.databaseWrites.at(-1)!)
        expect(reloaded.pluginCustomStorage.legacyPlugin.nested).toBe('descriptor value')
    })

    it('keeps a waiter that arrives during encoder reload for the next database snapshot', async () => {
        stores.selectedCharID.set(0)
        databaseModule.setDatabaseLite(databaseWithMessage('before reload'))
        globalApi.requiresFullEncoderReload.state = true
        globalApi.requestDatabaseSaveNow()
        await advanceUntil(() => durable.databaseWrites.length > 0, 'waiter fixture did not reach durable storage')
        durable.databaseWrites.length = 0

        let releaseInitialization!: () => void
        const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve })
        let markInitializationStarted!: () => void
        const initializationStarted = new Promise<void>((resolve) => { markInitializationStarted = resolve })
        const originalInit = saveFormat.RisuSaveEncoder.prototype.init
        const init = vi.spyOn(saveFormat.RisuSaveEncoder.prototype, 'init')
            .mockImplementationOnce(async function (...args) {
                markInitializationStarted()
                await initializationGate
                return originalInit.apply(this, args)
            })

        let newerStatus: 'pending' | 'resolved' | 'rejected' = 'pending'
        try {
            const message = stores.DBState.db.characters[0].chats[0].message[0]
            const beforeRevision = await createRevision(messageRevisionValue(message))
            const beforePersistence = globalApi.waitForMessagePersistence(messageTarget, beforeRevision)
            await vi.advanceTimersByTimeAsync(1_000)
            await initializationStarted

            message.data = 'after reload'
            const afterRevision = await createRevision(messageRevisionValue(message))
            const afterPersistence = globalApi.waitForMessagePersistence(messageTarget, afterRevision)
                .then(() => { newerStatus = 'resolved' as const }, () => { newerStatus = 'rejected' as const })

            releaseInitialization()
            await advanceUntil(() => newerStatus !== 'pending', 'new waiter was not completed by a later save candidate')
            await beforePersistence
            await afterPersistence

            expect(newerStatus).toBe('resolved')
            const reloaded = await reload(durable.databaseWrites.at(-1)!)
            expect(reloaded.characters[0].chats[0].message[0].data).toBe('after reload')
        } finally {
            releaseInitialization()
            init.mockRestore()
        }
    })

    it('orders V2 live replacement after an in-flight save and reloads every character block', async () => {
        stores.selectedCharID.set(-1)
        databaseModule.setDatabaseLite(databaseWithMessage('before replacement', { temperature: 80 }))
        globalApi.requiresFullEncoderReload.state = true
        globalApi.requestDatabaseSaveNow()
        await advanceUntil(() => durable.databaseWrites.length > 0, 'replacement fixture did not reach durable storage')
        await vi.advanceTimersByTimeAsync(2_000)
        durable.databaseWrites.length = 0

        let releaseWrite!: () => void
        const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
        let markWriteStarted!: () => void
        const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve })
        const originalSetItem = globalApi.forageStorage.setItem.bind(globalApi.forageStorage)
        let blocked = false
        const setItem = vi.spyOn(globalApi.forageStorage, 'setItem').mockImplementation(async (key, value) => {
            if (!blocked && key === 'database/database.bin') {
                blocked = true
                markWriteStarted()
                await writeGate
            }
            return originalSetItem(key, value)
        })

        let replacement: Promise<unknown> | undefined
        try {
            stores.DBState.db.temperature = 81
            globalApi.requestDatabaseSaveNow()
            await vi.advanceTimersByTimeAsync(1_000)
            await writeStarted

            const api = plugins.getV2PluginAPIs(() => true, () => true)
            const next = api.getDatabase()
            next.temperature = 42
            next.characters[0].chats[0].message[0].data = 'winning V2 character bytes'
            let replacementSettled = false
            replacement = api.setDatabase(next).then(() => { replacementSettled = true })
            await vi.advanceTimersByTimeAsync(0)
            for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve()
            const observedBeforeWriteRelease = {
                replacementSettled,
                temperature: stores.DBState.db.temperature,
                message: stores.DBState.db.characters[0].chats[0].message[0].data,
            }

            releaseWrite()
            await replacement
            await advanceUntil(() => durable.databaseWrites.length >= 2, 'V2 replacement did not publish a fresh database')

            expect(observedBeforeWriteRelease).toEqual({
                replacementSettled: false,
                temperature: 81,
                message: 'before replacement',
            })
            const reloaded = await reload(durable.databaseWrites.at(-1)!)
            expect({
                temperature: reloaded.temperature,
                message: reloaded.characters[0].chats[0].message[0].data,
            }).toEqual({
                temperature: 42,
                message: 'winning V2 character bytes',
            })
        } finally {
            releaseWrite()
            await replacement?.catch(() => undefined)
            setItem.mockRestore()
        }
    })

    it('does not publish a snapshot captured before a winning restore generation', async () => {
        let releaseEncoding!: () => void
        const encodingGate = new Promise<void>((resolve) => { releaseEncoding = resolve })
        let encodingStarted!: () => void
        const started = new Promise<void>((resolve) => { encodingStarted = resolve })
        const originalSet = saveFormat.RisuSaveEncoder.prototype.set
        const set = vi.spyOn(saveFormat.RisuSaveEncoder.prototype, 'set')
            .mockImplementationOnce(async function (...args) {
                encodingStarted()
                await encodingGate
                return originalSet.apply(this, args)
            })

        try {
            stores.DBState.db.username = 'stale scheduled snapshot'
            await vi.advanceTimersByTimeAsync(1_000)
            await started
            const restored = database({ username: 'winning restored bytes' })
            await globalApi.replaceAndPersistDatabaseWithPluginRuntime(restored)
            releaseEncoding()
            await advanceUntil(() => durable.databaseWrites.length >= 1, 'restore did not reach durable storage')
            await vi.advanceTimersByTimeAsync(2_000)

            const published = await Promise.all(durable.databaseWrites.map(reload))
            expect(published.map((snapshot) => snapshot.username))
                .toEqual(published.map(() => 'winning restored bytes'))
        } finally {
            releaseEncoding()
            set.mockRestore()
        }
    })
})
