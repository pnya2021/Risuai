import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CursorRegistry } from './cursorRegistry'
import { PluginApiError } from './errors'
import {
    ContextResourceService,
    assertContextSnapshotLimits,
    type ContextAssetSource,
    type ContextCharacterSource,
    type ContextHostState,
    type ContextModuleSource,
    type ContextResourceAdapter,
} from './contextResources'
import { resolveModuleActivations } from './moduleActivation'

const encoder = new TextEncoder()

const pluginContext = (principalId = '11111111-1111-4111-8111-111111111111') => ({
    principalId,
    instanceId: `instance-${principalId}`,
    displayName: 'Illustrator',
    signal: new AbortController().signal,
})

const lore = (id: string, content = `${id} content`) => ({
    id,
    name: `${id} name`,
    content,
    enabled: true,
})

const asset = (
    identity: string,
    storageKey: string,
    role: ContextAssetSource['role'],
    options: Partial<ContextAssetSource> = {},
): ContextAssetSource => ({
    identity,
    storageKey,
    storageRevision: `storage:${storageKey}:1`,
    name: `${identity}.png`,
    extension: 'png',
    mediaType: 'image/png',
    role,
    ...options,
})

const character = (overrides: Partial<ContextCharacterSource> = {}): ContextCharacterSource => ({
    id: 'char-1',
    type: 'character',
    name: 'Alice',
    textSections: [
        { key: 'description', label: 'Description', content: 'A careful cartographer.' },
        { key: 'scenario', label: 'Scenario', content: 'A moonlit observatory.' },
    ],
    lorebook: [lore('char-lore')],
    assets: [
        asset('portrait', 'alice-portrait', 'portrait'),
        asset('happy', 'alice-happy', 'emotion'),
        asset('uniform', 'alice-uniform', 'additional', { mediaType: 'image/webp', extension: 'webp' }),
    ],
    ...overrides,
})

const moduleSource = (overrides: Partial<ContextModuleSource> = {}): ContextModuleSource => ({
    id: 'module-active',
    namespace: 'illustration',
    name: 'Active illustration module',
    description: 'Descriptive data only.',
    lorebook: [lore('module-lore')],
    assets: [asset('module-ref', 'module-ref', 'module')],
    activatedBy: ['global'],
    ...overrides,
})

const makeState = (): ContextHostState => {
    const active = moduleSource()
    const inactive = moduleSource({
        id: 'module-installed',
        name: 'Installed illustration pack',
        activatedBy: [],
        assets: [asset('installed-ref', 'installed-ref', 'module')],
    })
    return {
        current: {
            characterId: 'char-1',
            conversation: {
                id: 'conversation-1',
                localLorebook: [lore('local-lore')],
                selectedModuleIds: ['module-active'],
                messageMembership: ['message-1', 'message-2'],
            },
            personaId: 'persona-1',
        },
        characters: [
            character(),
            character({
                id: 'char-2',
                name: 'Bob',
                assets: [asset('portrait', 'bob-portrait', 'portrait')],
            }),
            character({
                id: 'other-card',
                name: 'Out of scope',
                assets: [asset('portrait', 'other-portrait', 'portrait')],
            }),
        ],
        activeModules: [active],
        installedModules: [active, inactive],
    }
}

const defaultBytes = () => new Map<string, Uint8Array>([
    ['alice-portrait', encoder.encode('alice portrait bytes')],
    ['alice-happy', encoder.encode('alice happy bytes')],
    ['alice-uniform', encoder.encode('alice uniform bytes')],
    ['bob-portrait', encoder.encode('bob portrait bytes')],
    ['other-portrait', encoder.encode('other portrait bytes')],
    ['module-ref', encoder.encode('active module bytes')],
    ['installed-ref', encoder.encode('installed module bytes')],
])

function harness(options: {
    state?: ContextHostState
    grants?: string[]
    now?: () => number
    cursorRegistry?: CursorRegistry
    thumbnail?: ContextResourceAdapter['createThumbnail']
    principalId?: string
    abortController?: AbortController
    onPermission?: (permission: 'contextAssets' | 'installedModulesRead') => void | Promise<void>
    cloneStateReads?: boolean
    afterStateRead?: (call: number) => void
} = {}) {
    let state = options.state ?? makeState()
    const bytes = defaultBytes()
    const reads = vi.fn(async (source: ContextAssetSource) => {
        const value = bytes.get(source.storageKey)
        if (!value) throw new PluginApiError('NOT_FOUND', 'Asset missing')
        return value.slice()
    })
    let stateReadCount = 0
    const getState = vi.fn(async () => {
        const result = options.cloneStateReads ? structuredClone(state) : state
        stateReadCount += 1
        options.afterStateRead?.(stateReadCount)
        return result
    })
    const adapter: ContextResourceAdapter = {
        getState,
        readAsset: reads,
        createThumbnail: options.thumbnail ?? (async (_source, _data, constraints) => ({
            data: new Uint8Array([1, 2, 3]),
            mediaType: 'image/webp',
            width: constraints.longEdge,
            height: constraints.longEdge,
            decodedPixels: constraints.maxPixels,
        })),
    }
    const granted = new Set(options.grants ?? ['contextAssets', 'installedModulesRead'])
    const permissionCalls: string[] = []
    const service = new ContextResourceService(
        {
            ...pluginContext(options.principalId ?? crypto.randomUUID()),
            ...(options.abortController ? { signal: options.abortController.signal } : {}),
        },
        adapter,
        {
            requirePermission: async (permission) => {
                permissionCalls.push(permission)
                await options.onPermission?.(permission)
                if (!granted.has(permission)) {
                    throw new PluginApiError('PERMISSION_DENIED', `Denied: ${permission}`, {
                        details: { permission },
                    })
                }
            },
            cursorRegistry: options.cursorRegistry ?? new CursorRegistry({ now: options.now }),
            now: options.now,
        },
    )
    return {
        service,
        bytes,
        reads,
        getState,
        permissionCalls,
        get state() { return state },
        setState(next: ContextHostState) { state = next },
    }
}

const errorCode = async (promise: Promise<unknown>) => {
    try {
        await promise
        return 'NO_ERROR'
    } catch (error) {
        return (error as PluginApiError).code
    }
}

describe('context snapshots', () => {
    it('returns stable current, card, and conversation snapshots without executable or provider fields', async () => {
        const state = makeState()
        Object.assign(state.characters[0] as object, {
            customscript: [{ in: 'secret script' }],
            providerSettings: { apiKey: 'never expose' },
        })
        Object.assign(state.activeModules[0] as object, { cjs: 'never expose', trigger: ['never expose'] })
        const { service } = harness({ state })

        const current = await service.getCurrentContext()
        expect(current).toMatchObject({
            characterId: 'char-1',
            conversationId: 'conversation-1',
            personaId: 'persona-1',
        })
        expect(current.characterRevision).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(current.conversationRevision).toMatch(/^sha256:[0-9a-f]{64}$/)

        const card = await service.getCharacterCardSnapshot()
        expect(card).toMatchObject({
            id: 'char-1',
            type: 'character',
            name: 'Alice',
            textSections: state.characters[0].textSections,
            lorebook: state.characters[0].lorebook,
        })
        expect(card).not.toHaveProperty('customscript')
        expect(card).not.toHaveProperty('providerSettings')

        const conversation = await service.getConversationContextSnapshot()
        expect(conversation).toMatchObject({
            id: 'conversation-1',
            localLorebook: [lore('local-lore')],
            selectedModuleIds: ['module-active'],
        })
        expect(JSON.stringify({ current, card, conversation })).not.toContain('never expose')
    })

    it('keeps character revisions stable across conversation-only changes and changes the conversation revision for membership or lore', async () => {
        const state = makeState()
        const h = harness({ state })
        const first = await h.service.getCurrentContext()
        state.current!.conversation.messageMembership.push('message-3')
        const membership = await h.service.getCurrentContext()
        expect(membership.characterRevision).toBe(first.characterRevision)
        expect(membership.conversationRevision).not.toBe(first.conversationRevision)
        state.current!.conversation.localLorebook[0].content = 'changed local lore'
        const loreChanged = await h.service.getCurrentContext()
        expect(loreChanged.conversationRevision).not.toBe(membership.conversationRevision)
    })

    it('re-resolves the authorized current card after an asynchronous permission decision', async () => {
        const state = makeState()
        let switched = false
        const h = harness({
            state,
            cloneStateReads: true,
            onPermission: () => {
                if (switched) return
                switched = true
                state.current!.characterId = 'char-2'
            },
        })

        await expect(h.service.getCharacterCardSnapshot()).resolves.toMatchObject({ id: 'char-2', name: 'Bob' })
        await expect(h.service.getCharacterCardSnapshot('char-1')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })

    it('allows the current group and its members but rejects unrelated selectors and conversations', async () => {
        const state = makeState()
        state.characters[0] = character({
            id: 'group-1',
            type: 'group',
            name: 'Expedition',
            groupMemberIds: ['char-1', 'char-2'],
        })
        state.current!.characterId = 'group-1'
        state.characters.splice(1, 0, character())
        const { service } = harness({ state })

        await expect(service.getCharacterCardSnapshot()).resolves.toMatchObject({
            id: 'group-1', type: 'group', groupMemberIds: ['char-1', 'char-2'],
        })
        await expect(service.getCharacterCardSnapshot('char-1')).resolves.toMatchObject({ id: 'char-1' })
        await expect(service.getCharacterCardSnapshot('char-2')).resolves.toMatchObject({ id: 'char-2' })
        expect(await errorCode(service.getCharacterCardSnapshot('other-card'))).toBe('PERMISSION_DENIED')
        await expect(service.getConversationContextSnapshot('conversation-1')).resolves.toMatchObject({ id: 'conversation-1' })
        expect(await errorCode(service.getConversationContextSnapshot('conversation-2'))).toBe('PERMISSION_DENIED')
    })

    it('returns NOT_FOUND for current-context operations while installed-module listing remains usable', async () => {
        const state = makeState()
        state.current = undefined
        const { service } = harness({ state, grants: ['installedModulesRead'] })
        expect(await errorCode(service.getCurrentContext())).toBe('NOT_FOUND')
        expect(await errorCode(service.getCharacterCardSnapshot())).toBe('NOT_FOUND')
        expect(await errorCode(service.getConversationContextSnapshot())).toBe('NOT_FOUND')
        await expect(service.listContextModules({ scope: 'installed' })).resolves.toMatchObject({
            items: expect.arrayContaining([expect.objectContaining({ id: 'module-installed' })]),
        })
    })

    it('returns NOT_FOUND before requesting permissions for every operation that depends on current context', async () => {
        const state = makeState()
        state.current = undefined
        const h = harness({ state, grants: [] })
        const validUnknownHandle = `ctxasset_${'0'.repeat(64)}`

        expect(await errorCode(h.service.getCurrentContext())).toBe('NOT_FOUND')
        expect(await errorCode(h.service.getCharacterCardSnapshot())).toBe('NOT_FOUND')
        expect(await errorCode(h.service.getConversationContextSnapshot())).toBe('NOT_FOUND')
        expect(await errorCode(h.service.getActiveModules())).toBe('NOT_FOUND')
        expect(await errorCode(h.service.listContextModules({ scope: 'active' }))).toBe('NOT_FOUND')
        expect(await errorCode(h.service.listContextAssets({ moduleScope: 'active' }))).toBe('NOT_FOUND')
        expect(await errorCode(h.service.listContextAssets({ moduleScope: 'installed' }))).toBe('NOT_FOUND')
        expect(await errorCode(h.service.readContextAsset(validUnknownHandle))).toBe('NOT_FOUND')
        expect(h.permissionCalls).toEqual([])
        expect(h.reads).not.toHaveBeenCalled()
    })
})

describe('module activation and module resources', () => {
    it('reports every global/chat/character/persona/integration reason once in deterministic order', () => {
        const shared = { id: 'shared', namespace: 'shared-ns', name: 'Shared' }
        const persona = { id: 'persona-module', name: 'Persona' }
        const resolved = resolveModuleActivations(
            [shared, { id: 'inactive', name: 'Inactive' }],
            {
                global: ['shared'],
                chat: ['shared-ns'],
                character: ['shared'],
                integration: ['shared-ns'],
                personaModule: persona,
            },
        )
        expect(resolved).toEqual([
            { module: shared, activatedBy: ['global', 'chat', 'character', 'integration'] },
            { module: persona, activatedBy: ['persona'] },
        ])
    })

    it('returns bounded active summaries and descriptive module snapshots without executable fields', async () => {
        const state = makeState()
        Object.assign(state.activeModules[0] as object, { cjs: 'hidden', regex: ['hidden'], assetsExecutable: true })
        const { service } = harness({ state })
        await expect(service.getActiveModules()).resolves.toEqual([{
            id: 'module-active',
            namespace: 'illustration',
            name: 'Active illustration module',
            activatedBy: ['global'],
        }])
        const page = await service.listContextModules({ scope: 'active' })
        expect(page.items[0]).toMatchObject({
            id: 'module-active',
            description: 'Descriptive data only.',
            lorebook: [lore('module-lore')],
        })
        expect(page.items[0]).not.toHaveProperty('assets')
        expect(page.items[0]).not.toHaveProperty('cjs')
        expect(JSON.stringify(page)).not.toContain('hidden')
    })

    it('requires contextAssets for active modules and only installedModulesRead for installed descriptions', async () => {
        const activeDenied = harness({ grants: ['installedModulesRead'] })
        expect(await errorCode(activeDenied.service.getActiveModules())).toBe('PERMISSION_DENIED')
        const installedOnly = harness({ grants: ['installedModulesRead'] })
        await expect(installedOnly.service.listContextModules({ scope: 'installed' })).resolves.toMatchObject({
            items: expect.any(Array),
        })
        expect(installedOnly.permissionCalls).toEqual(['installedModulesRead'])
        const installedDenied = harness({ grants: ['contextAssets'] })
        expect(await errorCode(installedDenied.service.listContextModules({ scope: 'installed' }))).toBe('PERMISSION_DENIED')
    })

    it('does not return a module that deactivates during permission resolution', async () => {
        const state = makeState()
        const h = harness({
            state,
            cloneStateReads: true,
            onPermission: (permission) => {
                if (permission === 'contextAssets') state.activeModules = []
            },
        })

        await expect(h.service.listContextModules({ scope: 'active' })).resolves.toEqual({ items: [] })
    })

    it('rejects a page whose module deactivates during snapshotting and clears its new cursor', async () => {
        const state = makeState()
        state.activeModules.push(moduleSource({ id: 'module-second-active', assets: [] }))
        const cursors = new CursorRegistry()
        const clearCursor = vi.spyOn(cursors, 'clear')
        const h = harness({
            state,
            cursorRegistry: cursors,
            cloneStateReads: true,
            afterStateRead: (call) => {
                if (call === 3) state.activeModules = []
            },
        })

        await expect(h.service.listContextModules({ scope: 'active', limit: 1 })).rejects.toMatchObject({
            code: 'CONFLICT',
            retryable: true,
        })
        expect(clearCursor).toHaveBeenCalledOnce()
        expect(clearCursor).toHaveBeenCalledWith(expect.any(String))
    })

    it('enforces active 100/101 and page 50/100/101 boundaries', async () => {
        const state = makeState()
        state.activeModules = Array.from({ length: 100 }, (_, index) => moduleSource({
            id: `active-${index}`,
            name: `Active ${index}`,
            assets: [],
        }))
        state.installedModules = Array.from({ length: 101 }, (_, index) => moduleSource({
            id: `installed-${index}`,
            name: `Installed ${index}`,
            activatedBy: [],
            assets: [],
        }))
        const { service } = harness({ state })
        await expect(service.getActiveModules()).resolves.toHaveLength(100)
        state.activeModules.push(moduleSource({ id: 'active-over', assets: [] }))
        expect(await errorCode(service.getActiveModules())).toBe('RESOURCE_LIMIT')

        const defaultPage = await service.listContextModules({ scope: 'installed' })
        expect(defaultPage.items).toHaveLength(50)
        expect(defaultPage.nextCursor).toEqual(expect.any(String))
        const maximumPage = await service.listContextModules({ scope: 'installed', limit: 100 })
        expect(maximumPage.items).toHaveLength(100)
        expect(await errorCode(service.listContextModules({ scope: 'installed', limit: 101 }))).toBe('RESOURCE_LIMIT')
    })

    it('snapshots only the requested module page and stores only a bounded cursor offset', async () => {
        const state = makeState()
        const deferred = moduleSource({ id: 'deferred-module', name: 'Deferred module', activatedBy: [] })
        Object.defineProperty(deferred, 'description', {
            enumerable: true,
            get: () => { throw new Error('module outside the requested page was snapshotted') },
        })
        state.installedModules = [
            moduleSource({ id: 'first-module', name: 'First module', activatedBy: [] }),
            deferred,
        ]
        const cursors = new CursorRegistry()
        const createCursor = vi.spyOn(cursors, 'create')
        const h = harness({ state, cursorRegistry: cursors })

        await expect(h.service.listContextModules({ scope: 'installed', limit: 1 })).resolves.toMatchObject({
            items: [expect.objectContaining({ id: 'first-module' })],
            nextCursor: expect.any(String),
        })
        expect(createCursor.mock.calls[0]?.[4]).toEqual({ offset: 1 })
    })

    it('binds module cursors to principal, instance, service, and the complete query and expires after five minutes', async () => {
        let now = 1_000
        const state = makeState()
        state.installedModules.push(moduleSource({ id: 'module-third', activatedBy: [], assets: [] }))
        const cursors = new CursorRegistry({ now: () => now, ttlMs: 300_000 })
        const h = harness({ state, now: () => now, cursorRegistry: cursors })
        const first = await h.service.listContextModules({ scope: 'installed', limit: 1 })
        await expect(h.service.listContextModules({ scope: 'installed', limit: 1, cursor: first.nextCursor })).resolves.toMatchObject({
            items: [expect.objectContaining({ id: 'module-installed' })],
        })
        expect(await errorCode(h.service.listContextModules({ scope: 'active', limit: 1, cursor: first.nextCursor }))).toBe('INVALID_ARGUMENT')

        const expiring = await h.service.listContextModules({ scope: 'installed', limit: 1 })
        now += 300_000
        await expect(h.service.listContextModules({ scope: 'installed', limit: 1, cursor: expiring.nextCursor })).resolves.toBeDefined()
        const expired = await h.service.listContextModules({ scope: 'installed', limit: 1 })
        now += 300_001
        expect(await errorCode(h.service.listContextModules({ scope: 'installed', limit: 1, cursor: expired.nextCursor }))).toBe('INVALID_ARGUMENT')

        const foreign = harness({ state, cursorRegistry: cursors, principalId: '22222222-2222-4222-8222-222222222222' })
        const owned = await h.service.listContextModules({ scope: 'installed', limit: 1 })
        expect(await errorCode(foreign.service.listContextModules({ scope: 'installed', limit: 1, cursor: owned.nextCursor }))).toBe('INVALID_ARGUMENT')
    })
})

describe('opaque context assets', () => {
    it('lists content-digest-bound opaque principal handles and caches unchanged digests', async () => {
        const h = harness()
        const first = await h.service.listContextAssets({ moduleScope: 'none' })
        expect(first.assets).toHaveLength(3)
        expect(first.contextRevision).toMatch(/^sha256:/)
        expect(first.assets[0]).toMatchObject({
            assetId: expect.stringMatching(/^ctxasset_[0-9a-f]{64}$/),
            revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            origin: { kind: 'character', characterId: 'char-1' },
        })
        expect(JSON.stringify(first)).not.toContain('alice-portrait')
        const firstReadCount = h.reads.mock.calls.length
        await h.service.listContextAssets({ moduleScope: 'none' })
        expect(h.reads).toHaveBeenCalledTimes(firstReadCount)

        const foreign = harness({ principalId: '22222222-2222-4222-8222-222222222222' })
        expect(await errorCode(foreign.service.readContextAsset(first.assets[0].assetId))).toBe('NOT_FOUND')
    })

    it('filters roles and media types and applies default 50 / maximum 100 paging', async () => {
        const state = makeState()
        state.characters[0].assets = Array.from({ length: 101 }, (_, index) => asset(
            `asset-${index}`,
            `asset-${index}`,
            index % 2 === 0 ? 'emotion' : 'additional',
            { mediaType: index % 3 === 0 ? 'image/webp' : 'image/png' },
        ))
        const h = harness({ state })
        for (let index = 0; index < 101; index++) h.bytes.set(`asset-${index}`, encoder.encode(`bytes-${index}`))
        const defaultPage = await h.service.listContextAssets({ moduleScope: 'none' })
        expect(defaultPage.assets).toHaveLength(50)
        expect(defaultPage.nextCursor).toEqual(expect.any(String))
        const maximum = await h.service.listContextAssets({ moduleScope: 'none', limit: 100 })
        expect(maximum.assets).toHaveLength(100)
        expect(await errorCode(h.service.listContextAssets({ moduleScope: 'none', limit: 101 }))).toBe('RESOURCE_LIMIT')
        const filtered = await h.service.listContextAssets({
            moduleScope: 'none',
            include: ['emotion'],
            mediaTypes: ['IMAGE/WEBP'],
            limit: 100,
        })
        expect(filtered.assets.length).toBeGreaterThan(0)
        expect(filtered.assets.every((item) => item.role === 'emotion' && item.mediaType === 'image/webp')).toBe(true)
    })

    it('digests only one requested asset chunk and stores only a bounded cursor offset', async () => {
        const state = makeState()
        state.characters[0].assets = Array.from({ length: 5 }, (_, index) => asset(
            `bounded-${index}`,
            `bounded-${index}`,
            'additional',
        ))
        const cursors = new CursorRegistry()
        const createCursor = vi.spyOn(cursors, 'create')
        const h = harness({ state, cursorRegistry: cursors })
        for (let index = 0; index < 5; index++) {
            h.bytes.set(`bounded-${index}`, encoder.encode(`bounded bytes ${index}`))
        }

        const first = await h.service.listContextAssets({ moduleScope: 'none', limit: 2 })
        expect(first.assets).toHaveLength(2)
        expect(first.nextCursor).toEqual(expect.any(String))
        expect(h.reads).toHaveBeenCalledTimes(2)
        expect(createCursor.mock.calls[0]?.[4]).toEqual({ offset: 2 })

        const second = await h.service.listContextAssets({ moduleScope: 'none', limit: 2, cursor: first.nextCursor })
        expect(second.assets).toHaveLength(2)
        expect(h.reads).toHaveBeenCalledTimes(4)
        expect(createCursor.mock.calls[1]?.[4]).toEqual({ offset: 4 })
    })

    it('requires contextAssets and independently requires installedModulesRead for installed module assets', async () => {
        const missingContext = harness({ grants: ['installedModulesRead'] })
        expect(await errorCode(missingContext.service.listContextAssets({ moduleScope: 'installed' }))).toBe('PERMISSION_DENIED')
        const missingInstalled = harness({ grants: ['contextAssets'] })
        expect(await errorCode(missingInstalled.service.listContextAssets({ moduleScope: 'installed' }))).toBe('PERMISSION_DENIED')
        await expect(missingInstalled.service.listContextAssets({ moduleScope: 'active' })).resolves.toBeDefined()
    })

    it('fails closed when an active module deactivates while its asset metadata is being digested', async () => {
        const state = makeState()
        const h = harness({ state })
        h.reads.mockImplementationOnce(async (source: ContextAssetSource) => {
            state.activeModules = []
            return h.bytes.get(source.storageKey)!.slice()
        })

        await expect(h.service.listContextAssets({ moduleScope: 'active', include: ['module'] }))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        expect(h.permissionCalls).toEqual(['contextAssets'])
    })

    it('does not treat an installed asset as active when a persona module reuses its module ID', async () => {
        const state = makeState()
        const inactive = moduleSource({
            id: 'collision',
            activatedBy: [],
            assets: [asset('installed-collision', 'installed-ref', 'module')],
        })
        const active = moduleSource({
            id: 'collision',
            activatedBy: ['persona'],
            assets: [asset('persona-collision', 'module-ref', 'module')],
        })
        state.installedModules = [inactive]
        state.activeModules = [active]
        const principalId = '44444444-4444-4444-8444-444444444444'
        const issued = harness({ state, principalId })
        const listed = await issued.service.listContextAssets({ moduleScope: 'installed', include: ['module'] })
        const reference = listed.assets[0]

        const denied = harness({ state, principalId, grants: ['contextAssets'] })
        await expect(denied.service.readContextAsset(reference.assetId, { ifRevision: reference.revision }))
            .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })

    it('re-authorizes character origin on every read without invalidating handles for unrelated conversation changes', async () => {
        const state = makeState()
        const h = harness({ state })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        state.current!.conversation.messageMembership.push('message-3')
        await expect(h.service.readContextAsset(reference.assetId, { ifRevision: reference.revision })).resolves.toMatchObject({
            revision: reference.revision,
        })

        state.current!.characterId = 'char-2'
        expect(await errorCode(h.service.readContextAsset(reference.assetId, { ifRevision: reference.revision }))).toBe('PERMISSION_DENIED')
        state.current!.characterId = 'char-1'
        await expect(h.service.readContextAsset(reference.assetId, { ifRevision: reference.revision })).resolves.toBeDefined()
    })

    it('fails closed when the current character changes while asset bytes are being read', async () => {
        const state = makeState()
        const h = harness({ state })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        h.reads.mockImplementationOnce(async (source: ContextAssetSource) => {
            state.current!.characterId = 'char-2'
            return h.bytes.get(source.storageKey)!.slice()
        })
        expect(await errorCode(h.service.readContextAsset(reference.assetId))).toBe('PERMISSION_DENIED')
    })

    it('returns ABORTED instead of bytes when the plugin instance unloads during a read', async () => {
        const abortController = new AbortController()
        const h = harness({ abortController })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        h.reads.mockImplementationOnce(async (source: ContextAssetSource) => {
            abortController.abort()
            return h.bytes.get(source.storageKey)!.slice()
        })
        expect(await errorCode(h.service.readContextAsset(reference.assetId))).toBe('ABORTED')
    })

    it('re-authorizes inactive module handles through installedModulesRead and rejects stale content revisions', async () => {
        const state = makeState()
        const principalId = '33333333-3333-4333-8333-333333333333'
        const h = harness({ state, principalId })
        const listed = await h.service.listContextAssets({ moduleScope: 'active', include: ['module'] })
        const reference = listed.assets[0]
        state.activeModules = []
        await expect(h.service.readContextAsset(reference.assetId, { ifRevision: reference.revision })).resolves.toBeDefined()

        const denied = harness({ state, grants: ['contextAssets'], principalId })
        expect(await errorCode(denied.service.readContextAsset(reference.assetId, { ifRevision: reference.revision }))).toBe('PERMISSION_DENIED')

        h.bytes.set('module-ref', encoder.encode('replacement bytes'))
        state.installedModules[0].assets[0].storageRevision = 'storage:module-ref:2'
        expect(await errorCode(h.service.readContextAsset(reference.assetId, { ifRevision: reference.revision }))).toBe('CONFLICT')
        expect(await errorCode(h.service.readContextAsset(reference.assetId))).toBe('CONFLICT')
        const relisted = await h.service.listContextAssets({ moduleScope: 'installed', include: ['module'] })
        const replacement = relisted.assets.find((item) => item.origin.kind === 'module' && item.origin.moduleId === 'module-active')!
        expect(replacement.revision).not.toBe(reference.revision)
        expect(replacement.assetId).not.toBe(reference.assetId)
        await expect(h.service.readContextAsset(replacement.assetId)).resolves.toMatchObject({ revision: replacement.revision })
    })

    it('rechecks an inactive module source after installed permission resolution while preserving the active bypass', async () => {
        const state = makeState()
        const principalId = '66666666-6666-4666-8666-666666666666'
        const issued = harness({ state, principalId })
        const listed = await issued.service.listContextAssets({ moduleScope: 'active', include: ['module'] })
        const reference = listed.assets[0]

        const active = harness({ state, principalId, grants: ['contextAssets'] })
        await expect(active.service.readContextAsset(reference.assetId, { ifRevision: reference.revision }))
            .resolves.toMatchObject({ revision: reference.revision })
        expect(active.permissionCalls).toEqual(['contextAssets'])

        state.activeModules = []
        let installedPermissionCalls = 0
        const inactive = harness({
            state,
            principalId,
            cloneStateReads: true,
            onPermission: (permission) => {
                if (permission !== 'installedModulesRead') return
                installedPermissionCalls += 1
                if (installedPermissionCalls === 2) {
                    state.installedModules = state.installedModules
                        .filter((module) => module.id !== 'module-active')
                }
            },
        })

        await expect(inactive.service.readContextAsset(reference.assetId, { ifRevision: reference.revision }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(installedPermissionCalls).toBe(2)
        expect(inactive.reads).toHaveBeenCalledOnce()
    })

    it('enforces maxBytes and the 60/61 per-minute read boundary', async () => {
        let now = 10_000
        const h = harness({ now: () => now })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        await expect(h.service.readContextAsset(reference.assetId, { maxBytes: 33_554_432 })).resolves.toBeDefined()
        expect(await errorCode(h.service.readContextAsset(reference.assetId, { maxBytes: 33_554_433 }))).toBe('RESOURCE_LIMIT')
        expect(await errorCode(h.service.readContextAsset(reference.assetId, { maxBytes: 1 }))).toBe('RESOURCE_LIMIT')

        now += 60_001
        for (let index = 0; index < 60; index++) {
            await h.service.readContextAsset(reference.assetId)
        }
        const limited = h.service.readContextAsset(reference.assetId)
        await expect(limited).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', retryable: true })
    })

    it('rejects malformed and oversized asset handles before touching host state or asset storage', async () => {
        const h = harness()
        const stateCalls = h.getState.mock.calls.length
        const assetReads = h.reads.mock.calls.length
        expect(await errorCode(h.service.readContextAsset('not-an-opaque-handle'))).toBe('INVALID_ARGUMENT')
        expect(await errorCode(h.service.readContextAsset(`ctxasset_${'a'.repeat(65_536)}`))).toBe('INVALID_ARGUMENT')
        expect(await errorCode(h.service.readContextAsset(`ctxasset_${'a'.repeat(64)}`, {
            ifRevision: `sha256:${'b'.repeat(65_536)}`,
        }))).toBe('INVALID_ARGUMENT')
        expect(h.getState).toHaveBeenCalledTimes(stateCalls)
        expect(h.reads).toHaveBeenCalledTimes(assetReads)
    })

    it('rejects an unissued handle without enumerating unrelated asset metadata', async () => {
        const state = makeState()
        Object.defineProperty(state.characters[2], 'assets', {
            enumerable: true,
            get: () => { throw new Error('unrelated assets were enumerated') },
        })
        const h = harness({ state })

        await expect(h.service.readContextAsset(`ctxasset_${'0'.repeat(64)}`))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(h.reads).not.toHaveBeenCalled()
    })

    it('charges syntactically valid unknown handles after context preflight and before asset scanning at 60/61', async () => {
        const h = harness({ now: () => 20_000 })
        const unknownHandle = `ctxasset_${'0'.repeat(64)}`
        for (let index = 0; index < 60; index++) {
            expect(await errorCode(h.service.readContextAsset(unknownHandle))).toBe('NOT_FOUND')
        }
        expect(h.reads).not.toHaveBeenCalled()
        const stateCalls = h.getState.mock.calls.length
        const assetReads = h.reads.mock.calls.length
        await expect(h.service.readContextAsset(unknownHandle)).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT',
            retryable: true,
        })
        expect(h.getState).toHaveBeenCalledTimes(stateCalls + 1)
        expect(h.reads).toHaveBeenCalledTimes(assetReads)
    })

    it('recovers a persisted handle from its revision without reading unrelated asset bytes', async () => {
        const principalId = '55555555-5555-4555-8555-555555555555'
        const issued = harness({ principalId })
        const listed = await issued.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        const restored = harness({ principalId })

        await expect(restored.service.readContextAsset(reference.assetId, { ifRevision: reference.revision }))
            .resolves.toMatchObject({ revision: reference.revision })
        expect(restored.reads).toHaveBeenCalledTimes(1)

        const unknown = harness({ principalId })
        await expect(unknown.service.readContextAsset(`ctxasset_${'0'.repeat(64)}`, {
            ifRevision: `sha256:${'1'.repeat(64)}`,
        })).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(unknown.reads).not.toHaveBeenCalled()
    })

    it('charges stale handles after context preflight and before asset scanning at 60/61', async () => {
        const state = makeState()
        const h = harness({ state, now: () => 30_000 })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        h.bytes.set('alice-portrait', encoder.encode('replacement portrait bytes'))
        state.characters[0].assets[0].storageRevision = 'storage:alice-portrait:2'
        for (let index = 0; index < 60; index++) {
            expect(await errorCode(h.service.readContextAsset(reference.assetId))).toBe('CONFLICT')
        }
        const stateCalls = h.getState.mock.calls.length
        const assetReads = h.reads.mock.calls.length
        await expect(h.service.readContextAsset(reference.assetId)).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT',
            retryable: true,
        })
        expect(h.getState).toHaveBeenCalledTimes(stateCalls + 1)
        expect(h.reads).toHaveBeenCalledTimes(assetReads)
    })

    it.each([
        ['long edge', { width: 513, height: 1, decodedPixels: 513, bytes: 3 }],
        ['decoded pixels', { width: 512, height: 512, decodedPixels: 262_145, bytes: 3 }],
        ['output bytes', { width: 512, height: 512, decodedPixels: 262_144, bytes: 1_048_577 }],
    ])('rejects a one-over thumbnail %s result', async (_label, result) => {
        const thumbnail = vi.fn(async () => ({
            data: new Uint8Array(result.bytes),
            mediaType: 'image/webp',
            width: result.width,
            height: result.height,
            decodedPixels: result.decodedPixels,
        }))
        const h = harness({ thumbnail })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        expect(await errorCode(h.service.readContextAsset(listed.assets[0].assetId, { variant: 'thumbnail' }))).toBe('RESOURCE_LIMIT')
    })

    it('accepts the exact 512 / 262144 pixels / 1048576-byte thumbnail boundary without returning the original', async () => {
        const data = new Uint8Array(1_048_576)
        data[0] = 123
        const thumbnail = vi.fn(async (_source: ContextAssetSource, _input: Uint8Array, constraints: { longEdge: number; maxPixels: number; maxOutputBytes: number }) => ({
            data,
            mediaType: 'image/webp',
            width: 512,
            height: 512,
            decodedPixels: 262_144,
        }))
        const h = harness({ thumbnail })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const result = await h.service.readContextAsset(listed.assets[0].assetId, { variant: 'thumbnail', maxBytes: 1_048_576 })
        expect(result.data).toHaveLength(1_048_576)
        expect(result.data[0]).toBe(123)
        expect(result.data).not.toEqual(h.bytes.get('alice-portrait'))
        expect(thumbnail).toHaveBeenCalledWith(expect.objectContaining({ identity: 'portrait' }), expect.any(Uint8Array), {
            longEdge: 512,
            maxPixels: 262_144,
            maxOutputBytes: 1_048_576,
        })
    })
})

describe('snapshot hard ceilings', () => {
    it('accepts/rejects individual UTF-8 text at 524288/524289 bytes', async () => {
        const state = makeState()
        state.characters[0].textSections[0].content = 'a'.repeat(524_288)
        const h = harness({ state })
        await expect(h.service.getCharacterCardSnapshot()).resolves.toBeDefined()
        state.characters[0].textSections[0].content += 'a'
        expect(await errorCode(h.service.getCharacterCardSnapshot())).toBe('RESOURCE_LIMIT')
    })

    it('accepts/rejects canonical snapshot JSON at 2097152/2097153 bytes', () => {
        const exact = [
            'a'.repeat(524_288),
            'b'.repeat(524_288),
            'c'.repeat(524_288),
            'd'.repeat(524_275),
        ]
        expect(assertContextSnapshotLimits(exact)).toHaveLength(2_097_152)
        exact[3] += 'd'
        expect(() => assertContextSnapshotLimits(exact)).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }))
    })

    it('accepts/rejects JSON depth at 32/33', () => {
        const nested = (depth: number) => {
            let value: unknown = 'leaf'
            for (let index = 1; index < depth; index++) value = [value]
            return value
        }
        expect(() => assertContextSnapshotLimits(nested(32))).not.toThrow()
        expect(() => assertContextSnapshotLimits(nested(33))).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }))
    })
})
