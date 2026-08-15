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

async function advanceUntil(predicate: () => boolean, message: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        await vi.advanceTimersByTimeAsync(250)
        if (predicate()) return
    }
    throw new Error(message)
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
        databaseModule.setDatabaseLite(database())
        void globalApi.saveDb()
        await advanceUntil(() => durable.databaseWrites.length > 0, 'background save did not reach durable storage')
    })

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
