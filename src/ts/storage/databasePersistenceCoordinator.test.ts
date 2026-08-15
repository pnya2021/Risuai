import { describe, expect, it, vi } from 'vitest'
import { DatabasePersistenceCoordinator } from './databasePersistenceCoordinator'
import { RisuSaveDecoder, RisuSaveEncoder } from './risuSave'
import type { Database } from './database.svelte'

vi.mock('../globalApi.svelte', () => ({
    downloadFile: vi.fn(),
    forageStorage: {
        getItem: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        setItem: vi.fn(),
    },
    saveAsset: vi.fn(),
}))
vi.mock('../parser/parser.svelte', () => ({
    applyMarkdownToNode: vi.fn(),
    assetRegex: /$^/,
    hasher: vi.fn(),
    risuChatParser: vi.fn(),
    risuEscape: vi.fn((value: string) => value),
    risuUnescape: vi.fn((value: string) => value),
}))
vi.mock('../process/modules', () => ({ moduleUpdate: vi.fn() }))

const database = (username: string): Database => ({
    username,
    characters: [],
    botPresets: [],
    modules: [],
    loadouts: [],
    plugins: [],
    pluginCustomStorage: {},
}) as Database

async function encode(database: Database) {
    const encoder = new RisuSaveEncoder()
    await encoder.init(database)
    return new Uint8Array(encoder.encode()!)
}

describe('database persistence coordinator', () => {
    it('does not publish a snapshot captured before a winning restore generation', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        let releaseEncoding!: () => void
        const encodingGate = new Promise<void>((resolve) => { releaseEncoding = resolve })
        let durableBytes = await encode(database('pre-restore bytes'))
        const generation = coordinator.captureGeneration()
        const capturedSnapshot = structuredClone(database('stale scheduled snapshot'))

        const staleSave = (async () => {
            await encodingGate
            const staleBytes = await encode(capturedSnapshot)
            return coordinator.runNormalWrite(generation, () => { durableBytes = staleBytes })
        })()
        await coordinator.runExclusiveMutation(async () => {
            durableBytes = await encode(database('winning restored bytes'))
        })
        releaseEncoding()

        const result = await staleSave
        const reloaded = await new RisuSaveDecoder().decode(durableBytes)
        expect(result.executed).toBe(false)
        expect(reloaded.username).toBe('winning restored bytes')
    })

    it('lets an in-flight normal save finish before an exclusive restore lands last', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const events: string[] = []
        let releaseSave!: () => void
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
        const token = coordinator.captureGeneration()
        const save = coordinator.runNormalWrite(token, async () => { events.push('save:start'); await saveGate; events.push('save:end') })
        await Promise.resolve()
        const restore = coordinator.runExclusiveMutation(async () => { events.push('restore') })
        await Promise.resolve()
        expect(events).toEqual(['save:start'])
        releaseSave()
        await Promise.all([save, restore])
        expect(events).toEqual(['save:start', 'save:end', 'restore'])
    })

    it('invalidates a stale save captured before an exclusive restore without deadlocking async rebase work', async () => {
        const coordinator = new DatabasePersistenceCoordinator()
        const staleToken = coordinator.captureGeneration()
        let releaseRestore!: () => void
        const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve })
        const events: string[] = []
        const restore = coordinator.runExclusiveMutation(async () => { events.push('restore:start'); await restoreGate; events.push('restore:end') })
        await Promise.resolve()
        const staleSave = coordinator.runNormalWrite(staleToken, async () => { events.push('stale-save') })
        releaseRestore()
        const [, result] = await Promise.all([restore, staleSave])
        expect(result.executed).toBe(false)
        expect(events).toEqual(['restore:start', 'restore:end'])
    })
})
