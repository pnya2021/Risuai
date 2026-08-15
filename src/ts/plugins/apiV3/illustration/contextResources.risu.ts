import { PluginApiError } from './errors'
import { sniffContextAssetMediaType } from './contextResources'
import type {
    BoundedThumbnailResult,
    CharacterTextSection,
    ContextAssetSource,
    ContextAssetCollectionInput,
    ContextAssetSourceProbe,
    ContextCharacterSource,
    ContextHostState,
    ContextLoreSnapshot,
    ContextModuleSource,
    ContextModuleCollectionInput,
    ContextModuleSourceProbe,
    ContextResourceAdapter,
} from './contextResources'
import type { ModuleActivationReason } from './moduleActivation'

type UnknownRecord = Record<string, any>

interface ModuleSourceLocator {
    scope: 'active' | 'installed'
    ownerId: string
    rawSlotIndex: number
}

interface AssetSourceLocator {
    ownerKind: 'character' | 'module'
    ownerId: string
    ownerRawSlotIndex: number
    rawCollection: 'image' | 'emotionImages' | 'additionalAssets' | 'ccAssets' | 'assets'
    rawSlotIndex: number
    storageKey: string
    storageRevision: string
}

interface ProjectionContext {
    getStorageRevision(storageKey: string): string
    attachAsset(source: ContextAssetSource, locator: Omit<AssetSourceLocator, 'storageKey' | 'storageRevision'>): void
}

export interface RisuContextAdapterDependencies {
    getDatabase(): { characters?: UnknownRecord[]; modules?: UnknownRecord[] }
    getCurrentCharacter(): UnknownRecord | undefined
    getCurrentChat(): UnknownRecord | undefined
    getActiveModulesWithReasons(): Array<{ module: UnknownRecord; activatedBy: ModuleActivationReason[] }>
    readImage(storageKey: string): Promise<Uint8Array | ArrayBuffer | ArrayBufferView | null | undefined>
    getAssetStorageRevision?(storageKey: string): string
    createThumbnail?: ContextResourceAdapter['createThumbnail']
}

const extensionOf = (pathOrName?: string) => {
    if (!pathOrName) return undefined
    const clean = pathOrName.split(/[?#]/, 1)[0]
    const dot = clean.lastIndexOf('.')
    if (dot < 0 || dot === clean.length - 1) return undefined
    return clean.slice(dot + 1).toLowerCase()
}

const mediaTypeOf = (extension?: string) => {
    switch (extension?.toLowerCase()) {
        case 'png': return 'image/png'
        case 'jpg':
        case 'jpeg': return 'image/jpeg'
        case 'webp': return 'image/webp'
        case 'gif': return 'image/gif'
        case 'avif': return 'image/avif'
        case 'svg': return 'image/svg+xml'
        case 'mp3': return 'audio/mpeg'
        case 'wav': return 'audio/wav'
        case 'ogg': return 'audio/ogg'
        case 'mp4': return 'video/mp4'
        case 'webm': return 'video/webm'
        default: return undefined
    }
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const isCanonicalLocalAssetStorageKey = (value: unknown): value is string => {
    if (!nonEmptyString(value) || !value.startsWith('assets/')) return false
    const fileName = value.slice('assets/'.length)
    if (!fileName || fileName === '.' || fileName === '..' || fileName !== fileName.normalize('NFC')) return false
    if (fileName.trim() !== fileName || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(fileName)) return false
    return value === `assets/${fileName}`
}

const mapLorebook = (value: unknown): ContextLoreSnapshot[] => {
    if (!Array.isArray(value)) return []
    return value.map((entry: UnknownRecord, index) => {
        const id = nonEmptyString(entry?.id) ? entry.id : `lore:${index}`
        return {
            id,
            name: nonEmptyString(entry?.comment) ? entry.comment
                : nonEmptyString(entry?.key) ? entry.key
                : id,
            content: typeof entry?.content === 'string' ? entry.content : '',
            enabled: entry?.mode !== 'folder',
        }
    })
}

const CHARACTER_TEXT_FIELDS: Array<{ key: string; label: string; source: string }> = [
    { key: 'description', label: 'Description', source: 'desc' },
    { key: 'personality', label: 'Personality', source: 'personality' },
    { key: 'scenario', label: 'Scenario', source: 'scenario' },
    { key: 'firstMessage', label: 'First message', source: 'firstMessage' },
    { key: 'exampleMessage', label: 'Example message', source: 'exampleMessage' },
    { key: 'creatorNotes', label: 'Creator notes', source: 'creatorNotes' },
    { key: 'systemPrompt', label: 'System prompt', source: 'systemPrompt' },
    { key: 'postHistoryInstructions', label: 'Post-history instructions', source: 'postHistoryInstructions' },
    { key: 'notes', label: 'Notes', source: 'notes' },
    { key: 'additionalText', label: 'Additional text', source: 'additionalText' },
]

const mapTextSections = (character: UnknownRecord): CharacterTextSection[] =>
    CHARACTER_TEXT_FIELDS.flatMap(({ key, label, source }) => nonEmptyString(character[source])
        ? [{ key, label, content: character[source] }]
        : [])

const makeAsset = (
    ownerKind: 'character' | 'module',
    ownerId: string,
    role: ContextAssetSource['role'],
    storageKey: string,
    name: string,
    explicitExtension?: string,
    storageRevision = storageKey,
): ContextAssetSource | null => {
    if (!isCanonicalLocalAssetStorageKey(storageKey)) return null
    const declaredExtension = explicitExtension?.replace(/^\./, '').toLowerCase()
    const extension = (extensionOf(declaredExtension) ?? declaredExtension)
        || extensionOf(name) || extensionOf(storageKey)
    return {
        identity: `${ownerKind}:${ownerId}:${storageKey}`,
        storageKey,
        storageRevision,
        name,
        ...(extension ? { extension } : {}),
        ...(mediaTypeOf(extension) ? { mediaType: mediaTypeOf(extension) } : {}),
        role,
    }
}

const mapCharacterAssets = (
    character: UnknownRecord,
    id: string,
    ownerRawSlotIndex = -1,
    context?: ProjectionContext,
): ContextAssetSource[] => {
    const assets: ContextAssetSource[] = []
    const retain = (
        asset: ContextAssetSource | null,
        rawCollection: AssetSourceLocator['rawCollection'],
        rawSlotIndex: number,
    ) => {
        if (!asset) return
        context?.attachAsset(asset, {
            ownerKind: 'character', ownerId: id, ownerRawSlotIndex, rawCollection, rawSlotIndex,
        })
        assets.push(asset)
    }
    if (nonEmptyString(character.image)) {
        retain(makeAsset(
            'character', id, 'portrait', character.image,
            `${character.name || id}.${extensionOf(character.image) || 'png'}`,
            undefined,
            context?.getStorageRevision(character.image),
        ), 'image', 0)
    }
    if (Array.isArray(character.emotionImages)) {
        character.emotionImages.forEach((entry: unknown, index: number) => {
            if (!Array.isArray(entry) || !nonEmptyString(entry[1])) return
            const name = nonEmptyString(entry[0]) ? entry[0] : `emotion-${index}`
            retain(makeAsset(
                'character', id, 'emotion', entry[1], `${name}.${extensionOf(entry[1]) || 'png'}`,
                undefined, context?.getStorageRevision(entry[1]),
            ), 'emotionImages', index)
        })
    }
    if (Array.isArray(character.additionalAssets)) {
        character.additionalAssets.forEach((entry: unknown, index: number) => {
            if (!Array.isArray(entry) || !nonEmptyString(entry[1])) return
            const name = nonEmptyString(entry[0]) ? entry[0] : `additional-${index}`
            const extension = nonEmptyString(entry[2]) ? entry[2] : undefined
            retain(makeAsset(
                'character', id, 'additional', entry[1], name, extension,
                context?.getStorageRevision(entry[1]),
            ), 'additionalAssets', index)
        })
    }
    if (Array.isArray(character.ccAssets)) {
        character.ccAssets.forEach((entry: UnknownRecord, index: number) => {
            if (!nonEmptyString(entry?.uri)) return
            const name = nonEmptyString(entry?.name) ? entry.name : `card-asset-${index}`
            const extension = nonEmptyString(entry?.ext) ? entry.ext : extensionOf(entry.uri)
            retain(makeAsset(
                'character', id, 'additional', entry.uri, name, extension,
                context?.getStorageRevision(entry.uri),
            ), 'ccAssets', index)
        })
    }
    return assets
}

const mapCharacterAssetAt = (
    character: UnknownRecord,
    locator: AssetSourceLocator,
    context?: ProjectionContext,
) => {
    const id = character.chaId
    if (!nonEmptyString(id)) return null
    const attach = (asset: ContextAssetSource | null) => {
        if (asset) context?.attachAsset(asset, {
            ownerKind: locator.ownerKind,
            ownerId: locator.ownerId,
            ownerRawSlotIndex: locator.ownerRawSlotIndex,
            rawCollection: locator.rawCollection,
            rawSlotIndex: locator.rawSlotIndex,
        })
        return asset
    }
    switch (locator.rawCollection) {
        case 'image': {
            if (!nonEmptyString(character.image)) return null
            const asset = makeAsset(
                'character', id, 'portrait', character.image,
                `${character.name || id}.${extensionOf(character.image) || 'png'}`,
                undefined, context?.getStorageRevision(character.image),
            )
            return attach(asset)
        }
        case 'emotionImages': {
            const entry = Array.isArray(character.emotionImages)
                ? character.emotionImages[locator.rawSlotIndex] : undefined
            if (!Array.isArray(entry) || !nonEmptyString(entry[1])) return null
            const name = nonEmptyString(entry[0]) ? entry[0] : `emotion-${locator.rawSlotIndex}`
            const asset = makeAsset(
                'character', id, 'emotion', entry[1], `${name}.${extensionOf(entry[1]) || 'png'}`,
                undefined, context?.getStorageRevision(entry[1]),
            )
            return attach(asset)
        }
        case 'additionalAssets': {
            const entry = Array.isArray(character.additionalAssets)
                ? character.additionalAssets[locator.rawSlotIndex] : undefined
            if (!Array.isArray(entry) || !nonEmptyString(entry[1])) return null
            const name = nonEmptyString(entry[0]) ? entry[0] : `additional-${locator.rawSlotIndex}`
            const extension = nonEmptyString(entry[2]) ? entry[2] : undefined
            const asset = makeAsset(
                'character', id, 'additional', entry[1], name, extension,
                context?.getStorageRevision(entry[1]),
            )
            return attach(asset)
        }
        case 'ccAssets': {
            const entry = Array.isArray(character.ccAssets) ? character.ccAssets[locator.rawSlotIndex] : undefined
            if (!entry || !nonEmptyString(entry.uri)) return null
            const name = nonEmptyString(entry.name) ? entry.name : `card-asset-${locator.rawSlotIndex}`
            const extension = nonEmptyString(entry.ext) ? entry.ext : extensionOf(entry.uri)
            const asset = makeAsset(
                'character', id, 'additional', entry.uri, name, extension,
                context?.getStorageRevision(entry.uri),
            )
            return attach(asset)
        }
        default: return null
    }
}

const mapCharacter = (
    character: UnknownRecord,
    ownerRawSlotIndex = -1,
    context?: ProjectionContext,
): ContextCharacterSource | null => {
    if (!nonEmptyString(character?.chaId) || !nonEmptyString(character?.name)) return null
    const type = character.type === 'group' ? 'group' : 'character'
    return {
        id: character.chaId,
        type,
        name: character.name,
        textSections: mapTextSections(character),
        lorebook: mapLorebook(character.globalLore),
        ...(type === 'group' && Array.isArray(character.characters)
            ? { groupMemberIds: character.characters.filter(nonEmptyString) }
            : {}),
        assets: mapCharacterAssets(character, character.chaId, ownerRawSlotIndex, context),
    }
}

const mapModuleAssetAt = (
    module: UnknownRecord,
    ownerRawSlotIndex: number,
    rawSlotIndex: number,
    context?: ProjectionContext,
) => {
    const entry = Array.isArray(module.assets) ? module.assets[rawSlotIndex] : undefined
    if (!Array.isArray(entry) || !nonEmptyString(entry[1]) || !nonEmptyString(module.id)) return null
    const name = nonEmptyString(entry[0]) ? entry[0] : `module-asset-${rawSlotIndex}`
    const extension = nonEmptyString(entry[2]) ? entry[2] : undefined
    const asset = makeAsset(
        'module', module.id, 'module', entry[1], name, extension,
        context?.getStorageRevision(entry[1]),
    )
    if (asset) context?.attachAsset(asset, {
        ownerKind: 'module', ownerId: module.id, ownerRawSlotIndex,
        rawCollection: 'assets', rawSlotIndex,
    })
    return asset
}

const mapModule = (
    module: UnknownRecord,
    activatedBy: ModuleActivationReason[],
    ownerRawSlotIndex = -1,
    context?: ProjectionContext,
): ContextModuleSource | null => {
    if (!nonEmptyString(module?.id) || !nonEmptyString(module?.name)) return null
    const assets = Array.isArray(module.assets)
        ? module.assets.flatMap((_entry: unknown, index: number) => {
            const asset = mapModuleAssetAt(module, ownerRawSlotIndex, index, context)
            return asset ? [asset] : []
        })
        : []
    return {
        id: module.id,
        ...(nonEmptyString(module.namespace) ? { namespace: module.namespace } : {}),
        name: module.name,
        description: typeof module.description === 'string' ? module.description : '',
        lorebook: mapLorebook(module.lorebook),
        assets,
        activatedBy: [...activatedBy],
    }
}

const normalizeBinary = (value: Uint8Array | ArrayBuffer | ArrayBufferView | null | undefined) => {
    if (value instanceof Uint8Array) return value.slice()
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    }
    throw new PluginApiError('NOT_FOUND', 'Asset bytes were not found')
}

const assertNotAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new PluginApiError('ABORTED', 'Context asset operation was cancelled')
}

export function createRisuContextResourceAdapter(
    dependencies: RisuContextAdapterDependencies,
): ContextResourceAdapter {
    const moduleLocators = new WeakMap<ContextModuleSource, ModuleSourceLocator>()
    const assetLocators = new WeakMap<ContextAssetSource, AssetSourceLocator>()
    const projectionContext: ProjectionContext = {
        getStorageRevision: (storageKey) => dependencies.getAssetStorageRevision?.(storageKey) ?? storageKey,
        attachAsset(source, locator) {
            assetLocators.set(source, {
                ...locator,
                storageKey: source.storageKey,
                storageRevision: source.storageRevision ?? source.storageKey,
            })
        },
    }
    const changed = () => new PluginApiError(
        'CONFLICT', 'Current context changed while the operation was running', { retryable: true },
    )
    const selectorsFor = (
        characterId: string | undefined,
        conversationId: string | undefined,
        allowMissing: boolean,
    ) => {
        const currentCharacter = dependencies.getCurrentCharacter()
        const currentChat = dependencies.getCurrentChat()
        if (!currentCharacter || !currentChat) {
            if (allowMissing && characterId === undefined && conversationId === undefined) {
                return { characterId: null, conversationId: null }
            }
            throw new PluginApiError('NOT_FOUND', 'No current character or conversation')
        }
        if (!nonEmptyString(currentCharacter.chaId) || !nonEmptyString(currentChat.id)) {
            throw new PluginApiError('INTERNAL', 'Current context IDs were not normalized during database load')
        }
        const authorized = new Set([
            currentCharacter.chaId,
            ...(currentCharacter.type === 'group' && Array.isArray(currentCharacter.characters)
                ? currentCharacter.characters.filter(nonEmptyString) : []),
        ])
        const selectedCharacterId = characterId ?? currentCharacter.chaId
        const selectedConversationId = conversationId ?? currentChat.id
        if (!authorized.has(selectedCharacterId)) {
            throw new PluginApiError('PERMISSION_DENIED', 'Character is outside the current context')
        }
        if (selectedConversationId !== currentChat.id) {
            throw new PluginApiError('PERMISSION_DENIED', 'Conversation is outside the current context')
        }
        return { characterId: selectedCharacterId, conversationId: selectedConversationId }
    }
    const sameSource = (left: ContextAssetSource, right: ContextAssetSource) =>
        JSON.stringify(left) === JSON.stringify(right)

    return {
        async getState(): Promise<ContextHostState> {
            const database = dependencies.getDatabase()
            const currentCharacter = dependencies.getCurrentCharacter()
            const currentChat = dependencies.getCurrentChat()
            let current: ContextHostState['current']
            if (currentCharacter && currentChat) {
                if (!nonEmptyString(currentCharacter.chaId) || !nonEmptyString(currentChat.id)) {
                    throw new PluginApiError('INTERNAL', 'Current context IDs were not normalized during database load')
                }
                current = {
                    characterId: currentCharacter.chaId,
                    conversation: {
                        id: currentChat.id,
                        localLorebook: mapLorebook(currentChat.localLore),
                        selectedModuleIds: Array.isArray(currentChat.modules)
                            ? currentChat.modules.filter(nonEmptyString)
                            : [],
                        messageMembership: Array.isArray(currentChat.message)
                            ? currentChat.message.map((message: UnknownRecord, index: number) =>
                                nonEmptyString(message?.chatId) ? message.chatId : `legacy-message:${index}`)
                            : [],
                    },
                    ...(nonEmptyString(currentChat.bindedPersona) ? { personaId: currentChat.bindedPersona } : {}),
                }
            }

            const characters = (database.characters ?? [])
                .map((character, index) => mapCharacter(character, index, projectionContext))
                .filter((value): value is ContextCharacterSource => value !== null)
            if (currentCharacter && current && !characters.some((character) => character.id === current.characterId)) {
                const projected = mapCharacter(currentCharacter, -1, projectionContext)
                if (projected) characters.unshift(projected)
            }

            const activeRecords = dependencies.getActiveModulesWithReasons()
            const activeModules = activeRecords
                .map(({ module, activatedBy }, index) => mapModule(module, activatedBy, index, projectionContext))
                .filter((value): value is ContextModuleSource => value !== null)
            const activeById = new Map(activeModules.map((module) => [module.id, module.activatedBy]))
            const installedModules = (database.modules ?? [])
                .map((module, index) => mapModule(module, activeById.get(module.id) ?? [], index, projectionContext))
                .filter((value): value is ContextModuleSource => value !== null)
            return {
                ...(current ? { current } : {}),
                characters,
                activeModules,
                installedModules,
            }
        },
        async captureModuleSources(input: ContextModuleCollectionInput) {
            assertNotAborted(input.signal)
            if (input.scope !== 'active' && input.scope !== 'installed') {
                throw new PluginApiError('INVALID_ARGUMENT', 'Invalid module scope')
            }
            const selectors = selectorsFor(
                input.characterId,
                input.conversationId,
                input.scope === 'installed',
            )
            const activeRecords = dependencies.getActiveModulesWithReasons()
            const activeById = new Map(activeRecords.flatMap(({ module, activatedBy }) =>
                nonEmptyString(module?.id) ? [[module.id, activatedBy] as const] : []))
            const records = input.scope === 'installed'
                ? (dependencies.getDatabase().modules ?? []).map((module, rawSlotIndex) => ({
                    module, activatedBy: activeById.get(module?.id) ?? [], rawSlotIndex,
                }))
                : activeRecords.map(({ module, activatedBy }, rawSlotIndex) => ({
                    module, activatedBy, rawSlotIndex,
                }))
            const modules = records.flatMap(({ module, activatedBy, rawSlotIndex }) => {
                assertNotAborted(input.signal)
                const source = mapModule(module, activatedBy, rawSlotIndex, projectionContext)
                if (!source) return []
                moduleLocators.set(source, { scope: input.scope, ownerId: source.id, rawSlotIndex })
                return [source]
            })
            assertNotAborted(input.signal)
            return { selectors, modules }
        },
        async revalidateModuleSource(probe: ContextModuleSourceProbe) {
            assertNotAborted(probe.input.signal)
            const locator = moduleLocators.get(probe.source)
            if (!locator || locator.scope !== probe.input.scope || locator.ownerId !== probe.source.id) throw changed()
            selectorsFor(
                probe.input.characterId,
                probe.input.conversationId,
                probe.input.scope === 'installed',
            )
            const activeRecords = dependencies.getActiveModulesWithReasons()
            let raw: UnknownRecord | undefined
            let activatedBy: ModuleActivationReason[] = []
            if (locator.scope === 'installed') {
                raw = dependencies.getDatabase().modules?.[locator.rawSlotIndex]
                activatedBy = activeRecords.find(({ module }) => module?.id === locator.ownerId)?.activatedBy ?? []
            } else {
                const record = activeRecords[locator.rawSlotIndex]
                raw = record?.module
                activatedBy = record?.activatedBy ?? []
            }
            if (!raw || raw.id !== locator.ownerId) throw changed()
            const current = mapModule(raw, activatedBy, locator.rawSlotIndex, projectionContext)
            if (!current || JSON.stringify(current) !== JSON.stringify(probe.source)) throw changed()
            moduleLocators.set(current, locator)
            assertNotAborted(probe.input.signal)
            return current
        },
        async captureAssetSources(input: ContextAssetCollectionInput) {
            assertNotAborted(input.signal)
            if (!Array.isArray(input.characterIds)) {
                throw new PluginApiError('INVALID_ARGUMENT', 'Character IDs must be an array')
            }
            const defaultCharacterId = dependencies.getCurrentCharacter()?.chaId
            const characterIds = input.characterIds.length > 0
                ? [...input.characterIds]
                : nonEmptyString(defaultCharacterId) ? [defaultCharacterId] : []
            for (const characterId of characterIds) {
                selectorsFor(characterId, input.conversationId || undefined, false)
            }
            const selectors = selectorsFor(characterIds[0], input.conversationId || undefined, false) as {
                characterId: string
                conversationId: string
            }
            const database = dependencies.getDatabase()
            const includeCharacterAssets = input.include.some((role) => role !== 'module')
            const characters = (includeCharacterAssets ? characterIds : []).flatMap((characterId) => {
                let rawSlotIndex = (database.characters ?? []).findIndex((character) => character?.chaId === characterId)
                const raw = rawSlotIndex >= 0
                    ? database.characters![rawSlotIndex]
                    : dependencies.getCurrentCharacter()?.chaId === characterId
                        ? dependencies.getCurrentCharacter() : undefined
                if (!raw) throw new PluginApiError('NOT_FOUND', 'Character was not found')
                const projected = mapCharacter(raw, rawSlotIndex, projectionContext)
                if (!projected) throw new PluginApiError('NOT_FOUND', 'Character was not found')
                return projected.assets.map((source) => ({
                    source,
                    origin: { kind: 'character' as const, characterId },
                }))
            })
            let moduleRecords: Array<{
                module: UnknownRecord
                activatedBy: ModuleActivationReason[]
                rawSlotIndex: number
            }> = []
            if (input.moduleScope === 'installed') {
                const activeById = new Map(dependencies.getActiveModulesWithReasons().flatMap(({ module, activatedBy }) =>
                    nonEmptyString(module?.id) ? [[module.id, activatedBy] as const] : []))
                moduleRecords = (database.modules ?? []).flatMap((module, rawSlotIndex) =>
                    input.moduleIds.length === 0 || input.moduleIds.includes(module?.id)
                        ? [{ module, activatedBy: activeById.get(module?.id) ?? [], rawSlotIndex }]
                        : [])
            } else if (input.moduleScope === 'active') {
                moduleRecords = dependencies.getActiveModulesWithReasons().flatMap(
                    ({ module, activatedBy }, rawSlotIndex) =>
                        input.moduleIds.length === 0 || input.moduleIds.includes(module?.id)
                            ? [{ module, activatedBy, rawSlotIndex }] : [],
                )
            }
            if (input.moduleIds.length > 0) {
                const found = new Set(moduleRecords.flatMap(({ module }) => nonEmptyString(module?.id) ? [module.id] : []))
                if (input.moduleIds.some((moduleId) => !found.has(moduleId))) {
                    throw new PluginApiError('INVALID_ARGUMENT', 'Unknown module ID in context asset filter')
                }
            }
            const modules = moduleRecords.flatMap(({ module, activatedBy, rawSlotIndex }) => {
                assertNotAborted(input.signal)
                const projected = mapModule(module, activatedBy, rawSlotIndex, projectionContext)
                if (!projected) return []
                return projected.assets.map((source) => ({
                    source,
                    origin: { kind: 'module' as const, moduleId: projected.id },
                }))
            })
            const assets = [...characters, ...modules]
                .filter(({ source }) => input.include.includes(source.role))
            assertNotAborted(input.signal)
            return { selectors, assets }
        },
        async revalidateAssetSource(probe: ContextAssetSourceProbe) {
            assertNotAborted(probe.input.signal)
            const locator = assetLocators.get(probe.located.source)
            if (!locator
                || locator.ownerKind !== probe.located.origin.kind
                || locator.ownerId !== (probe.located.origin.kind === 'character'
                    ? probe.located.origin.characterId : probe.located.origin.moduleId)
                || locator.storageKey !== probe.located.source.storageKey
                || locator.storageRevision !== (probe.located.source.storageRevision ?? probe.located.source.storageKey)) {
                throw changed()
            }
            selectorsFor(
                probe.input.characterIds[0],
                probe.input.conversationId || undefined,
                false,
            )
            const database = dependencies.getDatabase()
            let current: ContextAssetSource | null = null
            if (locator.ownerKind === 'module') {
                if (probe.input.moduleScope === 'none'
                    || (probe.input.moduleIds.length > 0 && !probe.input.moduleIds.includes(locator.ownerId))) {
                    throw changed()
                }
                const records = probe.input.moduleScope === 'installed'
                    ? database.modules ?? []
                    : dependencies.getActiveModulesWithReasons().map(({ module }) => module)
                const raw = records[locator.ownerRawSlotIndex]
                if (!raw || raw.id !== locator.ownerId) throw changed()
                current = mapModuleAssetAt(raw, locator.ownerRawSlotIndex, locator.rawSlotIndex, projectionContext)
            } else {
                if (probe.input.characterIds.length > 0 && !probe.input.characterIds.includes(locator.ownerId)) throw changed()
                const raw = locator.ownerRawSlotIndex >= 0
                    ? database.characters?.[locator.ownerRawSlotIndex]
                    : dependencies.getCurrentCharacter()
                if (!raw || raw.chaId !== locator.ownerId) throw changed()
                current = mapCharacterAssetAt(raw, locator, projectionContext)
            }
            if (!current || !sameSource(current, probe.located.source)) throw changed()
            assertNotAborted(probe.input.signal)
            return current
        },
        async readAsset(source, signal) {
            assertNotAborted(signal)
            const storageKey = source.storageKey
            if (!isCanonicalLocalAssetStorageKey(storageKey)) {
                throw new PluginApiError('NOT_FOUND', 'Asset storage key is unavailable')
            }
            const value = await dependencies.readImage(storageKey)
            assertNotAborted(signal)
            return normalizeBinary(value)
        },
        async createThumbnail(source, data, constraints, signal) {
            assertNotAborted(signal)
            if (dependencies.createThumbnail) {
                const result = await dependencies.createThumbnail(source, data, constraints, signal)
                assertNotAborted(signal)
                return result
            }
            const mediaType = sniffContextAssetMediaType(data)
                ?? source.mediaType
                ?? mediaTypeOf(source.extension)
                ?? 'application/octet-stream'
            const result = await createBoundedContextThumbnail(
                data, mediaType, constraints, browserThumbnailEnvironment, signal,
            )
            assertNotAborted(signal)
            return result
        },
    }
}

export function parseImageDimensions(data: Uint8Array, mediaType: string): { width: number; height: number } {
    const invalid = () => { throw new PluginApiError('DECODE_FAILED', 'Unable to read bounded image dimensions') }
    if (mediaType === 'image/png') {
        if (data.byteLength < 24
            || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47
            || data[4] !== 0x0d || data[5] !== 0x0a || data[6] !== 0x1a || data[7] !== 0x0a) return invalid()
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        const width = view.getUint32(16)
        const height = view.getUint32(20)
        if (width < 1 || height < 1) return invalid()
        return { width, height }
    }
    if (mediaType === 'image/jpeg') {
        if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) return invalid()
        let offset = 2
        while (offset + 8 < data.byteLength) {
            if (data[offset] !== 0xff) { offset++; continue }
            const marker = data[offset + 1]
            offset += 2
            if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue
            if (offset + 2 > data.byteLength) return invalid()
            const length = (data[offset] << 8) | data[offset + 1]
            if (length < 2 || offset + length > data.byteLength) return invalid()
            const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
                || (marker >= 0xc5 && marker <= 0xc7)
                || (marker >= 0xc9 && marker <= 0xcb)
                || (marker >= 0xcd && marker <= 0xcf)
            if (isStartOfFrame) {
                if (length < 7) return invalid()
                const height = (data[offset + 3] << 8) | data[offset + 4]
                const width = (data[offset + 5] << 8) | data[offset + 6]
                if (width < 1 || height < 1) return invalid()
                return { width, height }
            }
            offset += length
        }
        return invalid()
    }
    if (mediaType === 'image/webp') {
        if (data.byteLength < 30
            || String.fromCharCode(...data.subarray(0, 4)) !== 'RIFF'
            || String.fromCharCode(...data.subarray(8, 12)) !== 'WEBP') return invalid()
        const chunk = String.fromCharCode(...data.subarray(12, 16))
        if (chunk === 'VP8X') {
            const width = 1 + data[24] + (data[25] << 8) + (data[26] << 16)
            const height = 1 + data[27] + (data[28] << 8) + (data[29] << 16)
            return { width, height }
        }
        if (chunk === 'VP8L' && data[20] === 0x2f) {
            const bits = data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24)
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
        }
        if (chunk === 'VP8 '
            && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
            const width = (data[26] | (data[27] << 8)) & 0x3fff
            const height = (data[28] | (data[29] << 8)) & 0x3fff
            if (width < 1 || height < 1) return invalid()
            return { width, height }
        }
        return invalid()
    }
    return invalid()
}

interface ThumbnailDecodeResult {
    drawable: unknown
    width: number
    height: number
    close?: () => void
}

export interface BoundedThumbnailEnvironment {
    decode(
        data: Uint8Array,
        options: { width: number; height: number; mediaType: string },
    ): Promise<ThumbnailDecodeResult>
    encode(
        drawable: unknown,
        width: number,
        height: number,
        maxOutputBytes: number,
    ): Promise<{ data: Uint8Array; mediaType: string; width: number; height: number }>
}

const targetDimensions = (
    width: number,
    height: number,
    limits: { longEdge: number; maxPixels: number },
) => {
    const edgeScale = Math.min(1, limits.longEdge / Math.max(width, height))
    let targetWidth = Math.max(1, Math.floor(width * edgeScale))
    let targetHeight = Math.max(1, Math.floor(height * edgeScale))
    const pixels = targetWidth * targetHeight
    if (pixels > limits.maxPixels) {
        const pixelScale = Math.sqrt(limits.maxPixels / pixels)
        targetWidth = Math.max(1, Math.floor(targetWidth * pixelScale))
        targetHeight = Math.max(1, Math.floor(targetHeight * pixelScale))
    }
    return { width: targetWidth, height: targetHeight }
}

const canvasBlob = async (canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number) => {
    if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality })
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Canvas encoding failed')), type, quality)
    })
}

const browserThumbnailEnvironment: BoundedThumbnailEnvironment = {
    async decode(data, options) {
        if (typeof createImageBitmap !== 'function') {
            throw new PluginApiError('DECODE_FAILED', 'Bounded image decoding is unavailable')
        }
        const bitmap = await createImageBitmap(
            new Blob([data.slice().buffer], { type: options.mediaType }),
            { resizeWidth: options.width, resizeHeight: options.height, resizeQuality: 'high' },
        )
        if (bitmap.width > options.width || bitmap.height > options.height) {
            bitmap.close()
            throw new PluginApiError('DECODE_FAILED', 'Image decoder ignored bounded resize options')
        }
        return { drawable: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    },
    async encode(drawable, width, height, maxOutputBytes) {
        const canvas = typeof OffscreenCanvas === 'function'
            ? new OffscreenCanvas(width, height)
            : Object.assign(document.createElement('canvas'), { width, height })
        const context = canvas.getContext('2d')
        if (!context) throw new PluginApiError('DECODE_FAILED', 'Canvas encoder is unavailable')
        ;(context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D)
            .drawImage(drawable as CanvasImageSource, 0, 0, width, height)
        for (const quality of [0.92, 0.82, 0.7, 0.55]) {
            const blob = await canvasBlob(canvas, 'image/webp', quality)
            if (blob.size <= maxOutputBytes) {
                return {
                    data: new Uint8Array(await blob.arrayBuffer()),
                    mediaType: blob.type || 'image/webp',
                    width,
                    height,
                }
            }
        }
        throw new PluginApiError('RESOURCE_LIMIT', 'Encoded thumbnail exceeds the output limit')
    },
}

export async function createBoundedContextThumbnail(
    data: Uint8Array,
    mediaType: string,
    limits: { longEdge: number; maxPixels: number; maxOutputBytes: number },
    environment: BoundedThumbnailEnvironment = browserThumbnailEnvironment,
    signal?: AbortSignal,
): Promise<BoundedThumbnailResult> {
    assertNotAborted(signal)
    const source = parseImageDimensions(data, mediaType)
    const target = targetDimensions(source.width, source.height, limits)
    let decoded: ThumbnailDecodeResult | undefined
    try {
        decoded = await environment.decode(data, { ...target, mediaType })
        assertNotAborted(signal)
        if (decoded.width > target.width || decoded.height > target.height) {
            throw new PluginApiError('DECODE_FAILED', 'Image decoder exceeded its bounded target')
        }
        const encoded = await environment.encode(decoded.drawable, decoded.width, decoded.height, limits.maxOutputBytes)
        assertNotAborted(signal)
        const pixels = encoded.width * encoded.height
        if (!(encoded.data instanceof Uint8Array)
            || encoded.data.byteLength > limits.maxOutputBytes
            || Math.max(encoded.width, encoded.height) > limits.longEdge
            || pixels > limits.maxPixels) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Thumbnail encoder exceeded its bounds')
        }
        return { ...encoded, decodedPixels: decoded.width * decoded.height }
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        throw new PluginApiError('DECODE_FAILED', 'Unable to create a bounded thumbnail')
    } finally {
        decoded?.close?.()
    }
}
