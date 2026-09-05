import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RisuPlugin } from '../plugins.svelte'

vi.mock('../../parser/parser.svelte', () => ({
    applyMarkdownToNode: vi.fn(),
    assetRegex: /$^/,
    hasher: vi.fn().mockResolvedValue('hash'),
    risuChatParser: vi.fn(),
    risuEscape: vi.fn((value: string) => value),
    risuUnescape: vi.fn((value: string) => value),
}))

vi.mock('../../process/modules', () => ({
    exportModuleLegacy: vi.fn(),
    getActiveModulesWithReasons: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleRegexScripts: vi.fn(() => []),
    moduleUpdate: vi.fn(),
    readModule: vi.fn(),
}))

const REAL_V3_TIMEOUT_MS = 60_000

const startedInstances: Array<{ instanceId: string }> = []

async function startV3Api() {
    const stores = await import('../../stores.svelte')
    const v3 = await import('./v3.svelte')
    const plugin = {
        name: `upstream-permission-${crypto.randomUUID()}`,
        displayName: 'Upstream permission sync test',
        script: '',
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        version: '3.0',
        enabled: true,
        principalId: crypto.randomUUID(),
    } satisfies RisuPlugin
    const previousPlugins = stores.DBState.db.plugins
    stores.DBState.db.plugins = [plugin]
    await v3.executePluginV3(plugin)
    const instance = v3.getV3PluginInstance(plugin.name)
    if (!instance) throw new Error('V3 test instance did not start')
    const { pluginV2 } = await import('../plugins.svelte')
    const inlays = await import('../../process/files/inlays')
    const { pluginPermissionService } = await import('./illustration/permissions')
    startedInstances.push(instance)
    return {
        api: (instance.host as any).apiFactory,
        stores,
        instance,
        inlays,
        pluginV2,
        pluginPermissionService,
        async cleanup() {
            await v3.unloadV3Plugin(instance.instanceId)
            const tracked = startedInstances.indexOf(instance)
            if (tracked >= 0) startedInstances.splice(tracked, 1)
            stores.DBState.db.plugins = previousPlugins
        },
    }
}

afterEach(async () => {
    vi.restoreAllMocks()
    const v3 = await import('./v3.svelte')
    for (const instance of startedInstances.splice(0)) {
        await v3.unloadV3Plugin(instance.instanceId)
    }
})

describe('upstream CBS parser API sync', () => {
    async function withParserContext(run: (runtime: Awaited<ReturnType<typeof startV3Api>>, char: any) => Promise<void>) {
        const runtime = await startV3Api()
        const previousCharacters = runtime.stores.DBState.db.characters
        const previousSelection = runtime.stores.selIdState.selId
        runtime.stores.DBState.db.characters = [{
            chaId: 'parser-card', type: 'character', name: 'Parser card', chatPage: 0,
            chats: [{ id: 'parser-chat', message: [{ role: 'user', data: 'existing' }] }],
        }] as any
        runtime.stores.selectedCharID.set(0)
        try {
            await run(runtime, runtime.stores.DBState.db.characters[0])
        } finally {
            runtime.stores.DBState.db.characters = previousCharacters
            runtime.stores.selectedCharID.set(previousSelection)
            await runtime.cleanup()
        }
    }

    it('registers CBS parsing on the live V3 API and forwards the active context and options', async () => {
        await withParserContext(async (runtime, char) => {
            expect(runtime.api.parseRisuChat).toBeTypeOf('function')
            const parser = await import('../../parser/parser.svelte')
            const parse = vi.mocked(parser.risuChatParser).mockReturnValue('parsed CBS')
            await expect(runtime.api.parseRisuChat('input', {
                messageIndex: 0, role: 'user', runVar: true, rmVar: true, tokenizeAccurate: true,
                cbsConditions: { firstmsg: true, chatRole: 'char' },
            })).resolves.toBe('parsed CBS')
            expect(parse).toHaveBeenLastCalledWith('input', {
                chara: char, chatID: 0, role: 'user', runVar: true, rmVar: true,
                tokenizeAccurate: true, cbsConditions: { firstmsg: true, chatRole: 'char' },
            })
        })
    }, REAL_V3_TIMEOUT_MS)

    it('defaults to no message context and no editprocess pipeline', async () => {
        await withParserContext(async (runtime, char) => {
            expect(runtime.api.parseRisuChat).toBeTypeOf('function')
            const parser = await import('../../parser/parser.svelte')
            const scripts = await import('../../process/scripts')
            const process = vi.spyOn(scripts, 'processScriptFull')
            const parse = vi.mocked(parser.risuChatParser).mockReturnValue('plain CBS')
            await expect(runtime.api.parseRisuChat(null)).resolves.toBe('plain CBS')
            expect(parse).toHaveBeenLastCalledWith('', {
                chara: char, chatID: -1, role: undefined, runVar: undefined, rmVar: undefined,
                tokenizeAccurate: undefined, cbsConditions: {},
            })
            expect(process).not.toHaveBeenCalled()
        })
    }, REAL_V3_TIMEOUT_MS)

    it('rejects invalid message indexes before parsing', async () => {
        await withParserContext(async (runtime) => {
            expect(runtime.api.parseRisuChat).toBeTypeOf('function')
            const parser = await import('../../parser/parser.svelte')
            const parse = vi.mocked(parser.risuChatParser).mockClear()
            for (const messageIndex of [-2, 1, 0.5, Number.NaN]) {
                await expect(runtime.api.parseRisuChat('input', { messageIndex })).rejects.toThrow('Invalid messageIndex')
            }
            expect(parse).not.toHaveBeenCalled()
        })
    }, REAL_V3_TIMEOUT_MS)

    it('rejects missing active chat or selected character', async () => {
        await withParserContext(async (runtime, char) => {
            expect(runtime.api.parseRisuChat).toBeTypeOf('function')
            char.chatPage = 2
            await expect(runtime.api.parseRisuChat('input')).rejects.toThrow('No active chat found')
            runtime.stores.selectedCharID.set(-1)
            await expect(runtime.api.parseRisuChat('input')).rejects.toThrow('No character selected')
        })
    }, REAL_V3_TIMEOUT_MS)

    it('passes parsed CBS text through the requested editprocess pipeline', async () => {
        await withParserContext(async (runtime, char) => {
            expect(runtime.api.parseRisuChat).toBeTypeOf('function')
            const parser = await import('../../parser/parser.svelte')
            const scripts = await import('../../process/scripts')
            vi.mocked(parser.risuChatParser).mockReturnValue('parsed CBS')
            const process = vi.spyOn(scripts, 'processScriptFull').mockResolvedValue({ data: 'edited CBS', emoChanged: false })
            await expect(runtime.api.parseRisuChat('input', { messageIndex: 0, role: 'user', processRegex: true })).resolves.toBe('edited CBS')
            expect(process).toHaveBeenCalledWith(char, 'parsed CBS', 'editprocess', 0, { chatRole: 'user' })
        })
    }, REAL_V3_TIMEOUT_MS)
})

describe('upstream strong-V3 permission sync', () => {
    it('gates chat-listener registration with the scoped replacer permission', async () => {
        const listener = vi.fn()
        const runtime = await startV3Api()
        const permission = vi.spyOn(runtime.pluginPermissionService, 'request')
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)
        const initialListeners = new Set(runtime.pluginV2.chatOutput)
        const initialListenerCount = runtime.pluginV2.chatOutput.size
        try {
            await runtime.api.addRisuChatListener('output', listener)
            expect(runtime.pluginV2.chatOutput.size).toBe(initialListenerCount)

            await runtime.api.addRisuChatListener('output', listener)
            expect(runtime.pluginV2.chatOutput.size).toBe(initialListenerCount + 1)
            expect(permission.mock.calls.map(([, id, options]) => [id, options?.reconfirm]))
                .toEqual([['replacer', 'periodically'], ['replacer', 'periodically']])
        } finally {
            await runtime.cleanup()
            for (const registered of runtime.pluginV2.chatOutput) {
                if (!initialListeners.has(registered)) runtime.pluginV2.chatOutput.delete(registered)
            }
        }
    }, REAL_V3_TIMEOUT_MS)

    it('does not register a listener when its permission resolves after unload', async () => {
        let resolvePermission!: (value: boolean) => void
        const permissionResult = new Promise<boolean>((resolve) => { resolvePermission = resolve })
        const listener = vi.fn()
        const runtime = await startV3Api()
        const initialListenerCount = runtime.pluginV2.chatOutput.size
        const permission = vi.spyOn(runtime.pluginPermissionService, 'request').mockReturnValue(permissionResult)

        const registration = runtime.api.addRisuChatListener('output', listener)
        await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce())
        const unloading = runtime.cleanup()
        resolvePermission(true)
        await Promise.all([registration, unloading])

        expect(runtime.pluginV2.chatOutput.size).toBe(initialListenerCount)
    }, REAL_V3_TIMEOUT_MS)

    it('gates a real legacy Inlay read with the scoped foreign-read permission', async () => {
        const inlayId = `foreign-${crypto.randomUUID()}`
        const runtime = await startV3Api()
        const permission = vi.spyOn(runtime.pluginPermissionService, 'request')
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)
        await runtime.inlays.setInlayAsset(inlayId, {
            name: 'foreign.png',
            data: 'data:image/png;base64,AQ==',
            ext: 'png',
            type: 'image',
        })
        try {
            await expect(runtime.api.readInlay(inlayId)).resolves.toBeNull()
            await expect(runtime.api.readInlay(inlayId)).resolves.toMatchObject({
                name: 'foreign.png',
                data: 'data:image/png;base64,AQ==',
            })
            expect(permission.mock.calls.map(([, id, options]) => [id, options?.reconfirm]))
                .toEqual([['inlayRead', 'periodically'], ['inlayRead', 'periodically']])
        } finally {
            await runtime.cleanup()
            await runtime.inlays.removeInlayAsset(inlayId)
        }
    }, REAL_V3_TIMEOUT_MS)

    it('does not read an Inlay when its permission resolves after unload', async () => {
        let resolvePermission!: (value: boolean) => void
        const permissionResult = new Promise<boolean>((resolve) => { resolvePermission = resolve })
        const inlayId = `foreign-${crypto.randomUUID()}`
        const runtime = await startV3Api()
        const permission = vi.spyOn(runtime.pluginPermissionService, 'request').mockReturnValue(permissionResult)
        await runtime.inlays.setInlayAsset(inlayId, {
            name: 'foreign.png',
            data: 'data:image/png;base64,AQ==',
            ext: 'png',
            type: 'image',
        })
        const read = runtime.api.readInlay(inlayId)
        await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce())
        const unloading = runtime.cleanup()
        resolvePermission(true)
        await expect(read).resolves.toBeNull()
        await unloading
        await runtime.inlays.removeInlayAsset(inlayId)
    }, REAL_V3_TIMEOUT_MS)
})
