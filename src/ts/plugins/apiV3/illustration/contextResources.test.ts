import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CursorRegistry } from './cursorRegistry'
import { PluginApiError } from './errors'
import { ContextAssetReadCoordinator } from './contextAssetReadCoordinator'
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
import { QueryCaptureCache } from './queryCaptureCache'

const encoder = new TextEncoder()

const canonicalFixtureBytes = (value: unknown) => {
    const normalize = (current: unknown): unknown => {
        if (Array.isArray(current)) return current.map(normalize)
        if (!current || typeof current !== 'object') return current
        return Object.fromEntries(Object.entries(current as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, normalize(item)]))
    }
    return encoder.encode(JSON.stringify(normalize(value))).byteLength
}

const deferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('Timed out waiting for test condition')
}

const occupyAllReadPermits = async (coordinator: ContextAssetReadCoordinator, principalId: string) => {
    const gates = Array.from({ length: 4 }, () => deferred<void>())
    let started = 0
    const promises = gates.map((gate) => coordinator.schedule({
        owner: { principalId, instanceId: 'permit-blocker' },
        lane: 'digest',
        run: async () => {
            started += 1
            return gate.promise
        },
    }))
    await waitFor(() => started === 4)
    return {
        releaseOne: () => gates.shift()?.resolve(),
        releaseAll: async () => {
            for (const gate of gates.splice(0)) gate.resolve()
            await Promise.all(promises)
        },
    }
}

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
    readAsset?: ContextResourceAdapter['readAsset']
    readCoordinator?: ContextAssetReadCoordinator
    instanceId?: string
    queryCaptureCache?: QueryCaptureCache
    getPermissionGeneration?: () => number
    assetAuthorityRegistry?: unknown
    adapterOverrides?: Partial<ContextResourceAdapter>
} = {}) {
    let state = options.state ?? makeState()
    const bytes = defaultBytes()
    const reads = vi.fn(options.readAsset ?? (async (source: ContextAssetSource) => {
        const value = bytes.get(source.storageKey)
        if (!value) throw new PluginApiError('NOT_FOUND', 'Asset missing')
        return value.slice()
    }))
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
        ...options.adapterOverrides,
    }
    const granted = new Set(options.grants ?? ['contextAssets', 'installedModulesRead'])
    const permissionCalls: string[] = []
    const service = new ContextResourceService(
        {
            ...pluginContext(options.principalId ?? crypto.randomUUID()),
            ...(options.instanceId ? { instanceId: options.instanceId } : {}),
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
            readCoordinator: options.readCoordinator,
            queryCaptureCache: options.queryCaptureCache,
            getPermissionGeneration: options.getPermissionGeneration,
            assetAuthorityRegistry: options.assetAuthorityRegistry,
        } as any,
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
    it('dispatches a registered Studio handle without probing current-context state', async () => {
        const authority = {
            lookup: vi.fn(() => ({
                principalId: 'registry-principal', instanceId: 'registry-instance',
                assetId: `ctxasset_${'1'.repeat(64)}`,
                authorityKind: 'studio-card-capture',
                revision: `sha256:${'2'.repeat(64)}`,
                name: 'selected.png', mediaType: 'image/png',
                validate: vi.fn(async () => undefined),
                read: vi.fn(async () => new Uint8Array([7, 8, 9])),
            })),
            clearInstance: vi.fn(),
        }
        const h = harness({
            principalId: 'registry-principal', instanceId: 'registry-instance',
            assetAuthorityRegistry: authority,
        })
        await expect(h.service.readContextAsset(`ctxasset_${'1'.repeat(64)}`)).resolves.toMatchObject({
            data: new Uint8Array([7, 8, 9]),
            revision: `sha256:${'2'.repeat(64)}`,
        })
        expect(authority.lookup).toHaveBeenCalledTimes(1)
        expect(h.getState).not.toHaveBeenCalled()
        expect(h.reads).not.toHaveBeenCalled()
    })

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

    it('preserves a 100-item page order while no more than four digest reads are active', async () => {
        const state = makeState()
        state.characters[0].assets = Array.from({ length: 100 }, (_, index) => asset(
            `ordered-${index}`,
            `ordered-${index}`,
            'additional',
        ))
        let active = 0
        let maximumActive = 0
        const h = harness({
            state,
            readCoordinator: new ContextAssetReadCoordinator(),
            readAsset: async (source) => {
                active += 1
                maximumActive = Math.max(maximumActive, active)
                try {
                    await new Promise((resolve) => setTimeout(resolve, 0))
                    return encoder.encode(source.identity)
                } finally {
                    active -= 1
                }
            },
        })

        const result = await h.service.listContextAssets({ moduleScope: 'none', limit: 100 })

        expect(maximumActive).toBe(4)
        expect(result.assets.map((reference) => reference.name)).toEqual(
            Array.from({ length: 100 }, (_, index) => `ordered-${index}.png`),
        )
    })

    it('shares one digest attempt between lists while isolating waiter cancellation', async () => {
        const gate = deferred<Uint8Array>()
        const h = harness({
            readCoordinator: new ContextAssetReadCoordinator(),
            readAsset: async () => gate.promise,
        })
        const cancelled = new AbortController()
        const surviving = new AbortController()

        const first = h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: cancelled.signal,
        })
        const second = h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: surviving.signal,
        })
        await waitFor(() => h.reads.mock.calls.length > 0)
        cancelled.abort()
        gate.resolve(encoder.encode('shared portrait bytes'))

        await expect(first).rejects.toMatchObject({ code: 'ABORTED' })
        await expect(second).resolves.toMatchObject({ assets: [expect.objectContaining({ name: 'portrait.png' })] })
        expect(h.reads).toHaveBeenCalledOnce()
    })

    it('admits at most 128 joined waiters behind one physical digest attempt', async () => {
        let gate = deferred<Uint8Array>()
        const h = harness({
            readCoordinator: new ContextAssetReadCoordinator(),
            readAsset: async () => gate.promise,
        })
        const first = h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        await waitFor(() => h.reads.mock.calls.length === 1)
        const controllers = Array.from({ length: 129 }, () => new AbortController())
        const joined = controllers.map((controller) => h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: controller.signal,
        }))
        const settlements = Promise.allSettled([first, ...joined])
        const overflow = await Promise.race([
            joined[128].then(
                () => ({ code: 'NO_ERROR' }),
                (error: PluginApiError) => ({ code: error.code, retryable: error.retryable }),
            ),
            new Promise<{ code: string }>((resolve) => setTimeout(() => resolve({ code: 'PENDING' }), 50)),
        ])

        for (const controller of controllers) controller.abort()
        gate.resolve(encoder.encode('shared bounded bytes'))
        await settlements

        expect(overflow).toEqual({ code: 'RESOURCE_LIMIT', retryable: true })
        expect(h.reads).toHaveBeenCalledOnce()

        gate = deferred<Uint8Array>()
        h.state.characters[0].assets[0].storageRevision = 'storage:alice-portrait:2'
        const nextOwner = h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        await waitFor(() => h.reads.mock.calls.length === 2)
        const nextController = new AbortController()
        const reused = h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: nextController.signal,
        })
        const reusedOutcome = reused.catch((error: PluginApiError) => error)
        const admission = await Promise.race([
            reused.then(() => 'SETTLED', (error: PluginApiError) => error.code),
            new Promise<'PENDING'>((resolve) => setTimeout(() => resolve('PENDING'), 25)),
        ])
        expect(admission).toBe('PENDING')

        nextController.abort()
        gate.resolve(encoder.encode('next bounded bytes'))
        await expect(nextOwner).resolves.toBeDefined()
        await expect(reusedOutcome).resolves.toMatchObject({ code: 'ABORTED' })
    })

    it('shares joined waiter admission across service instances for one principal', async () => {
        const principalId = '14141414-1414-4414-8414-141414141414'
        const coordinator = new ContextAssetReadCoordinator()
        const gate = deferred<Uint8Array>()
        const firstService = harness({
            principalId,
            instanceId: 'joined-instance-one',
            readCoordinator: coordinator,
            readAsset: async () => gate.promise,
        })
        const secondService = harness({
            principalId,
            instanceId: 'joined-instance-two',
            readCoordinator: coordinator,
            readAsset: async () => gate.promise,
        })
        const owners = [
            firstService.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] }),
            secondService.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] }),
        ]
        await waitFor(() => firstService.reads.mock.calls.length + secondService.reads.mock.calls.length === 2)
        const firstControllers = Array.from({ length: 64 }, () => new AbortController())
        const secondControllers = Array.from({ length: 65 }, () => new AbortController())
        const firstJoined = firstControllers.map((controller) => firstService.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: controller.signal,
        }))
        const secondJoined = secondControllers.map((controller) => secondService.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: controller.signal,
        }))
        const settlements = Promise.allSettled([...owners, ...firstJoined, ...secondJoined])
        const overflow = await Promise.race([
            secondJoined[64].then(
                () => ({ code: 'NO_ERROR' }),
                (error: PluginApiError) => ({ code: error.code, retryable: error.retryable }),
            ),
            new Promise<{ code: string }>((resolve) => setTimeout(() => resolve({ code: 'PENDING' }), 50)),
        ])

        for (const controller of [...firstControllers, ...secondControllers]) controller.abort()
        gate.resolve(encoder.encode('shared principal bytes'))
        await settlements

        expect(overflow).toEqual({ code: 'RESOURCE_LIMIT', retryable: true })
        expect(firstService.reads.mock.calls.length + secondService.reads.mock.calls.length).toBe(2)
    })

    it('shares exactly 128 logical queue slots between digest joiners and unrelated reads', async () => {
        const principalId = '15151515-1515-4515-8515-151515151515'
        const coordinator = new ContextAssetReadCoordinator()
        const h = harness({ principalId, readCoordinator: coordinator })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        h.reads.mockClear()
        h.state.characters[0].assets[0].storageRevision = 'storage:alice-portrait:2'
        const occupied = await occupyAllReadPermits(coordinator, principalId)
        const schedule = vi.spyOn(coordinator, 'schedule')
        const ownerController = new AbortController()
        const sharedOwner = h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: ownerController.signal,
        })
        await waitFor(() => schedule.mock.calls.length === 1)

        const stateReadsBeforeJoin = h.getState.mock.calls.length
        const joinControllers = Array.from({ length: 64 }, () => new AbortController())
        const joiners = joinControllers.map((controller) => h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: controller.signal,
        }))
        await waitFor(() => h.getState.mock.calls.length >= stateReadsBeforeJoin + 128)
        await new Promise((resolve) => setTimeout(resolve, 0))

        const readControllers = Array.from({ length: 64 }, () => new AbortController())
        const unrelated = readControllers.slice(0, 63).map((controller) => h.service.readContextAsset(
            reference.assetId,
            { ifRevision: reference.revision, signal: controller.signal },
        ))
        await waitFor(() => schedule.mock.calls.length === 64)
        const overflow = h.service.readContextAsset(reference.assetId, {
            ifRevision: reference.revision,
            signal: readControllers[63].signal,
        })
        const settlements = Promise.allSettled([sharedOwner, ...joiners, ...unrelated, overflow])
        const overflowResult = await Promise.race([
            overflow.then(
                () => ({ code: 'NO_ERROR' }),
                (error: PluginApiError) => ({ code: error.code, retryable: error.retryable }),
            ),
            new Promise<{ code: string }>((resolve) => setTimeout(() => resolve({ code: 'PENDING' }), 50)),
        ])

        expect(overflowResult).toEqual({ code: 'RESOURCE_LIMIT', retryable: true })

        ownerController.abort()
        for (const controller of [...joinControllers, ...readControllers]) controller.abort()
        await settlements

        let reusableStarted = false
        const reusable = coordinator.schedule({
            owner: { principalId, instanceId: 'capacity-reuse' },
            lane: 'digest',
            run: async () => { reusableStarted = true },
        })
        occupied.releaseOne()
        await reusable
        await occupied.releaseAll()
        expect(reusableStarted).toBe(true)
        expect(h.reads).not.toHaveBeenCalled()
    })

    it('moves a shared digest attempt to a surviving waiter when cancelled permit validation hangs', async () => {
        const principalId = '12121212-1212-4212-8212-121212121212'
        const coordinator = new ContextAssetReadCoordinator()
        const occupied = await occupyAllReadPermits(coordinator, principalId)
        const permissionGate = deferred<void>()
        const dataGate = deferred<Uint8Array>()
        let contextPermissionCalls = 0
        const h = harness({
            principalId,
            readCoordinator: coordinator,
            readAsset: async () => dataGate.promise,
            onPermission: async (permission) => {
                if (permission !== 'contextAssets') return
                contextPermissionCalls += 1
                if (contextPermissionCalls === 3) await permissionGate.promise
            },
        })
        const cancelled = new AbortController()
        const survivor = new AbortController()
        const first = h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: cancelled.signal,
        })
        const firstOutcome = first.catch((error) => error)
        const second = h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait'], signal: survivor.signal,
        })
        await waitFor(() => contextPermissionCalls === 2)
        await new Promise((resolve) => setTimeout(resolve, 0))
        occupied.releaseOne()
        await waitFor(() => contextPermissionCalls === 3)
        cancelled.abort()
        const survivorReachedStorage = await Promise.race([
            vi.waitFor(() => expect(h.reads).toHaveBeenCalledOnce()).then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
        ])

        permissionGate.resolve()
        await waitFor(() => h.reads.mock.calls.length === 1)
        dataGate.resolve(encoder.encode('surviving waiter bytes'))
        await expect(firstOutcome).resolves.toMatchObject({ code: 'ABORTED' })
        await expect(second).resolves.toMatchObject({ assets: [expect.objectContaining({ name: 'portrait.png' })] })
        await occupied.releaseAll()

        expect(survivorReachedStorage).toBe(true)
    })

    it('retains the physical permit through final publication reauthorization', async () => {
        const principalId = '13131313-1313-4313-8313-131313131313'
        const coordinator = new ContextAssetReadCoordinator()
        const publicationGate = deferred<void>()
        let trackExplicitRead = false
        let explicitReadFinished = false
        let publicationEntered = false
        const h = harness({
            principalId,
            readCoordinator: coordinator,
            readAsset: async (source) => {
                if (trackExplicitRead) explicitReadFinished = true
                return encoder.encode(source.identity)
            },
            onPermission: async () => {
                if (!trackExplicitRead || !explicitReadFinished) return
                publicationEntered = true
                await publicationGate.promise
            },
        })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const blockers = Array.from({ length: 3 }, () => deferred<void>())
        const blockerPromises = blockers.map((gate) => coordinator.schedule({
            owner: { principalId, instanceId: 'publication-blocker' },
            lane: 'digest',
            run: async () => gate.promise,
        }))
        await new Promise((resolve) => setTimeout(resolve, 0))
        trackExplicitRead = true
        const pending = h.service.readContextAsset(listed.assets[0].assetId)
        await waitFor(() => publicationEntered)
        let probeStarted = false
        const probe = coordinator.schedule({
            owner: { principalId, instanceId: 'publication-probe' },
            lane: 'digest',
            run: async () => { probeStarted = true },
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        const startedBeforePublication = probeStarted

        publicationGate.resolve()
        await pending
        await probe
        for (const blocker of blockers) blocker.resolve()
        await Promise.all(blockerPromises)

        expect(startedBeforePublication).toBe(false)
    })

    it('stops launching digest workers on cancellation and suppresses active late state writes', async () => {
        const state = makeState()
        state.characters[0].assets = Array.from({ length: 10 }, (_, index) => asset(
            `cancel-${index}`,
            `cancel-${index}`,
            'additional',
        ))
        const gates: Array<ReturnType<typeof deferred<Uint8Array>>> = []
        let completeImmediately = false
        const h = harness({
            state,
            readCoordinator: new ContextAssetReadCoordinator(),
            readAsset: async (source) => {
                if (completeImmediately) return encoder.encode(source.identity)
                const gate = deferred<Uint8Array>()
                gates.push(gate)
                return gate.promise
            },
        })
        const controller = new AbortController()
        const pending = h.service.listContextAssets({
            moduleScope: 'none', limit: 10, signal: controller.signal,
        })
        const rejection = pending.catch((error) => error)

        await waitFor(() => gates.length >= 4)
        controller.abort()
        await Promise.resolve()
        const launchedAtAbort = h.reads.mock.calls.length
        completeImmediately = true
        for (const gate of gates) gate.resolve(encoder.encode('late bytes'))

        await expect(rejection).resolves.toMatchObject({ code: 'ABORTED' })
        expect(launchedAtAbort).toBe(4)
        expect(h.reads).toHaveBeenCalledTimes(4)

        const relisted = await h.service.listContextAssets({ moduleScope: 'none', limit: 10 })
        expect(relisted.assets).toHaveLength(10)
        expect(h.reads).toHaveBeenCalledTimes(14)
    })

    it('requires contextAssets and independently requires installedModulesRead for installed module assets', async () => {
        const missingContext = harness({ grants: ['installedModulesRead'] })
        expect(await errorCode(missingContext.service.listContextAssets({ moduleScope: 'installed' }))).toBe('PERMISSION_DENIED')
        const missingInstalled = harness({ grants: ['contextAssets'] })
        expect(await errorCode(missingInstalled.service.listContextAssets({ moduleScope: 'installed' }))).toBe('PERMISSION_DENIED')
        await expect(missingInstalled.service.listContextAssets({ moduleScope: 'active' })).resolves.toBeDefined()
    })

    it('requires contextAssets again after installed permission resolves before list storage', async () => {
        const state = makeState()
        state.activeModules = []
        state.installedModules = [state.installedModules[1]]
        const installedGate = deferred<void>()
        let installedCalls = 0
        let contextAllowed = true
        const h = harness({
            state,
            readCoordinator: new ContextAssetReadCoordinator(),
            onPermission: async (permission) => {
                if (permission === 'contextAssets' && !contextAllowed) {
                    throw new PluginApiError('PERMISSION_DENIED', 'Context asset permission was revoked')
                }
                if (permission === 'installedModulesRead') {
                    installedCalls += 1
                    if (installedCalls === 2) await installedGate.promise
                }
            },
        })
        const pending = h.service.listContextAssets({ moduleScope: 'installed', include: ['module'] })
        const outcome = pending.catch((error) => error)
        await waitFor(() => installedCalls === 2)

        contextAllowed = false
        installedGate.resolve()

        await expect(outcome).resolves.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(h.reads).not.toHaveBeenCalled()
    })

    it('requires contextAssets again after installed permission resolves before explicit storage', async () => {
        const state = makeState()
        state.installedModules = [state.activeModules[0]]
        const installedGate = deferred<void>()
        let trackRead = false
        let installedCalls = 0
        let contextAllowed = true
        const h = harness({
            state,
            readCoordinator: new ContextAssetReadCoordinator(),
            onPermission: async (permission) => {
                if (!trackRead) return
                if (permission === 'contextAssets' && !contextAllowed) {
                    throw new PluginApiError('PERMISSION_DENIED', 'Context asset permission was revoked')
                }
                if (permission === 'installedModulesRead') {
                    installedCalls += 1
                    if (installedCalls === 2) await installedGate.promise
                }
            },
        })
        const listed = await h.service.listContextAssets({ moduleScope: 'active', include: ['module'] })
        const reference = listed.assets[0]
        h.reads.mockClear()
        state.activeModules = []
        trackRead = true

        const pending = h.service.readContextAsset(reference.assetId, { ifRevision: reference.revision })
        const outcome = pending.catch((error) => error)
        await waitFor(() => installedCalls === 2)

        contextAllowed = false
        installedGate.resolve()

        await expect(outcome).resolves.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(h.reads).not.toHaveBeenCalled()
    })

    it('rechecks list permission after a queued digest permit and before storage', async () => {
        const principalId = '10101010-1010-4010-8010-101010101010'
        const coordinator = new ContextAssetReadCoordinator()
        const occupied = await occupyAllReadPermits(coordinator, principalId)
        let permissionAllowed = true
        const h = harness({
            principalId,
            readCoordinator: coordinator,
            onPermission: () => {
                if (!permissionAllowed) throw new PluginApiError('PERMISSION_DENIED', 'Permission was revoked')
            },
        })
        const pending = h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        await waitFor(() => h.permissionCalls.length === 1)
        permissionAllowed = false
        occupied.releaseOne()

        await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(h.reads).not.toHaveBeenCalled()
        await occupied.releaseAll()
    })

    it('rechecks read selectors after a queued permit and before storage', async () => {
        const principalId = '20202020-2020-4020-8020-202020202020'
        const coordinator = new ContextAssetReadCoordinator()
        const h = harness({ principalId, readCoordinator: coordinator })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        h.reads.mockClear()
        const occupied = await occupyAllReadPermits(coordinator, principalId)
        const schedule = vi.spyOn(coordinator, 'schedule')
        const pending = h.service.readContextAsset(reference.assetId)
        let settled = false
        void pending.then(() => { settled = true }, () => { settled = true })
        await waitFor(() => schedule.mock.calls.length === 1 || settled)
        if (schedule.mock.calls.length === 0) {
            await occupied.releaseAll()
            expect(schedule).toHaveBeenCalledOnce()
        }
        h.state.current!.characterId = 'char-2'
        occupied.releaseOne()

        await expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|PERMISSION_DENIED/) })
        expect(h.reads).not.toHaveBeenCalled()
        await occupied.releaseAll()
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
        expect(h.permissionCalls).toEqual(['contextAssets', 'contextAssets', 'contextAssets'])
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

    it('rechecks contextAssets permission after an active read and before publication', async () => {
        let permissionAllowed = true
        const h = harness({
            readCoordinator: new ContextAssetReadCoordinator(),
            onPermission: () => {
                if (!permissionAllowed) throw new PluginApiError('PERMISSION_DENIED', 'Permission was revoked')
            },
        })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const gate = deferred<Uint8Array>()
        h.reads.mockImplementationOnce(async () => gate.promise)
        const pending = h.service.readContextAsset(listed.assets[0].assetId)
        await waitFor(() => h.reads.mock.calls.length >= 2)
        permissionAllowed = false
        gate.resolve(h.bytes.get('alice-portrait')!.slice())

        await expect(pending).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })

    it.each([
        'selector',
        'storage revision',
        'source identity',
        'origin',
        'module membership',
    ])('fails closed when active-read %s changes before publication', async (change) => {
        const state = makeState()
        const h = harness({ state, readCoordinator: new ContextAssetReadCoordinator() })
        const moduleAsset = change === 'module membership'
        const listed = await h.service.listContextAssets(moduleAsset
            ? { moduleScope: 'active', include: ['module'] }
            : { moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        const storageKey = moduleAsset ? 'module-ref' : 'alice-portrait'
        const gate = deferred<Uint8Array>()
        h.reads.mockImplementationOnce(async () => gate.promise)
        const pending = h.service.readContextAsset(reference.assetId)
        await waitFor(() => h.reads.mock.calls.length >= 2)

        if (change === 'selector') state.current!.characterId = 'char-2'
        if (change === 'storage revision') state.characters[0].assets[0].storageRevision = 'storage:changed'
        if (change === 'source identity') state.characters[0].assets[0].identity = 'replacement-identity'
        if (change === 'origin') {
            const moved = state.characters[0].assets.shift()!
            state.characters[1].assets.push(moved)
        }
        if (change === 'module membership') {
            state.activeModules = []
            state.installedModules = state.installedModules.filter((module) => module.id !== 'module-active')
        }
        gate.resolve(h.bytes.get(storageKey)!.slice())

        await expect(pending).rejects.toMatchObject({
            code: expect.stringMatching(/CONFLICT|PERMISSION_DENIED|NOT_FOUND/),
        })
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
        expect(active.permissionCalls).toEqual([
            'contextAssets', 'contextAssets', 'contextAssets',
        ])

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
        expect(inactive.reads).not.toHaveBeenCalled()
    })

    it('enforces maxBytes while allowing more than 60 sequential reads', async () => {
        const h = harness()
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        await expect(h.service.readContextAsset(reference.assetId, { maxBytes: 33_554_432 })).resolves.toBeDefined()
        expect(await errorCode(h.service.readContextAsset(reference.assetId, { maxBytes: 33_554_433 }))).toBe('RESOURCE_LIMIT')
        expect(await errorCode(h.service.readContextAsset(reference.assetId, { maxBytes: 1 }))).toBe('RESOURCE_LIMIT')

        for (let index = 0; index < 65; index++) {
            await h.service.readContextAsset(reference.assetId)
        }
        expect(h.reads).toHaveBeenCalledTimes(67)
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

    it('rejects unknown handles through one registry lookup without enumerating asset metadata', async () => {
        const state = makeState()
        Object.defineProperty(state.characters[2], 'assets', {
            enumerable: true,
            get: () => { throw new Error('unrelated assets were enumerated') },
        })
        const h = harness({ state })

        await expect(h.service.readContextAsset(`ctxasset_${'0'.repeat(64)}`))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(h.reads).not.toHaveBeenCalled()
        expect(h.getState).not.toHaveBeenCalled()
    })

    it('allows repeated syntactically valid unknown handles without physical I/O', async () => {
        const h = harness()
        const unknownHandle = `ctxasset_${'0'.repeat(64)}`
        for (let index = 0; index < 65; index++) {
            expect(await errorCode(h.service.readContextAsset(unknownHandle))).toBe('NOT_FOUND')
        }
        expect(h.reads).not.toHaveBeenCalled()
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

    it('bounds digest and issued-handle metadata at 8192 and fails closed for evicted handles', async () => {
        const state = makeState()
        state.characters[0].assets = Array.from({ length: 8_194 }, (_, index) => asset(
            `lru-${index}`,
            `lru-${index}`,
            'additional',
        ))
        const h = harness({
            state,
            readCoordinator: new ContextAssetReadCoordinator(),
            readAsset: async (source) => encoder.encode(source.identity),
        })
        const references: Array<{ assetId: string; revision: string }> = []
        let cursor: string | undefined
        do {
            const page = await h.service.listContextAssets({ moduleScope: 'none', limit: 100, cursor })
            references.push(...page.assets.map(({ assetId, revision }) => ({ assetId, revision })))
            cursor = page.nextCursor
        } while (cursor)
        expect(references).toHaveLength(8_194)
        h.reads.mockClear()

        await expect(h.service.readContextAsset(references[0].assetId, {
            ifRevision: references[0].revision,
        })).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(h.reads).not.toHaveBeenCalled()

        await expect(h.service.readContextAsset(references[1].assetId))
            .rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(h.reads).not.toHaveBeenCalled()
    }, 60_000)

    it('rejects known and returned sources over 32 MiB before digest cache or handle publication', async () => {
        const state = makeState()
        state.characters[0].assets = [asset('oversized', 'oversized', 'additional', {
            byteLength: 33_554_433,
        })]
        let returnOversized = false
        const h = harness({
            state,
            readCoordinator: new ContextAssetReadCoordinator(),
            readAsset: async () => returnOversized
                ? new Uint8Array(33_554_433)
                : encoder.encode('bounded bytes'),
        })

        await expect(h.service.listContextAssets({ moduleScope: 'none' }))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(h.reads).not.toHaveBeenCalled()

        delete state.characters[0].assets[0].byteLength
        returnOversized = true
        await expect(h.service.listContextAssets({ moduleScope: 'none' }))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(h.reads).toHaveBeenCalledOnce()

        returnOversized = false
        await expect(h.service.listContextAssets({ moduleScope: 'none' }))
            .resolves.toMatchObject({ assets: [expect.objectContaining({ byteLength: 13 })] })
        expect(h.reads).toHaveBeenCalledTimes(2)
    })

    it('dispose is idempotent, cancels queued work, and rejects future calls', async () => {
        const principalId = '30303030-3030-4030-8030-303030303030'
        const coordinator = new ContextAssetReadCoordinator()
        const h = harness({ principalId, readCoordinator: coordinator })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        h.reads.mockClear()
        const occupied = await occupyAllReadPermits(coordinator, principalId)
        const schedule = vi.spyOn(coordinator, 'schedule')
        const queued = h.service.readContextAsset(listed.assets[0].assetId)
        let settled = false
        void queued.then(() => { settled = true }, () => { settled = true })
        await waitFor(() => schedule.mock.calls.length === 1 || settled)
        if (schedule.mock.calls.length === 0) {
            await occupied.releaseAll()
            expect(schedule).toHaveBeenCalledOnce()
        }

        h.service.dispose()
        h.service.dispose()

        await expect(queued).rejects.toMatchObject({ code: 'ABORTED' })
        await expect(h.service.listContextAssets({ moduleScope: 'none' }))
            .rejects.toMatchObject({ code: 'ABORTED' })
        expect(h.reads).not.toHaveBeenCalled()
        await occupied.releaseAll()
    })

    it('dispose suppresses an active uncancellable completion and cannot be repopulated late', async () => {
        const h = harness({ readCoordinator: new ContextAssetReadCoordinator() })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const gate = deferred<Uint8Array>()
        h.reads.mockImplementationOnce(async () => gate.promise)
        const pending = h.service.readContextAsset(listed.assets[0].assetId)
        await waitFor(() => h.reads.mock.calls.length >= 2)

        h.service.dispose()
        await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
        gate.resolve(h.bytes.get('alice-portrait')!.slice())
        await Promise.resolve()
        await expect(h.service.readContextAsset(listed.assets[0].assetId))
            .rejects.toMatchObject({ code: 'ABORTED' })
        expect(h.reads).toHaveBeenCalledTimes(2)
    })

    it('allows repeated stale-handle checks without a completed-read quota', async () => {
        const state = makeState()
        const h = harness({ state })
        const listed = await h.service.listContextAssets({ moduleScope: 'none', include: ['portrait'] })
        const reference = listed.assets[0]
        h.bytes.set('alice-portrait', encoder.encode('replacement portrait bytes'))
        state.characters[0].assets[0].storageRevision = 'storage:alice-portrait:2'
        for (let index = 0; index < 65; index++) {
            expect(await errorCode(h.service.readContextAsset(reference.assetId))).toBe('CONFLICT')
        }
        expect(h.reads).toHaveBeenCalledTimes(66)
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
        }, expect.any(AbortSignal))
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

describe('opt-in query capture public shape', () => {
    it('keeps no-option module and asset response keys and legacy cursor records byte-for-byte unchanged', async () => {
        const cursors = new CursorRegistry()
        const createCursor = vi.spyOn(cursors, 'create')
        const h = harness({ cursorRegistry: cursors, instanceId: 'legacy-cursor-instance' })

        const modules = await h.service.listContextModules({ scope: 'installed', limit: 1 })
        expect(Object.keys(modules).sort()).toEqual(['items', 'nextCursor'])
        expect(Object.keys(modules.items[0]).sort()).toEqual([
            'activatedBy', 'description', 'id', 'lorebook', 'name', 'namespace', 'revision',
        ])
        expect(createCursor.mock.calls[0]?.slice(1)).toEqual([
            'context-modules',
            'legacy-cursor-instance',
            {
                kind: 'modules', scope: 'installed', characterId: 'char-1',
                conversationId: 'conversation-1', limit: 1,
            },
            { offset: 1 },
        ])

        const assets = await h.service.listContextAssets({ moduleScope: 'none', limit: 1 })
        expect(Object.keys(assets).sort()).toEqual(['assets', 'contextRevision', 'nextCursor'])
        expect(createCursor.mock.calls[1]?.slice(1)).toEqual([
            'context-assets',
            'legacy-cursor-instance',
            {
                kind: 'assets', characterId: 'char-1', conversationId: 'conversation-1',
                include: ['portrait', 'emotion', 'additional', 'module'], moduleScope: 'none',
                mediaTypes: null, limit: 1,
            },
            { offset: 1 },
        ])
    })

    it('adds only the approved opt-in module count and capture fields', async () => {
        const h = harness()
        const page = await h.service.listContextModules({
            scope: 'installed',
            includeAssetCount: true,
            captureScope: 'query',
            limit: 100,
        })

        expect(Object.keys(page).sort()).toEqual(['captureRevision', 'items'])
        expect(page.captureRevision).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(page.items.map((item) => ({
            id: item.id,
            assetCount: item.assetCount,
            assetCollectionRevision: item.assetCollectionRevision,
        }))).toEqual([
            {
                id: 'module-active',
                assetCount: 1,
                assetCollectionRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            },
            {
                id: 'module-installed',
                assetCount: 1,
                assetCollectionRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            },
        ])
    })

    it('adds only captureRevision to an opted-in asset page and filters installed modules by normalized IDs', async () => {
        const h = harness()
        const page = await h.service.listContextAssets({
            moduleScope: 'installed',
            moduleIds: [' module-installed ', 'module-active', 'module-installed'],
            captureScope: 'query',
            include: ['module'],
            limit: 100,
        })

        expect(Object.keys(page).sort()).toEqual(['assets', 'captureRevision', 'contextRevision'])
        expect(page.captureRevision).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(page.assets.map((item) => item.origin)).toEqual([
            { kind: 'module', moduleId: 'module-active' },
            { kind: 'module', moduleId: 'module-installed' },
        ])
    })
})

describe('captured context count, filter, and fence security', () => {
    it('rejects module counts outside installed scope and reports exact and zero counts with ordered metadata revisions', async () => {
        const invalid = harness()
        await expect(invalid.service.listContextModules({ scope: 'active', includeAssetCount: true }))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        expect(invalid.getState).not.toHaveBeenCalled()
        expect(invalid.permissionCalls).toEqual([])

        const state = makeState()
        state.installedModules[0].assets.push(asset('second', 'second', 'module'))
        state.installedModules[1].assets = []
        const first = harness({ state })
        const page = await first.service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 100,
        })
        expect(page.items.map((item) => [item.id, item.assetCount])).toEqual([
            ['module-active', 2], ['module-installed', 0],
        ])
        expect(page.items[0].assetCollectionRevision).not.toBe(page.items[1].assetCollectionRevision)

        const reordered = structuredClone(state)
        reordered.installedModules[0].assets.reverse()
        const second = harness({ state: reordered })
        const reorderedPage = await second.service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 100,
        })
        expect(reorderedPage.items[0].assetCollectionRevision).not.toBe(page.items[0].assetCollectionRevision)
    })

    it('uses installedModulesRead then contextAssets at admission and publication, but degrades to legacy items when contextAssets is denied', async () => {
        const granted = harness()
        await granted.service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 100,
        })
        expect(granted.permissionCalls).toEqual([
            'installedModulesRead', 'contextAssets', 'installedModulesRead', 'contextAssets',
        ])

        const denied = harness({ grants: ['installedModulesRead'] })
        const page = await denied.service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 100,
        })
        expect(denied.permissionCalls).toEqual([
            'installedModulesRead', 'contextAssets', 'installedModulesRead', 'contextAssets',
        ])
        expect(page.items).toHaveLength(2)
        expect(page.items.every((item) => !('assetCount' in item) && !('assetCollectionRevision' in item))).toBe(true)
    })

    it('keeps no-count and denied-count capture revisions independent of module asset metadata', async () => {
        const baseline = makeState()
        const changed = structuredClone(baseline)
        changed.installedModules[1].assets[0].storageRevision = 'storage:installed-ref:changed'

        const firstNoCount = harness({ state: baseline })
        const secondNoCount = harness({ state: changed })
        const firstNoCountPage = await firstNoCount.service.listContextModules({
            scope: 'installed', includeAssetCount: false, captureScope: 'query', limit: 100,
        })
        const secondNoCountPage = await secondNoCount.service.listContextModules({
            scope: 'installed', includeAssetCount: false, captureScope: 'query', limit: 100,
        })
        expect(firstNoCount.permissionCalls).toEqual(['installedModulesRead', 'installedModulesRead'])
        expect(secondNoCount.permissionCalls).toEqual(['installedModulesRead', 'installedModulesRead'])
        expect(secondNoCountPage.captureRevision).toBe(firstNoCountPage.captureRevision)

        const firstDenied = harness({ state: baseline, grants: ['installedModulesRead'] })
        const secondDenied = harness({ state: changed, grants: ['installedModulesRead'] })
        const firstDeniedPage = await firstDenied.service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 100,
        })
        const secondDeniedPage = await secondDenied.service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 100,
        })
        expect(firstDenied.permissionCalls).toEqual([
            'installedModulesRead', 'contextAssets', 'installedModulesRead', 'contextAssets',
        ])
        expect(secondDenied.permissionCalls).toEqual(firstDenied.permissionCalls)
        expect(secondDeniedPage.captureRevision).toBe(firstDeniedPage.captureRevision)
        expect(secondDeniedPage.items.every((item) =>
            !('assetCount' in item) && !('assetCollectionRevision' in item))).toBe(true)
    })

    it('downgrades to an asset-independent capture when count permission is revoked at publication', async () => {
        const state = makeState()
        const baseline = harness({ state })
        const noCount = await baseline.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 100,
        })

        let countPermissionCalls = 0
        const revoked = harness({
            state,
            onPermission(permission) {
                if (permission !== 'contextAssets') return
                countPermissionCalls += 1
                if (countPermissionCalls === 2) {
                    throw new PluginApiError('PERMISSION_DENIED', 'Count permission revoked')
                }
            },
        })
        const page = await revoked.service.listContextModules({
            scope: 'installed', includeAssetCount: true, captureScope: 'query', limit: 100,
        })

        expect(revoked.permissionCalls).toEqual([
            'installedModulesRead', 'contextAssets',
            'installedModulesRead', 'contextAssets',
        ])
        expect(page.captureRevision).toBe(noCount.captureRevision)
        expect(page.items.every((item) =>
            !('assetCount' in item) && !('assetCollectionRevision' in item))).toBe(true)
    })

    it('returns zero module assets for unknown installed module IDs after the exact permission sequence', async () => {
        const h = harness()
        const page = await h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: ['missing'], include: ['module'],
            captureScope: 'query', limit: 100,
        })

        expect(page.assets).toEqual([])
        expect(h.permissionCalls).toEqual([
            'contextAssets', 'installedModulesRead', 'contextAssets',
            'contextAssets', 'installedModulesRead', 'contextAssets',
        ])
        expect(h.reads).not.toHaveBeenCalled()
    })

    it('normalizes module IDs and rejects empty, over-limit, and non-installed filters before storage reads', async () => {
        const h = harness()
        const omitted = await h.service.listContextAssets({
            moduleScope: 'installed', captureScope: 'query', include: ['module'], limit: 100,
        })
        const explicitEmpty = await h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: [], captureScope: 'query', include: ['module'], limit: 100,
        })
        expect(omitted.assets.map((item) => item.origin)).toEqual([
            { kind: 'module', moduleId: 'module-active' },
            { kind: 'module', moduleId: 'module-installed' },
        ])
        expect(explicitEmpty.assets).toEqual([])

        const filtered = await h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: [' module-installed ', 'module-active', 'module-installed'],
            captureScope: 'query', include: ['portrait', 'module'], limit: 100,
        })
        expect(filtered.assets.map((item) => item.origin)).toEqual([
            { kind: 'character', characterId: 'char-1' },
            { kind: 'module', moduleId: 'module-active' },
            { kind: 'module', moduleId: 'module-installed' },
        ])
        await expect(h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: [' '], captureScope: 'query',
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(h.service.listContextAssets({
            moduleScope: 'installed',
            moduleIds: Array.from({ length: 101 }, (_, index) => `module-${index}`),
            captureScope: 'query',
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(h.service.listContextAssets({
            moduleScope: 'installed',
            moduleIds: Array.from({ length: 101 }, () => ' module-installed '),
            captureScope: 'query', include: ['module'], limit: 100,
        })).resolves.toMatchObject({
            assets: [{ origin: { kind: 'module', moduleId: 'module-installed' } }],
        })
        await expect(h.service.listContextAssets({
            moduleScope: 'active', moduleIds: ['module-active'], captureScope: 'query',
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })

    it('runs the full installed permission sequence for an explicit empty module filter', async () => {
        const h = harness()
        await expect(h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: [], include: ['module'], captureScope: 'query', limit: 100,
        })).resolves.toMatchObject({ assets: [] })
        expect(h.permissionCalls).toEqual([
            'contextAssets', 'installedModulesRead', 'contextAssets',
            'contextAssets', 'installedModulesRead', 'contextAssets',
        ])
    })

    it('keeps omitted and explicit-empty module filters in distinct captured cursor identities', async () => {
        const h = harness()
        const omitted = await h.service.listContextAssets({
            moduleScope: 'installed', include: ['module'], captureScope: 'query', limit: 1,
        })
        expect(omitted.nextCursor).toBeTypeOf('string')
        await expect(h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: [], include: ['module'], captureScope: 'query',
            cursor: omitted.nextCursor, limit: 1,
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })

    it('stores only offset and capture revision, accepts a changed page limit, and rejects cursor query mismatch', async () => {
        const state = makeState()
        state.installedModules.push(moduleSource({
            id: 'module-third', name: 'Third', assets: [asset('third', 'third', 'module')], activatedBy: [],
        }))
        const cursors = new CursorRegistry()
        const commitCursor = vi.spyOn(cursors, 'commitPrepared')
        const h = harness({ state, cursorRegistry: cursors })
        const first = await h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        })
        expect(commitCursor.mock.calls[0]?.[1]).toEqual({
            offset: 1,
            captureRevision: first.captureRevision,
        })
        await expect(h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 2, cursor: first.nextCursor,
        })).resolves.toMatchObject({ items: [{ id: 'module-installed' }, { id: 'module-third' }] })

        const mismatch = await h.service.listContextModules({ scope: 'installed', captureScope: 'query', limit: 1 })
        await expect(h.service.listContextModules({
            scope: 'active', captureScope: 'query', limit: 1, cursor: mismatch.nextCursor,
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })

    it('rejects a later module page when its capture expires during publication permission', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const state = makeState()
        state.installedModules.push(moduleSource({
            id: 'module-third', name: 'Third', assets: [], activatedBy: [],
        }))
        let now = 0
        let publicationGateArmed = false
        let publicationPermissionCalls = 0
        const captures = new QueryCaptureCache({ now: () => now, ttlMs: 10 })
        const cursors = new CursorRegistry({ now: () => now, ttlMs: 100 })
        const h = harness({
            state,
            principalId,
            queryCaptureCache: captures,
            cursorRegistry: cursors,
            onPermission() {
                if (!publicationGateArmed) return
                publicationPermissionCalls += 1
                if (publicationPermissionCalls === 2) now = 11
            },
        })
        const first = await h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        })
        expect(first.nextCursor).toBeTypeOf('string')
        publicationGateArmed = true

        await expect(h.service.listContextModules({
            scope: 'installed', captureScope: 'query', cursor: first.nextCursor, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(publicationPermissionCalls).toBe(2)
        expect(cursors.activeCount(principalId)).toBe(0)
    })

    it('preserves an unrelated capture when a later module page loses LRU residency', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const state = makeState()
        state.installedModules.push(moduleSource({
            id: 'module-third', name: 'Third', assets: [], activatedBy: [],
        }))
        const captures = new QueryCaptureCache({ maxCapturesPerPrincipal: 1 })
        const cursors = new CursorRegistry()
        const unrelatedOwner = {
            principalId,
            service: 'context-assets' as const,
            instanceId: 'unrelated-resident-capture',
        }
        const unrelatedQuery = { kind: 'unrelated-resident-query' }
        let unrelatedRevision: string | undefined
        let publicationGateArmed = false
        let publicationPermissionCalls = 0
        const h = harness({
            state,
            principalId,
            queryCaptureCache: captures,
            cursorRegistry: cursors,
            async onPermission() {
                if (!publicationGateArmed) return
                publicationPermissionCalls += 1
                if (publicationPermissionCalls === 2) {
                    unrelatedRevision = (await captures.create(
                        unrelatedOwner, unrelatedQuery, [{ id: 'unrelated-resident-item' }],
                    )).captureRevision
                }
            },
        })
        const first = await h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        })
        expect(first.nextCursor).toBeTypeOf('string')
        publicationGateArmed = true

        await expect(h.service.listContextModules({
            scope: 'installed', captureScope: 'query', cursor: first.nextCursor, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(publicationPermissionCalls).toBe(2)
        expect(cursors.activeCount(principalId)).toBe(0)
        expect(unrelatedRevision).toBeTypeOf('string')
        await expect(captures.read(
            unrelatedOwner, unrelatedQuery, unrelatedRevision!,
        )).resolves.toMatchObject({ items: [{ id: 'unrelated-resident-item' }] })
    })

    it('uses a cursorless final probe, performs no new asset reads, and fails closed on collection drift', async () => {
        const h = harness()
        const first = await h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: ['module-active'], captureScope: 'query', limit: 1,
        })
        const readsAfterCapture = h.reads.mock.calls.length
        const probe = await h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: ['module-active'], captureScope: 'query',
            captureRevision: first.captureRevision, limit: 1,
        })
        expect(probe.captureRevision).toBe(first.captureRevision)
        expect(probe.assets).toHaveLength(1)
        expect(h.reads).toHaveBeenCalledTimes(readsAfterCapture)

        h.state.activeModules[0].assets[0].storageRevision = 'storage:module-ref:changed'
        h.state.installedModules[0].assets[0].storageRevision = 'storage:module-ref:changed'
        await expect(h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: ['module-active'], captureScope: 'query',
            captureRevision: first.captureRevision, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(h.reads).toHaveBeenCalledTimes(readsAfterCapture)
    })

    it('keeps an expected-revision final probe ephemeral and preserves unrelated module captures', async () => {
        const state = makeState()
        const secondActive = moduleSource({
            id: 'module-second-active', name: 'Second active module', activatedBy: ['chat'],
        })
        state.activeModules.push(secondActive)
        state.installedModules.splice(1, 0, secondActive)
        const captures = new QueryCaptureCache()
        const cursors = new CursorRegistry()
        const h = harness({ state, queryCaptureCache: captures, cursorRegistry: cursors })

        const expected = await h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 100,
        })
        const retained = await h.service.listContextModules({
            scope: 'active', captureScope: 'query', limit: 1,
        })
        expect(retained.nextCursor).toBeTypeOf('string')

        state.installedModules[2].name = 'Changed installed-only module'
        await expect(h.service.listContextModules({
            scope: 'installed', captureScope: 'query', captureRevision: expected.captureRevision, limit: 100,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })

        await expect(h.service.listContextModules({
            scope: 'active', captureScope: 'query', cursor: retained.nextCursor, limit: 1,
        })).resolves.toMatchObject({ items: [{ id: 'module-second-active' }] })
    })

    it.each(['expired', 'evicted', 'wrong-owner'] as const)(
        'rejects an %s module capture revision instead of returning an empty successful final probe',
        async (scenario) => {
            let now = 0
            const state = makeState()
            const captures = new QueryCaptureCache({
                maxCapturesPerPrincipal: scenario === 'evicted' ? 1 : 64,
                ttlMs: 10,
                now: () => now,
            })
            const first = harness({
                state,
                principalId: '11111111-1111-4111-8111-111111111111',
                instanceId: 'final-probe-owner',
                queryCaptureCache: captures,
            })
            const expected = await first.service.listContextModules({
                scope: 'active', captureScope: 'query', limit: 1,
            })

            let probe = first
            if (scenario === 'expired') {
                now = 11
            } else if (scenario === 'evicted') {
                await first.service.listContextModules({
                    scope: 'installed', captureScope: 'query', limit: 100,
                })
            } else {
                probe = harness({
                    state,
                    principalId: '22222222-2222-4222-8222-222222222222',
                    instanceId: 'wrong-final-probe-owner',
                    queryCaptureCache: captures,
                })
            }

            await expect(probe.service.listContextModules({
                scope: 'active', captureScope: 'query', captureRevision: expected.captureRevision, limit: 1,
            })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        },
    )

    it('returns the retained nonempty page for a valid matching module final probe', async () => {
        const h = harness()
        const expected = await h.service.listContextModules({
            scope: 'active', captureScope: 'query', limit: 1,
        })
        await expect(h.service.listContextModules({
            scope: 'active', captureScope: 'query', captureRevision: expected.captureRevision, limit: 1,
        })).resolves.toMatchObject({
            captureRevision: expected.captureRevision,
            items: [{ id: 'module-active' }],
        })
    })

    it('keeps an expected-revision asset probe ephemeral and preserves unrelated asset captures', async () => {
        const captures = new QueryCaptureCache()
        const cursors = new CursorRegistry()
        const createCapture = vi.spyOn(captures, 'create')
        const createCursor = vi.spyOn(cursors, 'create')
        const h = harness({ queryCaptureCache: captures, cursorRegistry: cursors })

        const expected = await h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: ['module-active'], captureScope: 'query', limit: 1,
        })
        const retained = await h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait', 'emotion', 'additional'],
            captureScope: 'query', limit: 1,
        })
        expect(retained.nextCursor).toBeTypeOf('string')
        const capturesBeforeProbe = createCapture.mock.calls.length
        const cursorsBeforeProbe = createCursor.mock.calls.length
        const handlesBeforeProbe = (h.service as any).issuedHandles.size

        h.state.activeModules[0].assets[0].storageRevision = 'storage:module-ref:changed'
        h.state.installedModules[0].assets[0].storageRevision = 'storage:module-ref:changed'
        await expect(h.service.listContextAssets({
            moduleScope: 'installed', moduleIds: ['module-active'], captureScope: 'query',
            captureRevision: expected.captureRevision, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })

        expect(createCapture).toHaveBeenCalledTimes(capturesBeforeProbe)
        expect(createCursor).toHaveBeenCalledTimes(cursorsBeforeProbe)
        expect((h.service as any).issuedHandles.size).toBe(handlesBeforeProbe)
        await expect(h.service.listContextAssets({
            moduleScope: 'none', include: ['portrait', 'emotion', 'additional'],
            captureScope: 'query', cursor: retained.nextCursor, limit: 1,
        })).resolves.toMatchObject({ assets: [{ role: 'emotion' }] })
    })

    it.each(['expired', 'evicted'] as const)(
        'rejects a later asset page when its capture is %s during final permission without publishing staged state',
        async (scenario) => {
            const principalId = '11111111-1111-4111-8111-111111111111'
            let now = 0
            let publicationGateArmed = false
            let publicationPermissionCalls = 0
            const captures = new QueryCaptureCache({
                now: () => now,
                ttlMs: 10,
                maxCapturesPerPrincipal: scenario === 'evicted' ? 1 : 64,
            })
            const cursors = new CursorRegistry({ now: () => now, ttlMs: 100 })
            const unrelatedOwner = {
                principalId,
                service: 'context-modules' as const,
                instanceId: 'unrelated-asset-resident-capture',
            }
            const unrelatedQuery = { kind: 'unrelated-asset-resident-query' }
            let unrelatedRevision: string | undefined
            const h = harness({
                principalId,
                queryCaptureCache: captures,
                cursorRegistry: cursors,
                async onPermission() {
                    if (!publicationGateArmed) return
                    publicationPermissionCalls += 1
                    if (publicationPermissionCalls !== 5) return
                    if (scenario === 'expired') now = 11
                    else {
                        unrelatedRevision = (await captures.create(
                            unrelatedOwner, unrelatedQuery, [{ id: 'unrelated-resident-item' }],
                        )).captureRevision
                    }
                },
            })
            const first = await h.service.listContextAssets({
                moduleScope: 'installed', include: ['module'], captureScope: 'query', limit: 1,
            })
            const handlesBefore = (h.service as any).issuedHandles.size
            publicationGateArmed = true

            await expect(h.service.listContextAssets({
                moduleScope: 'installed', include: ['module'], captureScope: 'query',
                cursor: first.nextCursor, limit: 1,
            })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
            expect(publicationPermissionCalls).toBe(9)
            expect(cursors.activeCount(principalId)).toBe(0)
            expect((h.service as any).issuedHandles.size).toBe(handlesBefore)
            if (scenario === 'evicted') {
                await expect(captures.read(unrelatedOwner, unrelatedQuery, unrelatedRevision!))
                    .resolves.toMatchObject({ items: [{ id: 'unrelated-resident-item' }] })
            }
        },
    )

    it('prioritizes an expired later asset capture over final cursor saturation without clearing unrelated state', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const state = makeState()
        state.installedModules.push(moduleSource({
            id: 'module-third',
            name: 'Third installed module',
            assets: [asset('third-ref', 'module-ref', 'module')],
            activatedBy: [],
        }))
        let now = 0
        let publicationGateArmed = false
        let publicationPermissionCalls = 0
        const captures = new QueryCaptureCache({ now: () => now, ttlMs: 10 })
        const cursors = new CursorRegistry({ now: () => now, ttlMs: 100, maxPerPrincipal: 1 })
        const unrelatedOwner = {
            principalId,
            service: 'context-modules' as const,
            instanceId: 'still-live-unrelated-capture',
        }
        const unrelatedQuery = { kind: 'still-live-unrelated-query' }
        let unrelatedRevision: string | undefined
        let unrelatedCursor: string | undefined
        const h = harness({
            state,
            principalId,
            queryCaptureCache: captures,
            cursorRegistry: cursors,
            async onPermission() {
                if (!publicationGateArmed) return
                publicationPermissionCalls += 1
                if (publicationPermissionCalls !== 5) return
                now = 11
                unrelatedRevision = (await captures.create(
                    unrelatedOwner, unrelatedQuery, [{ id: 'still-live-unrelated-item' }],
                )).captureRevision
                unrelatedCursor = await cursors.create(
                    principalId, 'context-assets', unrelatedOwner.instanceId,
                    unrelatedQuery, { offset: 1 },
                )
            },
        })
        const first = await h.service.listContextAssets({
            moduleScope: 'installed', include: ['module'], captureScope: 'query', limit: 1,
        })
        const handlesBefore = (h.service as any).issuedHandles.size
        publicationGateArmed = true

        await expect(h.service.listContextAssets({
            moduleScope: 'installed', include: ['module'], captureScope: 'query',
            cursor: first.nextCursor, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(publicationPermissionCalls).toBe(9)
        expect(cursors.activeCount(principalId)).toBe(1)
        expect((h.service as any).issuedHandles.size).toBe(handlesBefore)
        await expect(captures.read(unrelatedOwner, unrelatedQuery, unrelatedRevision!))
            .resolves.toMatchObject({ items: [{ id: 'still-live-unrelated-item' }] })
        await expect(cursors.read(
            unrelatedCursor!, principalId, 'context-assets', unrelatedOwner.instanceId, unrelatedQuery,
        )).resolves.toEqual({ offset: 1 })
    })

    it('prioritizes an evicted later asset capture over an oversized response without clearing unrelated state', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const state = makeState()
        state.installedModules[1].assets[0].name = 'x'.repeat(524_289)
        let publicationGateArmed = false
        let publicationPermissionCalls = 0
        const captures = new QueryCaptureCache({ maxCapturesPerPrincipal: 1 })
        const cursors = new CursorRegistry()
        const unrelatedOwner = {
            principalId,
            service: 'context-modules' as const,
            instanceId: 'oversized-unrelated-capture',
        }
        const unrelatedQuery = { kind: 'oversized-unrelated-query' }
        let unrelatedRevision: string | undefined
        const h = harness({
            state,
            principalId,
            queryCaptureCache: captures,
            cursorRegistry: cursors,
            async onPermission() {
                if (!publicationGateArmed) return
                publicationPermissionCalls += 1
                if (publicationPermissionCalls !== 5) return
                unrelatedRevision = (await captures.create(
                    unrelatedOwner, unrelatedQuery, [{ id: 'oversized-unrelated-item' }],
                )).captureRevision
            },
        })
        const first = await h.service.listContextAssets({
            moduleScope: 'installed', include: ['module'], captureScope: 'query', limit: 1,
        })
        const handlesBefore = (h.service as any).issuedHandles.size
        publicationGateArmed = true

        await expect(h.service.listContextAssets({
            moduleScope: 'installed', include: ['module'], captureScope: 'query',
            cursor: first.nextCursor, limit: 1,
        })).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(publicationPermissionCalls).toBe(9)
        expect(cursors.activeCount(principalId)).toBe(0)
        expect((h.service as any).issuedHandles.size).toBe(handlesBefore)
        await expect(captures.read(unrelatedOwner, unrelatedQuery, unrelatedRevision!))
            .resolves.toMatchObject({ items: [{ id: 'oversized-unrelated-item' }] })
    })

    it('rejects an asset page when permission generation resets after the final async collection probe', async () => {
        const cursors = new CursorRegistry()
        let permissionGeneration = 0
        let reset = false
        const h = harness({
            cursorRegistry: cursors,
            getPermissionGeneration: () => permissionGeneration,
            adapterOverrides: {
                revalidateAssetCollection: async () => {
                    if (!reset) {
                        reset = true
                        permissionGeneration += 1
                    }
                },
            },
        })

        await expect(h.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })).rejects.toMatchObject({ code: 'ABORTED', retryable: false })
        expect(reset).toBe(true)
        expect(cursors.activeCount((h.service as any).context.principalId)).toBe(0)
        expect((h.service as any).issuedHandles.size).toBe(0)
    })

    it('publishes no module cache or cursor when the aggregate first-page result exceeds its limit', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const state = makeState()
        state.activeModules = [
            moduleSource({ id: 'active-first', name: 'Active first', assets: [] }),
            moduleSource({ id: 'active-second', name: 'Active second', assets: [] }),
        ]
        const largeDescription = 'x'.repeat(500_000)
        state.installedModules = Array.from({ length: 6 }, (_, index) => moduleSource({
            id: `large-${index}`,
            name: `Large ${index}`,
            description: largeDescription,
            assets: [],
            activatedBy: [],
        }))
        const captures = new QueryCaptureCache({ maxCapturesPerPrincipal: 1 })
        const cursors = new CursorRegistry({ maxPerPrincipal: 4 })
        const h = harness({ state, principalId, queryCaptureCache: captures, cursorRegistry: cursors })
        const retained = await h.service.listContextModules({
            scope: 'active', captureScope: 'query', limit: 1,
        })
        expect(retained.nextCursor).toBeTypeOf('string')

        await expect(h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 5,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })

        expect(cursors.activeCount(principalId)).toBe(1)
        await expect(h.service.listContextModules({
            scope: 'active', captureScope: 'query', cursor: retained.nextCursor, limit: 1,
        })).resolves.toMatchObject({ items: [{ id: 'active-second' }] })
    })

    it('preserves unrelated module state when first-page cursor capacity rejects publication', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const state = makeState()
        state.activeModules = [
            moduleSource({ id: 'active-first', name: 'Active first', assets: [] }),
            moduleSource({ id: 'active-second', name: 'Active second', assets: [] }),
        ]
        const captures = new QueryCaptureCache({ maxCapturesPerPrincipal: 1 })
        const cursors = new CursorRegistry({ maxPerPrincipal: 1 })
        const h = harness({ state, principalId, queryCaptureCache: captures, cursorRegistry: cursors })
        const retained = await h.service.listContextModules({
            scope: 'active', captureScope: 'query', limit: 1,
        })
        expect(retained.nextCursor).toBeTypeOf('string')

        await expect(h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', retryable: true })

        expect(cursors.activeCount(principalId)).toBe(1)
        await expect(h.service.listContextModules({
            scope: 'active', captureScope: 'query', cursor: retained.nextCursor, limit: 1,
        })).resolves.toMatchObject({ items: [{ id: 'active-second' }] })
    })

    it('preserves unrelated module state when cursor lifecycle invalidates first-page publication', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const instanceId = 'transaction-lifecycle-instance'
        const state = makeState()
        const captures = new QueryCaptureCache({ maxCapturesPerPrincipal: 1 })
        const cursors = new CursorRegistry({ maxPerPrincipal: 4 })
        const retainedOwner = {
            principalId,
            service: 'context-modules' as const,
            instanceId: 'retained-instance',
        }
        const retainedQuery = { kind: 'retained-module-query' }
        const retainedCapture = await captures.create(
            retainedOwner, retainedQuery, [{ id: 'retained-module' }],
        )
        const retainedCursor = await cursors.create(
            principalId, 'context-modules', retainedOwner.instanceId,
            retainedQuery, { offset: 1 },
        )
        const h = harness({
            state,
            principalId,
            instanceId,
            queryCaptureCache: captures,
            cursorRegistry: cursors,
            adapterOverrides: {
                captureModuleSourcesSynchronously(input) {
                    cursors.clearInstance(principalId, instanceId)
                    return {
                        selectors: { characterId: 'char-1', conversationId: 'conversation-1' },
                        modules: structuredClone(
                            input.scope === 'installed' ? state.installedModules : state.activeModules,
                        ),
                    }
                },
            },
        })

        await expect(h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        })).rejects.toMatchObject({ code: 'ABORTED' })

        await expect(captures.read(
            retainedOwner, retainedQuery, retainedCapture.captureRevision,
        )).resolves.toMatchObject({ items: [{ id: 'retained-module' }] })
        await expect(cursors.read(
            retainedCursor,
            principalId,
            'context-modules',
            retainedOwner.instanceId,
            retainedQuery,
        )).resolves.toEqual({ offset: 1 })
    })

    it('rejects module publication when permission generation resets after authorize resolves', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const instanceId = 'post-authorize-generation-instance'
        const state = makeState()
        const captures = new QueryCaptureCache({ maxCapturesPerPrincipal: 1 })
        const cursors = new CursorRegistry({ maxPerPrincipal: 4 })
        const retainedOwner = {
            principalId,
            service: 'context-modules' as const,
            instanceId: 'retained-generation-instance',
        }
        const retainedQuery = { kind: 'retained-generation-query' }
        const retainedCapture = await captures.create(
            retainedOwner, retainedQuery, [{ id: 'retained-module' }],
        )
        const retainedCursor = await cursors.create(
            principalId, 'context-modules', retainedOwner.instanceId,
            retainedQuery, { offset: 1 },
        )
        let permissionGeneration = 0
        let generationReads = 0
        const h = harness({
            state,
            principalId,
            instanceId,
            queryCaptureCache: captures,
            cursorRegistry: cursors,
            getPermissionGeneration() {
                generationReads += 1
                const observed = permissionGeneration
                if (generationReads === 6) {
                    queueMicrotask(() => { permissionGeneration += 1 })
                }
                return observed
            },
        })

        const outcome = await h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1,
        }).then(
            () => ({ code: 'RESOLVED' }),
            (error: PluginApiError) => ({ code: error.code, retryable: error.retryable }),
        )

        expect(permissionGeneration).toBe(1)
        expect(outcome).toEqual({ code: 'ABORTED', retryable: false })
        expect(cursors.activeCount(principalId)).toBe(1)
        await expect(captures.read(
            retainedOwner, retainedQuery, retainedCapture.captureRevision,
        )).resolves.toMatchObject({ items: [{ id: 'retained-module' }] })
        await expect(cursors.read(
            retainedCursor,
            principalId,
            'context-modules',
            retainedOwner.instanceId,
            retainedQuery,
        )).resolves.toEqual({ offset: 1 })
    })

    it('clears instance captures and cursors on permission-generation change and dispose', async () => {
        let permissionGeneration = 0
        const captures = new QueryCaptureCache()
        const cursors = new CursorRegistry()
        const h = harness({
            queryCaptureCache: captures,
            cursorRegistry: cursors,
            getPermissionGeneration: () => permissionGeneration,
        })
        const first = await h.service.listContextModules({ scope: 'installed', captureScope: 'query', limit: 1 })
        permissionGeneration += 1
        await expect(h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1, cursor: first.nextCursor,
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

        const second = await h.service.listContextModules({ scope: 'installed', captureScope: 'query', limit: 1 })
        h.service.dispose()
        await expect(h.service.listContextModules({
            scope: 'installed', captureScope: 'query', limit: 1, cursor: second.nextCursor,
        })).rejects.toMatchObject({ code: 'ABORTED' })
        await expect(captures.read(
            { principalId: (h.service as any).context.principalId, service: 'context-modules', instanceId: (h.service as any).context.instanceId },
            {
                kind: 'modules-capture', scope: 'installed', characterId: null, conversationId: null,
                includeAssetCount: false, serviceGeneration: 1,
            },
            second.captureRevision,
        )).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('rejects a per-capture item overflow before any asset read or publication', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const captures = new QueryCaptureCache({ maxItemsPerPrincipal: 2 })
        const cursors = new CursorRegistry()
        const unrelatedOwner = {
            principalId: '22222222-2222-4222-8222-222222222222',
            service: 'context-assets' as const,
            instanceId: 'unrelated-item-capture',
        }
        const unrelatedQuery = { kind: 'unrelated-item-capture' }
        const unrelated = await captures.create(unrelatedOwner, unrelatedQuery, [{ id: 'retained' }])
        const h = harness({ principalId, queryCaptureCache: captures, cursorRegistry: cursors })

        await expect(h.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })

        expect(h.reads).not.toHaveBeenCalled()
        expect(cursors.activeCount(principalId)).toBe(0)
        expect((h.service as any).issuedHandles.size).toBe(0)
        expect((captures as any).records.size).toBe(1)
        await expect(captures.read(unrelatedOwner, unrelatedQuery, unrelated.captureRevision))
            .resolves.toEqual(unrelated)
    })

    it('rejects an exact canonical metadata-byte overflow before any asset read', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const state = makeState()
        const capturedItems = state.characters[0].assets.map((source) => ({
            source: { ...source },
            origin: { kind: 'character', characterId: 'char-1' },
        }))
        const exactBytes = canonicalFixtureBytes(capturedItems)
        const captures = new QueryCaptureCache({ maxMetadataBytesPerPrincipal: exactBytes - 1 })
        const cursors = new CursorRegistry()
        const h = harness({ state, principalId, queryCaptureCache: captures, cursorRegistry: cursors })

        await expect(h.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })

        expect(exactBytes).toBeGreaterThan(1)
        expect(h.reads).not.toHaveBeenCalled()
        expect(cursors.activeCount(principalId)).toBe(0)
        expect((h.service as any).issuedHandles.size).toBe(0)
        expect((captures as any).records.size).toBe(0)
    })

    it('reserves residual per-principal item and byte capacity before asset reads', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const state = makeState()
        const capturedItems = state.characters[0].assets.map((source) => ({
            source: { ...source },
            origin: { kind: 'character', characterId: 'char-1' },
        }))
        const retainedItems = [{ retained: 'r'.repeat(64) }]
        const cases = [
            {
                label: 'items',
                cache: () => new QueryCaptureCache({ maxItemsPerPrincipal: capturedItems.length }),
            },
            {
                label: 'bytes',
                cache: () => new QueryCaptureCache({
                    maxMetadataBytesPerPrincipal:
                        canonicalFixtureBytes(retainedItems) + canonicalFixtureBytes(capturedItems) - 1,
                }),
            },
        ]

        for (const { label, cache } of cases) {
            const captures = cache()
            const cursors = new CursorRegistry()
            const retainedOwner = {
                principalId,
                service: 'context-modules' as const,
                instanceId: `retained-residual-${label}`,
            }
            const retainedQuery = { kind: `retained-residual-${label}` }
            const retained = await captures.create(retainedOwner, retainedQuery, retainedItems)
            const h = harness({
                state, principalId, instanceId: `residual-${label}`,
                queryCaptureCache: captures, cursorRegistry: cursors,
            })

            await expect(h.service.listContextAssets({
                moduleScope: 'none', captureScope: 'query', limit: 1,
            })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })

            expect(h.reads, label).not.toHaveBeenCalled()
            expect(cursors.activeCount(principalId), label).toBe(0)
            expect((h.service as any).issuedHandles.size, label).toBe(0)
            expect((captures as any).records.size, label).toBe(1)
            await expect(captures.read(retainedOwner, retainedQuery, retained.captureRevision))
                .resolves.toEqual(retained)
        }
    })

    it('atomically awards one remaining reservation to concurrent captures', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const captures = new QueryCaptureCache({ maxItemsPerPrincipal: 4 })
        const cursors = new CursorRegistry()
        const retainedOwner = {
            principalId,
            service: 'context-modules' as const,
            instanceId: 'retained-concurrent-capacity',
        }
        const retainedQuery = { kind: 'retained-concurrent-capacity' }
        const retained = await captures.create(retainedOwner, retainedQuery, [{ id: 'retained' }])
        const readGate = deferred<Uint8Array>()
        const first = harness({
            principalId, instanceId: 'reservation-winner', queryCaptureCache: captures,
            cursorRegistry: cursors, readAsset: async () => readGate.promise,
        })
        const second = harness({
            principalId, instanceId: 'reservation-loser', queryCaptureCache: captures,
            cursorRegistry: cursors,
        })
        const firstPending = first.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        }).then(
            (value) => ({ ok: true as const, value }),
            (error: PluginApiError) => ({ ok: false as const, error }),
        )
        await waitFor(() => first.reads.mock.calls.length > 0)
        const secondOutcome = await second.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        }).then(
            (value) => ({ ok: true as const, value }),
            (error: PluginApiError) => ({ ok: false as const, error }),
        )
        readGate.resolve(encoder.encode('winner bytes'))
        const firstOutcome = await firstPending

        expect(firstOutcome.ok).toBe(true)
        expect(secondOutcome).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } })
        expect(second.reads).not.toHaveBeenCalled()
        expect((second.service as any).issuedHandles.size).toBe(0)
        expect(cursors.activeCount(principalId)).toBe(1)
        await expect(captures.read(retainedOwner, retainedQuery, retained.captureRevision))
            .resolves.toEqual(retained)
    })

    it('rejects a cold concurrent resident duplicate before asset reads when active metadata fills capacity', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const instanceId = 'resident-duplicate-capacity'
        const captures = new QueryCaptureCache({ maxItemsPerPrincipal: 2 })
        const cursors = new CursorRegistry()
        const capture = {
            moduleScope: 'none' as const,
            include: ['portrait' as const],
            captureScope: 'query' as const,
            limit: 100,
        }
        const seeder = harness({ principalId, instanceId, queryCaptureCache: captures, cursorRegistry: cursors })
        const seeded = await seeder.service.listContextAssets(capture)
        const residentRecord = [...(captures as any).records.values()][0]
        const winnerGate = deferred<Uint8Array>()
        const winner = harness({
            principalId, instanceId, queryCaptureCache: captures, cursorRegistry: cursors,
            readAsset: async () => winnerGate.promise,
        })
        const loser = harness({
            principalId, instanceId, queryCaptureCache: captures, cursorRegistry: cursors,
        })
        const loserAssetReference = vi.spyOn(loser.service as any, 'assetReference')
        const winnerPending = winner.service.listContextAssets(capture).then(
            (value) => ({ ok: true as const, value }),
            (error: PluginApiError) => ({ ok: false as const, error }),
        )
        await waitFor(() => winner.reads.mock.calls.length === 1)
        expect((captures as any).reservations.size).toBe(1)

        const loserOutcome = await loser.service.listContextAssets(capture).then(
            (value) => ({ ok: true as const, value }),
            (error: PluginApiError) => ({ ok: false as const, error }),
        )
        winnerGate.resolve(encoder.encode('winner bytes'))
        const winnerOutcome = await winnerPending

        expect(winnerOutcome).toMatchObject({
            ok: true,
            value: { captureRevision: seeded.captureRevision },
        })
        expect(loserOutcome).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } })
        expect(loserAssetReference).not.toHaveBeenCalled()
        expect(loser.reads).not.toHaveBeenCalled()
        expect((loser.service as any).digestCache.size).toBe(0)
        expect((loser.service as any).digestAttempts.size).toBe(0)
        expect((loser.service as any).issuedHandles.size).toBe(0)
        expect(cursors.activeCount(principalId)).toBe(0)
        expect((captures as any).records.size).toBe(1)
        expect([...(captures as any).records.values()][0]).toBe(residentRecord)
        expect((captures as any).reservations.size).toBe(0)

        seeder.service.dispose()
        winner.service.dispose()
        loser.service.dispose()
    })

    it('releases a reservation when prospective cursor capacity rejects publication', async () => {
        const principalId = '11111111-1111-4111-8111-111111111111'
        const captures = new QueryCaptureCache({ maxItemsPerPrincipal: 3 })
        const saturatedCursors = new CursorRegistry({ maxPerPrincipal: 0 })
        const failed = harness({
            principalId, instanceId: 'cursor-capacity-failure',
            queryCaptureCache: captures, cursorRegistry: saturatedCursors,
        })

        await expect(failed.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', retryable: true })
        expect(failed.reads).toHaveBeenCalledTimes(3)
        expect((failed.service as any).issuedHandles.size).toBe(0)
        expect((captures as any).records.size).toBe(0)
        expect((captures as any).reservations.size).toBe(0)

        const retry = harness({
            principalId, instanceId: 'cursor-capacity-retry',
            queryCaptureCache: captures, cursorRegistry: new CursorRegistry(),
        })
        await expect(retry.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 100,
        })).resolves.toMatchObject({ assets: expect.arrayContaining([expect.any(Object)]) })
    })

    it('rolls back staged asset handles and captures when first-capture materialization fails or is cancelled', async () => {
        let fail = true
        let probes = 0
        const state = makeState()
        const located = state.characters[0].assets.map((source) => ({
            source: { ...source },
            origin: { kind: 'character' as const, characterId: 'char-1' },
        }))
        const abortController = new AbortController()
        const captures = new QueryCaptureCache({ maxItemsPerPrincipal: located.length })
        const h = harness({
            state,
            abortController,
            queryCaptureCache: captures,
            adapterOverrides: {
                captureAssetSources: async () => ({
                    selectors: { characterId: 'char-1', conversationId: 'conversation-1' },
                    assets: located.map(({ source, origin }) => ({ source: { ...source }, origin: { ...origin } })),
                }),
                revalidateAssetSource: async ({ located: candidate }) => {
                    probes += 1
                    if (fail && probes > 3) {
                        throw new PluginApiError('PERMISSION_DENIED', 'Injected permission drift')
                    }
                    return candidate.source
                },
            },
        })
        await expect(h.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect((h.service as any).issuedHandles.size).toBe(0)
        expect((captures as any).reservations.size).toBe(0)

        fail = false
        probes = 0
        await expect(h.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })).resolves.toMatchObject({ assets: [expect.any(Object)] })
        expect((h.service as any).issuedHandles.size).toBeGreaterThan(0)

        const cancelledCaptures = new QueryCaptureCache({ maxItemsPerPrincipal: 3 })
        const cancelled = harness({
            abortController: new AbortController(),
            queryCaptureCache: cancelledCaptures,
            readAsset: async () => {
                cancelled.service.dispose()
                return new Uint8Array([1])
            },
        })
        await expect(cancelled.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })).rejects.toMatchObject({ code: 'ABORTED' })
        expect((cancelled.service as any).issuedHandles.size).toBe(0)
        expect((cancelledCaptures as any).reservations.size).toBe(0)
    })

    it('fails a queued capture on permission-generation drift before physical I/O', async () => {
        const coordinator = new ContextAssetReadCoordinator()
        const blockers = await occupyAllReadPermits(coordinator, 'queued-generation-principal')
        let permissionGeneration = 0
        const h = harness({
            principalId: 'queued-generation-principal',
            readCoordinator: coordinator,
            getPermissionGeneration: () => permissionGeneration,
        })
        const pending = h.service.listContextAssets({
            moduleScope: 'none', captureScope: 'query', limit: 1,
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        permissionGeneration += 1
        blockers.releaseOne()

        await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
        expect(h.reads).not.toHaveBeenCalled()
        await blockers.releaseAll()
    })
})
