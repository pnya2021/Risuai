import { CursorRegistry, illustrationCursorRegistry, type CursorPreparation } from './cursorRegistry'
import { PluginApiError } from './errors'
import { createRevision, validateJsonLimits } from './revision'
import type { PluginExecutionContext } from './permissions'
import type { ModuleActivationReason } from './moduleActivation'
import {
    QueryCaptureCache,
    createSynchronousRevision,
    illustrationQueryCaptureCache,
    type QueryCaptureOwner,
    type QueryCapturePreparation,
} from './queryCaptureCache'
import {
    ContextAssetReadCoordinator,
    contextAssetReadCoordinator,
    type ContextAssetLogicalQueueToken,
} from './contextAssetReadCoordinator'

export type CharacterId = string
export type ConversationId = string
export type Revision = string

export interface ContextLoreSnapshot {
    id: string
    name: string
    content: string
    enabled: boolean
}

export interface CharacterTextSection {
    key: string
    label: string
    content: string
}

export type ContextAssetRole = 'portrait' | 'emotion' | 'additional' | 'module'

export interface ContextAssetSource {
    identity: string
    storageKey: string
    storageRevision?: string
    name: string
    extension?: string
    mediaType?: string
    byteLength?: number
    role: ContextAssetRole
}

export interface ContextCharacterSource {
    id: CharacterId
    type: 'character' | 'group'
    name: string
    textSections: CharacterTextSection[]
    lorebook: ContextLoreSnapshot[]
    groupMemberIds?: CharacterId[]
    assets: ContextAssetSource[]
}

export interface ContextConversationSource {
    id: ConversationId
    localLorebook: ContextLoreSnapshot[]
    selectedModuleIds: string[]
    messageMembership: string[]
}

export interface ContextModuleSource {
    id: string
    namespace?: string
    name: string
    description: string
    lorebook: ContextLoreSnapshot[]
    assets: ContextAssetSource[]
    activatedBy: ModuleActivationReason[]
}

export interface ContextCollectionSelectors {
    characterId: CharacterId | null
    conversationId: ConversationId | null
}

export interface ContextModuleCollectionInput {
    scope: 'active' | 'installed'
    characterId?: CharacterId
    conversationId?: ConversationId
    signal?: AbortSignal
}

export interface ContextModuleCollection {
    selectors: ContextCollectionSelectors
    modules: ContextModuleSource[]
}

export interface ContextAssetCollectionInput {
    characterIds: readonly CharacterId[]
    conversationId: ConversationId
    include: readonly ContextAssetRole[]
    moduleScope: 'active' | 'installed' | 'none'
    moduleIds: readonly string[]
    /** Internal discriminator: omitted public moduleIds means all module sources. */
    moduleIdsSpecified?: boolean
    mediaTypes: readonly string[]
    signal?: AbortSignal
}

export interface ContextLocatedAssetSource {
    source: ContextAssetSource
    origin: ContextAssetRef['origin']
}

export interface ContextAssetCollection {
    selectors: { characterId: CharacterId; conversationId: ConversationId }
    assets: ContextLocatedAssetSource[]
}

export interface ContextModuleSourceProbe {
    source: ContextModuleSource
    input: ContextModuleCollectionInput
}

export interface ContextAssetSourceProbe {
    located: ContextLocatedAssetSource
    input: ContextAssetCollectionInput
}

export interface ContextModuleCollectionProbe {
    selectors: ContextCollectionSelectors
    sources: readonly ContextModuleSource[]
    input: ContextModuleCollectionInput
}

export interface ContextModulePageProbe extends ContextModuleCollectionProbe {
    pageSources: readonly ContextModuleSource[]
}

export interface ContextAssetCollectionProbe {
    selectors: { characterId: CharacterId; conversationId: ConversationId }
    sources: readonly ContextLocatedAssetSource[]
    input: ContextAssetCollectionInput
}

export interface ContextHostState {
    current?: {
        characterId: CharacterId
        conversation: ContextConversationSource
        personaId?: string
    }
    characters: ContextCharacterSource[]
    activeModules: ContextModuleSource[]
    installedModules: ContextModuleSource[]
}

export interface BoundedThumbnailResult {
    data: Uint8Array
    mediaType: string
    width: number
    height: number
    decodedPixels: number
}

export interface ContextResourceAdapter {
    getState(): Promise<ContextHostState>
    resolveCollectionSelectors?(input: {
        characterId?: CharacterId
        conversationId?: ConversationId
        allowMissingCurrent: boolean
        signal?: AbortSignal
    }): Promise<ContextCollectionSelectors>
    captureModuleSources?(input: ContextModuleCollectionInput): Promise<ContextModuleCollection>
    captureModuleSourcesSynchronously?(
        input: ContextModuleCollectionInput,
        options: { includeAssetMetadata: boolean },
    ): ContextModuleCollection
    captureAssetSources?(input: ContextAssetCollectionInput): Promise<ContextAssetCollection>
    revalidateModuleSource?(input: ContextModuleSourceProbe): Promise<ContextModuleSource>
    revalidateAssetSource?(input: ContextAssetSourceProbe): Promise<ContextAssetSource>
    revalidateModuleCollection?(input: ContextModuleCollectionProbe): Promise<void>
    revalidateModulePageSynchronously?(input: ContextModulePageProbe): void
    revalidateAssetCollection?(input: ContextAssetCollectionProbe): Promise<void>
    readAsset(source: ContextAssetSource, signal?: AbortSignal): Promise<Uint8Array>
    createThumbnail(
        source: ContextAssetSource,
        data: Uint8Array,
        constraints: { longEdge: number; maxPixels: number; maxOutputBytes: number },
        signal?: AbortSignal,
    ): Promise<BoundedThumbnailResult>
}

export interface CurrentContextRef {
    characterId: CharacterId
    conversationId: ConversationId
    personaId?: string
    characterRevision: Revision
    conversationRevision: Revision
}

export interface CharacterCardSnapshot {
    id: CharacterId
    revision: Revision
    type: 'character' | 'group'
    name: string
    textSections: CharacterTextSection[]
    lorebook: ContextLoreSnapshot[]
    groupMemberIds?: CharacterId[]
}

export interface ConversationContextSnapshot {
    id: ConversationId
    revision: Revision
    localLorebook: ContextLoreSnapshot[]
    selectedModuleIds: string[]
}

export interface ActiveModuleSummary {
    id: string
    namespace?: string
    name: string
    activatedBy: ModuleActivationReason[]
}

export interface ContextModuleSnapshot extends ActiveModuleSummary {
    revision: Revision
    description: string
    lorebook: ContextLoreSnapshot[]
    assetCount?: number
    assetCollectionRevision?: Revision
}

export interface ContextAssetRef {
    assetId: string
    revision: Revision
    name: string
    extension?: string
    mediaType?: string
    byteLength?: number
    role: ContextAssetRole
    origin:
        | { kind: 'character'; characterId: CharacterId }
        | { kind: 'module'; moduleId: string }
}

export interface CursorPage<T> {
    items: T[]
    nextCursor?: string
}

export interface ContextAssetListOptions {
    characterId?: CharacterId
    conversationId?: ConversationId
    include?: ContextAssetRole[]
    moduleScope?: 'active' | 'installed' | 'none'
    mediaTypes?: string[]
    moduleIds?: string[]
    captureScope?: 'query'
    captureRevision?: Revision
    cursor?: string
    limit?: number
    signal?: AbortSignal
}

export interface ContextAssetReadOptions {
    ifRevision?: Revision
    variant?: 'original' | 'thumbnail'
    maxBytes?: number
    signal?: AbortSignal
}

export interface ContextModuleListOptions {
    characterId?: CharacterId
    conversationId?: ConversationId
    scope?: 'active' | 'installed'
    includeAssetCount?: boolean
    captureScope?: 'query'
    captureRevision?: Revision
    cursor?: string
    limit?: number
}

export interface ContextResourceServiceDependencies {
    requirePermission(permission: 'contextAssets' | 'installedModulesRead'): Promise<void>
    cursorRegistry?: CursorRegistry
    readCoordinator?: ContextAssetReadCoordinator
    queryCaptureCache?: QueryCaptureCache
    getPermissionGeneration?: () => string | number
}

export interface ContextModulePage extends CursorPage<ContextModuleSnapshot> {
    captureRevision?: Revision
}

export interface ContextAssetPage {
    contextRevision: Revision
    assets: ContextAssetRef[]
    nextCursor?: string
    captureRevision?: Revision
}

const MAX_SNAPSHOT_JSON_BYTES = 2_097_152
const MAX_JSON_DEPTH = 32
const MAX_TEXT_FIELD_UTF8_BYTES = 524_288
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const MAX_ACTIVE_MODULES = 100
const DEFAULT_ASSET_READ_BYTES = 16_777_216
const MAX_ASSET_READ_BYTES = 33_554_432
const THUMBNAIL_LONG_EDGE = 512
const MAX_THUMBNAIL_PIXELS = 262_144
const MAX_THUMBNAIL_OUTPUT_BYTES = 1_048_576
const CONTEXT_ASSET_ID_LENGTH = 'ctxasset_'.length + 64
const REVISION_LENGTH = 'sha256:'.length + 64
const CONTEXT_ASSET_ID_PATTERN = /^ctxasset_[0-9a-f]{64}$/
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/
const MAX_LIST_DIGEST_WORKERS = 4
const MAX_DIGEST_RECORDS = 8_192
const MAX_ISSUED_HANDLES = 8_192
const MAX_MODULE_IDS_PER_ASSET_LIST = 100

const textEncoder = new TextEncoder()

function enumerableDataValues(value: object): unknown[] {
    if (Array.isArray(value)) {
        const values: unknown[] = []
        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
            if (descriptor && 'value' in descriptor) values.push(descriptor.value)
        }
        return values
    }
    return Object.values(Object.getOwnPropertyDescriptors(value))
        .filter((descriptor) => descriptor.enumerable && 'value' in descriptor)
        .map((descriptor) => (descriptor as PropertyDescriptor & { value: unknown }).value)
}

export function assertContextSnapshotLimits(value: unknown) {
    const canonical = validateJsonLimits(value, {
        maxDepth: MAX_JSON_DEPTH,
        maxBytes: MAX_SNAPSHOT_JSON_BYTES,
    })
    const stack: unknown[] = [value]
    const seen = new Set<object>()
    while (stack.length > 0) {
        const current = stack.pop()
        if (typeof current === 'string') {
            if (textEncoder.encode(current).byteLength > MAX_TEXT_FIELD_UTF8_BYTES) {
                throw new PluginApiError('RESOURCE_LIMIT', 'Context text field exceeds the advertised limit')
            }
            continue
        }
        if (!current || typeof current !== 'object' || seen.has(current)) continue
        seen.add(current)
        stack.push(...enumerableDataValues(current))
    }
    return canonical
}

const digestBytes = async (data: Uint8Array) => {
    const copy = data.slice()
    const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
    return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

const normalizedMediaType = (value?: string) => {
    if (!value) return undefined
    const mediaType = value.split(';', 1)[0].trim().toLowerCase()
    return mediaType || undefined
}

const mediaTypeFromExtension = (extension?: string) => {
    switch (extension?.replace(/^\./, '').toLowerCase()) {
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

export function sniffContextAssetMediaType(data: Uint8Array): string | undefined {
    if (data.byteLength >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
        && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
    if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
    if (data.byteLength >= 12 && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp'
    if (data.byteLength >= 6) {
        const signature = String.fromCharCode(...data.subarray(0, 6))
        if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
    }
    return undefined
}

const inferMediaType = (source: ContextAssetSource, data: Uint8Array) =>
    sniffContextAssetMediaType(data) ?? normalizedMediaType(source.mediaType)
    ?? mediaTypeFromExtension(source.extension) ?? 'application/octet-stream'

function normalizeLimit(value: number | undefined) {
    if (value === undefined) return DEFAULT_PAGE_SIZE
    if (!Number.isInteger(value) || value <= 0) {
        throw new PluginApiError('INVALID_ARGUMENT', 'Page limit must be a positive integer')
    }
    if (value > MAX_PAGE_SIZE) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Page limit exceeds the advertised maximum', {
            details: { maximum: MAX_PAGE_SIZE },
        })
    }
    return value
}

function normalizeAssetReadBytes(value: number | undefined) {
    if (value === undefined) return DEFAULT_ASSET_READ_BYTES
    if (!Number.isInteger(value) || value <= 0) {
        throw new PluginApiError('INVALID_ARGUMENT', 'maxBytes must be a positive integer')
    }
    if (value > MAX_ASSET_READ_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'maxBytes exceeds the advertised maximum', {
            details: { maximum: MAX_ASSET_READ_BYTES },
        })
    }
    return value
}

function validateAssetReadIdentifiers(assetId: string, ifRevision?: Revision) {
    if (typeof assetId !== 'string'
        || assetId.length !== CONTEXT_ASSET_ID_LENGTH
        || !CONTEXT_ASSET_ID_PATTERN.test(assetId)) {
        throw new PluginApiError('INVALID_ARGUMENT', 'assetId must be an opaque context asset handle')
    }
    if (ifRevision !== undefined && (typeof ifRevision !== 'string'
        || ifRevision.length !== REVISION_LENGTH
        || !REVISION_PATTERN.test(ifRevision))) {
        throw new PluginApiError('INVALID_ARGUMENT', 'ifRevision must be a SHA-256 revision')
    }
}

function copyLorebook(value: readonly ContextLoreSnapshot[]) {
    return value.map((entry) => ({
        id: entry.id,
        name: entry.name,
        content: entry.content,
        enabled: entry.enabled,
    }))
}

function copyTextSections(value: readonly CharacterTextSection[]) {
    return value.map((section) => ({ key: section.key, label: section.label, content: section.content }))
}

interface AssetDigestRecord {
    storageRevision: string
    revision: Revision
    byteLength: number
    mediaType: string
}

interface PageRecord {
    offset: number
}

interface CapturePageRecord extends PageRecord {
    captureRevision: Revision
}

interface LocatedAsset {
    source: ContextAssetSource
    origin: ContextAssetRef['origin']
    activeModule: boolean
}

interface IssuedAssetHandle {
    identity: string
    origin: ContextAssetRef['origin']
}

interface DigestWaiter {
    signal?: AbortSignal
    abortListener?: () => void
    validateBeforeRead?: () => Promise<ContextAssetSource>
    logicalQueueToken?: ContextAssetLogicalQueueToken
}

interface DigestAttempt {
    key: string
    generation: number
    controller: AbortController
    waiters: Set<DigestWaiter>
    promise: Promise<AssetDigestRecord>
    settled: boolean
}

const abortedError = () => new PluginApiError('ABORTED', 'Context asset operation was cancelled')

const sourceLimitError = () => new PluginApiError('RESOURCE_LIMIT', 'Context asset exceeds the hard read limit')

function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
    const value = map.get(key)
    if (value === undefined) return undefined
    map.delete(key)
    map.set(key, value)
    return value
}

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, maximum: number) {
    map.delete(key)
    map.set(key, value)
    while (map.size > maximum) map.delete(map.keys().next().value!)
}

export class ContextResourceService {
    private readonly cursorRegistry: CursorRegistry
    private readonly readCoordinator: ContextAssetReadCoordinator
    private readonly queryCaptureCache: QueryCaptureCache
    private readonly moduleCaptureProjections = new WeakMap<ContextModuleSource, ContextModuleSnapshot>()
    private readonly assetCaptureProjections = new WeakMap<ContextLocatedAssetSource, ContextAssetRef>()
    private readonly digestCache = new Map<string, AssetDigestRecord>()
    private readonly issuedHandles = new Map<string, IssuedAssetHandle>()
    private readonly digestAttempts = new Map<string, DigestAttempt>()
    private readonly abortCleanup: () => void
    private disposed = false
    private generation = 0
    private captureGeneration = 0
    private permissionGeneration: string | number

    constructor(
        private readonly context: PluginExecutionContext,
        private readonly adapter: ContextResourceAdapter,
        private readonly dependencies: ContextResourceServiceDependencies,
    ) {
        this.cursorRegistry = dependencies.cursorRegistry ?? illustrationCursorRegistry
        this.readCoordinator = dependencies.readCoordinator ?? contextAssetReadCoordinator
        this.queryCaptureCache = dependencies.queryCaptureCache ?? illustrationQueryCaptureCache
        this.permissionGeneration = dependencies.getPermissionGeneration?.() ?? 0
        this.abortCleanup = () => this.dispose()
        context.signal.addEventListener('abort', this.abortCleanup, { once: true })
        if (context.signal.aborted) this.dispose()
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.generation += 1
        this.context.signal.removeEventListener('abort', this.abortCleanup)
        for (const attempt of [...this.digestAttempts.values()]) {
            for (const waiter of [...attempt.waiters]) this.removeDigestWaiter(attempt, waiter)
            attempt.controller.abort()
        }
        this.digestAttempts.clear()
        this.digestCache.clear()
        this.issuedHandles.clear()
        this.cursorRegistry.clearInstance(this.context.principalId, this.context.instanceId)
        this.queryCaptureCache.clearInstance(this.context.principalId, this.context.instanceId)
        this.readCoordinator.cancelInstance({
            principalId: this.context.principalId,
            instanceId: this.context.instanceId,
        })
    }

    private assertActive(generation = this.generation, signal?: AbortSignal) {
        if (this.disposed || generation !== this.generation || this.context.signal.aborted || signal?.aborted) {
            throw abortedError()
        }
    }

    private async fenced<T>(promise: Promise<T>, generation: number, signal?: AbortSignal) {
        this.assertActive(generation, signal)
        const value = await promise
        this.assertActive(generation, signal)
        return value
    }

    private async permission(
        permission: 'contextAssets' | 'installedModulesRead',
        generation: number,
        signal?: AbortSignal,
    ) {
        this.assertActive(generation, signal)
        this.refreshCaptureGeneration()
        this.assertActive(generation, signal)
        await this.fenced(this.dependencies.requirePermission(permission), generation, signal)
        this.refreshCaptureGeneration()
        this.assertActive(generation, signal)
    }

    private async state(generation = this.generation, signal?: AbortSignal) {
        this.assertActive(generation, signal)
        const state = await this.adapter.getState()
        this.assertActive(generation, signal)
        return state
    }

    private current(state: ContextHostState) {
        if (!state.current) throw new PluginApiError('NOT_FOUND', 'No current character or conversation')
        const character = state.characters.find((item) => item.id === state.current!.characterId)
        if (!character) throw new PluginApiError('NOT_FOUND', 'Current character was not found')
        return { current: state.current, character }
    }

    private authorizedCharacterIds(state: ContextHostState) {
        const { character } = this.current(state)
        return new Set([character.id, ...(character.type === 'group' ? character.groupMemberIds ?? [] : [])])
    }

    private resolveSelectors(
        state: ContextHostState,
        selectors: { characterId?: CharacterId; conversationId?: ConversationId },
    ) {
        const { current, character } = this.current(state)
        const characterId = selectors.characterId ?? character.id
        if (!this.authorizedCharacterIds(state).has(characterId)) {
            throw new PluginApiError('PERMISSION_DENIED', 'Character is outside the current context')
        }
        const conversationId = selectors.conversationId ?? current.conversation.id
        if (conversationId !== current.conversation.id) {
            throw new PluginApiError('PERMISSION_DENIED', 'Conversation is outside the current context')
        }
        return { characterId, conversationId }
    }

    private async characterSnapshot(source: ContextCharacterSource): Promise<CharacterCardSnapshot> {
        const base = {
            id: source.id,
            type: source.type,
            name: source.name,
            textSections: copyTextSections(source.textSections),
            lorebook: copyLorebook(source.lorebook),
            ...(source.type === 'group' ? { groupMemberIds: [...(source.groupMemberIds ?? [])] } : {}),
        }
        assertContextSnapshotLimits(base)
        const snapshot = { ...base, revision: await createRevision(base) }
        assertContextSnapshotLimits(snapshot)
        return snapshot
    }

    private async conversationSnapshot(source: ContextConversationSource): Promise<ConversationContextSnapshot> {
        const base = {
            id: source.id,
            localLorebook: copyLorebook(source.localLorebook),
            selectedModuleIds: [...source.selectedModuleIds],
        }
        const revisionValue = { ...base, messageMembership: [...source.messageMembership] }
        assertContextSnapshotLimits(revisionValue)
        const snapshot = { ...base, revision: await createRevision(revisionValue) }
        assertContextSnapshotLimits(snapshot)
        return snapshot
    }

    private activeSummary(source: ContextModuleSource): ActiveModuleSummary {
        return {
            id: source.id,
            ...(source.namespace ? { namespace: source.namespace } : {}),
            name: source.name,
            activatedBy: [...source.activatedBy],
        }
    }

    private moduleSnapshot(
        source: ContextModuleSource,
        includeAssetCount = false,
    ): ContextModuleSnapshot {
        const base = {
            ...this.activeSummary(source),
            description: source.description,
            lorebook: copyLorebook(source.lorebook),
            ...(includeAssetCount ? {
                assetCount: source.assets.length,
                assetCollectionRevision: createSynchronousRevision(source.assets.map((asset) => ({
                    origin: { kind: 'module', moduleId: source.id },
                    identity: asset.identity,
                    storageKey: asset.storageKey,
                    storageRevision: this.storageRevision(asset),
                    role: asset.role,
                    name: asset.name,
                    ...(asset.extension ? { extension: asset.extension } : {}),
                    ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
                    ...(asset.byteLength !== undefined ? { byteLength: asset.byteLength } : {}),
                }))),
            } : {}),
        }
        assertContextSnapshotLimits(base)
        const snapshot = { ...base, revision: createSynchronousRevision(base) }
        assertContextSnapshotLimits(snapshot)
        return snapshot
    }

    private moduleSourceIdentity(source: ContextModuleSource, includeAssetMetadata = true) {
        return JSON.stringify([
            source.id,
            source.namespace ?? null,
            source.name,
            source.description,
            source.lorebook.map((entry) => [entry.id, entry.name, entry.content, entry.enabled]),
            includeAssetMetadata
                ? source.assets.map((asset) => [
                    asset.identity,
                    asset.storageKey,
                    this.storageRevision(asset),
                    asset.role,
                ])
                : null,
        ])
    }

    private async currentRef(state: ContextHostState): Promise<CurrentContextRef> {
        const { current, character } = this.current(state)
        const [card, conversation] = await Promise.all([
            this.characterSnapshot(character),
            this.conversationSnapshot(current.conversation),
        ])
        return {
            characterId: card.id,
            conversationId: conversation.id,
            ...(current.personaId ? { personaId: current.personaId } : {}),
            characterRevision: card.revision,
            conversationRevision: conversation.revision,
        }
    }

    private async contextRevision(state: ContextHostState) {
        if (state.activeModules.length > MAX_ACTIVE_MODULES) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Too many active modules')
        }
        const current = await this.currentRef(state)
        const modules = await Promise.all(state.activeModules.map(async (module) => ({
            id: module.id,
            revision: (await this.moduleSnapshot(module)).revision,
            activatedBy: [...module.activatedBy],
        })))
        return createRevision({ current, modules })
    }

    private contextChanged() {
        return new PluginApiError('CONFLICT', 'Current context changed while the operation was running', {
            retryable: true,
        })
    }

    private sameSelectors(
        left: ContextCollectionSelectors,
        right: ContextCollectionSelectors,
    ) {
        return left.characterId === right.characterId && left.conversationId === right.conversationId
    }

    async getCurrentContext(): Promise<CurrentContextRef> {
        const preflight = await this.state()
        this.current(preflight)
        await this.dependencies.requirePermission('contextAssets')
        for (let attempt = 0; attempt < 4; attempt++) {
            const state = await this.state()
            const expected = this.resolveSelectors(state, {})
            const snapshot = await this.currentRef(state)
            const fresh = await this.state()
            const actual = this.resolveSelectors(fresh, {})
            if (this.sameSelectors(expected, actual)) return snapshot
        }
        throw this.contextChanged()
    }

    async getCharacterCardSnapshot(characterId?: CharacterId): Promise<CharacterCardSnapshot> {
        const preflight = await this.state()
        this.current(preflight)
        await this.dependencies.requirePermission('contextAssets')
        for (let attempt = 0; attempt < 4; attempt++) {
            const state = await this.state()
            const selectors = this.resolveSelectors(state, { characterId })
            const source = state.characters.find((item) => item.id === selectors.characterId)
            if (!source) throw new PluginApiError('NOT_FOUND', 'Character was not found')
            const snapshot = await this.characterSnapshot(source)
            const fresh = await this.state()
            const actual = this.resolveSelectors(fresh, { characterId })
            if (this.sameSelectors(selectors, actual)) return snapshot
        }
        throw this.contextChanged()
    }

    async getConversationContextSnapshot(conversationId?: ConversationId): Promise<ConversationContextSnapshot> {
        const preflight = await this.state()
        this.current(preflight)
        await this.dependencies.requirePermission('contextAssets')
        for (let attempt = 0; attempt < 4; attempt++) {
            const state = await this.state()
            const selectors = this.resolveSelectors(state, { conversationId })
            const snapshot = await this.conversationSnapshot(this.current(state).current.conversation)
            const fresh = await this.state()
            const actual = this.resolveSelectors(fresh, { conversationId })
            if (this.sameSelectors(selectors, actual)) return snapshot
        }
        throw this.contextChanged()
    }

    async getActiveModules(options: { characterId?: CharacterId; conversationId?: ConversationId } = {}) {
        const preflight = await this.state()
        this.current(preflight)
        await this.dependencies.requirePermission('contextAssets')
        const state = await this.state()
        this.resolveSelectors(state, options)
        if (state.activeModules.length > MAX_ACTIVE_MODULES) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Too many active modules')
        }
        const result = state.activeModules.map((module) => this.activeSummary(module))
        assertContextSnapshotLimits(result)
        return result
    }

    private async page<T>(
        service: string,
        query: unknown,
        limit: number,
        cursor: string | undefined,
        createItems: (offset: number, limit: number) => Promise<{
            items: T[]
            nextOffset?: number
            contextRevision?: Revision
        }>,
    ): Promise<{ items: T[]; nextCursor?: string; contextRevision?: Revision }> {
        let record: PageRecord
        if (cursor) {
            record = await this.cursorRegistry.read<PageRecord>(
                cursor,
                this.context.principalId,
                service,
                this.context.instanceId,
                query,
            )
            this.cursorRegistry.clear(cursor)
        } else {
            record = { offset: 0 }
        }
        const created = await createItems(record.offset, limit)
        let nextCursor: string | undefined
        if (created.nextOffset !== undefined) {
            nextCursor = await this.cursorRegistry.create(
                this.context.principalId,
                service,
                this.context.instanceId,
                query,
                { offset: created.nextOffset },
            )
        }
        return {
            items: created.items,
            ...(nextCursor ? { nextCursor } : {}),
            ...(created.contextRevision ? { contextRevision: created.contextRevision } : {}),
        }
    }

    private refreshCaptureGeneration() {
        const permissionGeneration = this.dependencies.getPermissionGeneration?.() ?? this.permissionGeneration
        if (permissionGeneration === this.permissionGeneration) return
        this.permissionGeneration = permissionGeneration
        this.captureGeneration += 1
        this.generation += 1
        this.queryCaptureCache.clearInstance(this.context.principalId, this.context.instanceId)
        this.cursorRegistry.clearInstance(this.context.principalId, this.context.instanceId)
        this.readCoordinator.cancelInstance({
            principalId: this.context.principalId,
            instanceId: this.context.instanceId,
        })
    }

    private captureOwner(service: QueryCaptureOwner['service']): QueryCaptureOwner {
        return {
            principalId: this.context.principalId,
            service,
            instanceId: this.context.instanceId,
        }
    }

    private async resolveCaptureSelectors(
        input: {
            characterId?: CharacterId
            conversationId?: ConversationId
            allowMissingCurrent: boolean
            signal?: AbortSignal
        },
        generation: number,
    ): Promise<ContextCollectionSelectors> {
        if (this.adapter.resolveCollectionSelectors) {
            return this.fenced(this.adapter.resolveCollectionSelectors(input), generation, input.signal)
        }
        const state = await this.state(generation, input.signal)
        if (state.current) return this.resolveSelectors(state, input)
        if (input.allowMissingCurrent && input.characterId === undefined && input.conversationId === undefined) {
            return { characterId: null, conversationId: null }
        }
        throw new PluginApiError('NOT_FOUND', 'No current character or conversation')
    }

    private normalizeCaptureOptions(captureScope: unknown, captureRevision: unknown) {
        if (captureScope !== undefined && captureScope !== 'query') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid context query capture scope')
        }
        if (captureRevision !== undefined && (typeof captureRevision !== 'string'
            || captureRevision.length !== REVISION_LENGTH || !REVISION_PATTERN.test(captureRevision))) {
            throw new PluginApiError('INVALID_ARGUMENT', 'captureRevision must be a SHA-256 revision')
        }
        if (captureRevision !== undefined && captureScope !== 'query') {
            throw new PluginApiError('INVALID_ARGUMENT', 'captureRevision requires query capture scope')
        }
        return captureScope === 'query'
    }

    private copyModuleSource(source: ContextModuleSource, includeAssetMetadata = true): ContextModuleSource {
        return {
            id: source.id,
            ...(source.namespace ? { namespace: source.namespace } : {}),
            name: source.name,
            description: source.description,
            lorebook: copyLorebook(source.lorebook),
            assets: includeAssetMetadata ? source.assets.map((asset) => ({ ...asset })) : [],
            activatedBy: [...source.activatedBy],
        }
    }

    private async captureModuleCollection(
        input: ContextModuleCollectionInput,
        generation: number,
        includeAssetMetadata = true,
    ): Promise<ContextModuleCollection> {
        if (this.adapter.captureModuleSources) {
            const collection = await this.fenced(
                this.adapter.captureModuleSources(input), generation, input.signal,
            )
            return includeAssetMetadata ? collection : {
                selectors: collection.selectors,
                modules: collection.modules.map((source) => this.copyModuleSource(source, false)),
            }
        }
        const state = await this.state(generation, input.signal)
        let selectors: ContextCollectionSelectors
        if (state.current) {
            selectors = this.resolveSelectors(state, input)
        } else {
            if (input.scope !== 'installed' || input.characterId !== undefined || input.conversationId !== undefined) {
                throw new PluginApiError('NOT_FOUND', 'No current character or conversation')
            }
            selectors = { characterId: null, conversationId: null }
        }
        const modules = input.scope === 'installed' ? state.installedModules : state.activeModules
        return {
            selectors,
            modules: modules.map((source) => this.copyModuleSource(source, includeAssetMetadata)),
        }
    }

    private async revalidateCapturedModuleCollection(
        sources: readonly ContextModuleSource[],
        selectors: ContextCollectionSelectors,
        input: ContextModuleCollectionInput,
        generation: number,
        includeAssetMetadata = true,
    ) {
        if (this.adapter.revalidateModuleCollection) {
            await this.fenced(
                this.adapter.revalidateModuleCollection({ sources, selectors, input }),
                generation,
                input.signal,
            )
            return
        }
        const current = await this.captureModuleCollection(input, generation, includeAssetMetadata)
        if (!this.sameSelectors(selectors, current.selectors)
            || current.modules.length !== sources.length
            || current.modules.some((source, index) =>
                this.moduleSourceIdentity(source, includeAssetMetadata)
                    !== this.moduleSourceIdentity(sources[index], includeAssetMetadata))) {
            throw this.contextChanged()
        }
    }

    private async listCapturedContextModules(
        options: ContextModuleListOptions,
        scope: 'active' | 'installed',
        limit: number,
    ): Promise<CursorPage<ContextModuleSnapshot> & { captureRevision?: Revision }> {
        this.refreshCaptureGeneration()
        const generation = this.generation
        this.assertActive(generation)
        if (options.includeAssetCount !== undefined && typeof options.includeAssetCount !== 'boolean') {
            throw new PluginApiError('INVALID_ARGUMENT', 'includeAssetCount must be a boolean')
        }
        if (options.includeAssetCount && scope !== 'installed') {
            throw new PluginApiError('INVALID_ARGUMENT', 'includeAssetCount is available only for installed modules')
        }
        const requestedCounts = options.includeAssetCount === true
        let countsAuthorized = requestedCounts
        const authorize = async (allowCountPromotion: boolean) => {
            if (scope === 'installed') {
                await this.permission('installedModulesRead', generation)
                if (requestedCounts) {
                    try {
                        await this.permission('contextAssets', generation)
                        if (allowCountPromotion) countsAuthorized = true
                    } catch (error) {
                        if (!(error instanceof PluginApiError) || error.code !== 'PERMISSION_DENIED') throw error
                        countsAuthorized = false
                    }
                }
            } else {
                await this.permission('contextAssets', generation)
            }
        }
        await authorize(true)

        const selectors = await this.resolveCaptureSelectors({
            characterId: options.characterId,
            conversationId: options.conversationId,
            allowMissingCurrent: scope === 'installed',
        }, generation)
        const inputFor = (): ContextModuleCollectionInput => ({
            scope,
            ...(selectors.characterId !== null ? { characterId: selectors.characterId } : {}),
            ...(selectors.conversationId !== null ? { conversationId: selectors.conversationId } : {}),
        })
        const queryFor = (includeAssetCount: boolean) => ({
            kind: 'modules-capture' as const,
            scope,
            characterId: selectors.characterId,
            conversationId: selectors.conversationId,
            includeAssetCount,
            serviceGeneration: this.captureGeneration,
        })
        const owner = this.captureOwner('context-modules')
        if (options.cursor) {
            const cursorCountsAuthorized = requestedCounts && countsAuthorized
            const query = queryFor(cursorCountsAuthorized)
            const input = inputFor()
            const [cursorRecord, capturePreparation] = await Promise.all([
                this.cursorRegistry.read<CapturePageRecord>(
                    options.cursor,
                    this.context.principalId,
                    'context-modules',
                    this.context.instanceId,
                    query,
                ),
                this.queryCaptureCache.prepareCreate(owner, query),
            ])
            this.cursorRegistry.clear(options.cursor)
            if (options.captureRevision && options.captureRevision !== cursorRecord.captureRevision) {
                throw new PluginApiError('INVALID_ARGUMENT', 'Context query capture does not match this request')
            }
            const captureRevision = cursorRecord.captureRevision
            const sources = this.queryCaptureCache.readPrepared<ContextModuleSource>(
                capturePreparation, cursorRecord.captureRevision,
            ).items
            const pageSources = sources.slice(cursorRecord.offset, cursorRecord.offset + limit)
            const nextOffset = cursorRecord.offset + pageSources.length
            const nextCursorPreparation = nextOffset < sources.length
                ? await this.cursorRegistry.prepareCreate(
                    this.context.principalId,
                    'context-modules',
                    this.context.instanceId,
                    query,
                )
                : undefined
            await authorize(false)
            this.refreshCaptureGeneration()
            this.assertActive(generation)
            if (cursorCountsAuthorized !== (requestedCounts && countsAuthorized)) {
                throw this.contextChanged()
            }
            if (this.adapter.revalidateModulePageSynchronously) {
                this.adapter.revalidateModulePageSynchronously({
                    sources, pageSources, selectors, input,
                })
                this.refreshCaptureGeneration()
                this.assertActive(generation)
            } else {
                await this.revalidateCapturedModuleCollection(
                    sources, selectors, input, generation, cursorCountsAuthorized,
                )
                if (this.adapter.revalidateModuleSource) {
                    await Promise.all(pageSources.map((source) => this.fenced(
                        this.adapter.revalidateModuleSource!({ source, input }),
                        generation,
                    )))
                }
                this.refreshCaptureGeneration()
                this.assertActive(generation)
            }
            this.queryCaptureCache.readPrepared<ContextModuleSource>(
                capturePreparation, captureRevision,
            )
            const items = pageSources.flatMap((source) => {
                const projection = this.moduleCaptureProjections.get(source)
                return projection ? [projection] : []
            })
            const nextCursorValue = nextCursorPreparation
                ? { offset: nextOffset, captureRevision }
                : undefined
            const nextCursorCommit = nextCursorPreparation && nextCursorValue
                ? this.cursorRegistry.prepareCommit(nextCursorPreparation, nextCursorValue)
                : undefined
            const result = {
                items,
                ...(nextCursorCommit ? { nextCursor: nextCursorCommit.cursor } : {}),
                ...(options.captureScope === 'query' ? { captureRevision } : {}),
            }
            assertContextSnapshotLimits(result)
            if (nextCursorPreparation && nextCursorValue && nextCursorCommit) {
                this.cursorRegistry.commitPrepared(
                    nextCursorPreparation, nextCursorValue, nextCursorCommit,
                )
            }
            return result
        }

        type PreparedCapture = {
            query: ReturnType<typeof queryFor>
            cache: QueryCapturePreparation
            cursor?: CursorPreparation
        }
        const prepare = async (includeAssetCount: boolean): Promise<PreparedCapture> => {
            const query = queryFor(includeAssetCount)
            const [cache, cursor] = await Promise.all([
                this.queryCaptureCache.prepareCreate(owner, query),
                options.captureRevision
                    ? Promise.resolve(undefined)
                    : this.cursorRegistry.prepareCreate(
                        this.context.principalId,
                        'context-modules',
                        this.context.instanceId,
                        query,
                    ),
            ])
            return { query, cache, ...(cursor ? { cursor } : {}) }
        }
        const initialCountsAuthorized = requestedCounts && countsAuthorized
        const preparations = await Promise.all(
            initialCountsAuthorized ? [prepare(true), prepare(false)] : [prepare(false)],
        )

        await authorize(false)
        this.refreshCaptureGeneration()
        this.assertActive(generation)
        const includeAssetCount = requestedCounts && countsAuthorized
        const prepared = preparations.find((candidate) =>
            candidate.query.includeAssetCount === includeAssetCount)!
        const input = inputFor()
        let retained: readonly ContextModuleSource[] | undefined
        if (options.captureRevision) {
            retained = this.queryCaptureCache.readPrepared<ContextModuleSource>(
                prepared.cache, options.captureRevision,
            ).items
        }
        let collection: ContextModuleCollection
        if (this.adapter.captureModuleSourcesSynchronously) {
            this.assertActive(generation)
            collection = this.adapter.captureModuleSourcesSynchronously(
                input, { includeAssetMetadata: includeAssetCount },
            )
        } else {
            collection = await this.captureModuleCollection(input, generation, includeAssetCount)
        }
        this.refreshCaptureGeneration()
        this.assertActive(generation)
        if (!this.sameSelectors(selectors, collection.selectors)) throw this.contextChanged()

        const captureRevision = createSynchronousRevision({
            queryDigest: prepared.cache.queryDigest,
            items: collection.modules,
        })
        if (options.captureRevision) {
            if (options.captureRevision !== captureRevision) throw this.contextChanged()
            const items = (retained ?? []).slice(0, limit).flatMap((source) => {
                const projection = this.moduleCaptureProjections.get(source)
                return projection ? [projection] : []
            })
            const result = {
                items,
                ...(options.captureScope === 'query' ? { captureRevision } : {}),
            }
            assertContextSnapshotLimits(result)
            return result
        }

        for (const source of collection.modules) {
            if (!this.moduleCaptureProjections.has(source)) {
                this.moduleCaptureProjections.set(source, this.moduleSnapshot(source, includeAssetCount))
            }
        }
        const sources = collection.modules
        const pageSources = sources.slice(0, limit)
        const items = pageSources.flatMap((source) => {
            const projection = this.moduleCaptureProjections.get(source)
            return projection ? [projection] : []
        })
        const nextOffset = pageSources.length
        const nextCursorValue = nextOffset < sources.length
            ? { offset: nextOffset, captureRevision }
            : undefined
        const nextCursorCommit = nextCursorValue
            ? this.cursorRegistry.prepareCommit(prepared.cursor!, nextCursorValue)
            : undefined
        const result = {
            items,
            ...(nextCursorCommit ? { nextCursor: nextCursorCommit.cursor } : {}),
            ...(options.captureScope === 'query' ? { captureRevision } : {}),
        }
        assertContextSnapshotLimits(result)
        let nextCursor: string | undefined
        try {
            if (nextCursorValue && nextCursorCommit) {
                nextCursor = this.cursorRegistry.commitPrepared(
                    prepared.cursor!, nextCursorValue, nextCursorCommit,
                )
            }
            this.queryCaptureCache.commitPrepared(prepared.cache, collection.modules)
        } catch (error) {
            if (nextCursor) this.cursorRegistry.clear(nextCursor)
            throw error
        }
        return result
    }

    async listContextModules(options: ContextModuleListOptions = {}): Promise<ContextModulePage> {
        const scope = options.scope ?? 'active'
        if (scope !== 'active' && scope !== 'installed') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid module scope')
        }
        const limit = normalizeLimit(options.limit)
        const captured = this.normalizeCaptureOptions(options.captureScope, options.captureRevision)
        if (captured || options.includeAssetCount !== undefined) {
            return this.listCapturedContextModules(options, scope, limit)
        }
        const preflight = await this.state()
        let selectors: { characterId: string | null; conversationId: string | null }
        if (preflight.current) {
            await this.dependencies.requirePermission(scope === 'installed' ? 'installedModulesRead' : 'contextAssets')
            const state = await this.state()
            const resolved = this.resolveSelectors(state, options)
            selectors = resolved
        } else {
            if (scope !== 'installed' || options.characterId !== undefined || options.conversationId !== undefined) {
                throw new PluginApiError('NOT_FOUND', 'No current character or conversation')
            }
            await this.dependencies.requirePermission('installedModulesRead')
            selectors = { characterId: null, conversationId: null }
        }
        const state = await this.state()
        if (selectors.characterId !== null) {
            const refreshed = this.resolveSelectors(state, options)
            if (!this.sameSelectors(selectors as { characterId: string; conversationId: string }, refreshed)) {
                throw this.contextChanged()
            }
            selectors = refreshed
        } else if (scope !== 'installed') {
            throw new PluginApiError('NOT_FOUND', 'No current character or conversation')
        }
        const query = { kind: 'modules', scope, ...selectors, limit }
        let authorizedPageSources: ContextModuleSource[] = []
        const page = await this.page(
            'context-modules',
            query,
            limit,
            options.cursor,
            async (offset, pageLimit) => {
                const modules = scope === 'installed' ? state.installedModules : state.activeModules
                const pageSources = modules.slice(offset, offset + pageLimit)
                authorizedPageSources = pageSources
                const nextOffset = offset + pageSources.length
                return {
                    items: await Promise.all(pageSources.map((module) => this.moduleSnapshot(module))),
                    ...(nextOffset < modules.length ? { nextOffset } : {}),
                }
            },
        )
        const result = { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
        try {
            const fresh = await this.state()
            if (selectors.characterId !== null) {
                const refreshed = this.resolveSelectors(fresh, options)
                if (!this.sameSelectors(selectors as { characterId: string; conversationId: string }, refreshed)) {
                    throw this.contextChanged()
                }
            }
            const currentModules = scope === 'installed' ? fresh.installedModules : fresh.activeModules
            if (authorizedPageSources.some((source) => !currentModules.some((candidate) =>
                candidate.id === source.id
                && this.moduleSourceIdentity(candidate) === this.moduleSourceIdentity(source)))) {
                throw this.contextChanged()
            }
            assertContextSnapshotLimits(result)
            return result
        } catch (error) {
            if (page.nextCursor) this.cursorRegistry.clear(page.nextCursor)
            throw error
        }
    }

    private handleFor(source: ContextAssetSource, origin: ContextAssetRef['origin'], revision: Revision) {
        return createRevision({
            version: 1,
            principalId: this.context.principalId,
            origin,
            identity: source.identity,
            revision,
        }).then((revision) => `ctxasset_${revision.slice('sha256:'.length)}`)
    }

    private storageRevision(source: ContextAssetSource) {
        return source.storageRevision ?? source.storageKey
    }

    private digestKey(source: ContextAssetSource) {
        return JSON.stringify([source.storageKey, this.storageRevision(source)])
    }

    private removeDigestWaiter(attempt: DigestAttempt, waiter: DigestWaiter) {
        if (waiter.signal && waiter.abortListener) {
            waiter.signal.removeEventListener('abort', waiter.abortListener)
        }
        waiter.abortListener = undefined
        waiter.signal = undefined
        waiter.validateBeforeRead = undefined
        attempt.waiters.delete(waiter)
        if (waiter.logicalQueueToken) {
            this.readCoordinator.releaseLogicalQueueSlot(waiter.logicalQueueToken)
            waiter.logicalQueueToken = undefined
        }
        if (attempt.waiters.size === 0 && !attempt.settled) {
            if (this.digestAttempts.get(attempt.key) === attempt) this.digestAttempts.delete(attempt.key)
            attempt.controller.abort()
        }
    }

    private async validateDigestWaiter(attempt: DigestAttempt, waiter: DigestWaiter) {
        const validateBeforeRead = waiter.validateBeforeRead
        if (!attempt.waiters.has(waiter) || waiter.signal?.aborted || !validateBeforeRead) throw abortedError()
        const signal = waiter.signal
        let abortListener: (() => void) | undefined
        const aborted = new Promise<never>((_resolve, reject) => {
            if (!signal) return
            abortListener = () => reject(abortedError())
            signal.addEventListener('abort', abortListener, { once: true })
        })
        try {
            const source = await (signal
                ? Promise.race([validateBeforeRead(), aborted])
                : validateBeforeRead())
            if (!attempt.waiters.has(waiter) || signal?.aborted) throw abortedError()
            return source
        } finally {
            if (signal && abortListener) signal.removeEventListener('abort', abortListener)
        }
    }

    private waitForDigestAttempt(attempt: DigestAttempt, waiter: DigestWaiter) {
        return new Promise<AssetDigestRecord>((resolve, reject) => {
            let finished = false
            const settle = (callback: () => void) => {
                if (finished) return
                finished = true
                this.removeDigestWaiter(attempt, waiter)
                callback()
            }
            waiter.abortListener = () => settle(() => reject(abortedError()))
            waiter.signal?.addEventListener('abort', waiter.abortListener, { once: true })
            if (waiter.signal?.aborted) {
                waiter.abortListener()
                return
            }
            attempt.promise.then(
                (value) => settle(() => resolve(value)),
                (error: unknown) => settle(() => reject(error)),
            )
        })
    }

    private async assetDigest(
        source: ContextAssetSource,
        validateBeforeRead: () => Promise<ContextAssetSource>,
        generation: number,
        signal?: AbortSignal,
    ) {
        this.assertActive(generation, signal)
        if (source.byteLength !== undefined && source.byteLength > MAX_ASSET_READ_BYTES) throw sourceLimitError()
        const key = this.digestKey(source)
        const cached = lruGet(this.digestCache, key)
        if (cached) return cached

        let attempt = this.digestAttempts.get(key)
        let created = false
        if (!attempt || attempt.generation !== generation) {
            created = true
            attempt = {
                key,
                generation,
                controller: new AbortController(),
                waiters: new Set(),
                promise: Promise.resolve(undefined as never),
                settled: false,
            }
            this.digestAttempts.set(key, attempt)
        }
        const joined = !created
        const logicalQueueToken = joined
            ? this.readCoordinator.reserveLogicalQueueSlot({
                principalId: this.context.principalId,
                instanceId: this.context.instanceId,
            })
            : undefined
        const waiter: DigestWaiter = {
            signal,
            validateBeforeRead,
            logicalQueueToken,
        }
        attempt.waiters.add(waiter)

        if (created) {
            const ownedAttempt = attempt
            const scheduled = this.readCoordinator.schedule({
                owner: {
                    principalId: this.context.principalId,
                    instanceId: this.context.instanceId,
                },
                lane: 'digest',
                signal: ownedAttempt.controller.signal,
                run: async (physicalSignal) => {
                    this.assertActive(generation, physicalSignal)
                    let authorizedSource: ContextAssetSource | undefined
                    let authorizationError: unknown
                    const tried = new Set<DigestWaiter>()
                    while (true) {
                        const activeWaiter = [...ownedAttempt.waiters]
                            .find((candidate) => !tried.has(candidate))
                        if (!activeWaiter) break
                        tried.add(activeWaiter)
                        try {
                            authorizedSource = await this.validateDigestWaiter(ownedAttempt, activeWaiter)
                            break
                        } catch (error) {
                            authorizationError = error
                        }
                    }
                    if (!authorizedSource) throw authorizationError ?? abortedError()
                    this.assertActive(generation, physicalSignal)
                    if (authorizedSource.byteLength !== undefined
                        && authorizedSource.byteLength > MAX_ASSET_READ_BYTES) throw sourceLimitError()
                    const data = await this.adapter.readAsset(authorizedSource, physicalSignal)
                    this.assertActive(generation, physicalSignal)
                    if (!(data instanceof Uint8Array)) {
                        throw new PluginApiError('INTERNAL', 'Asset backend returned invalid binary data')
                    }
                    if (data.byteLength > MAX_ASSET_READ_BYTES) throw sourceLimitError()
                    const revision = await digestBytes(data)
                    this.assertActive(generation, physicalSignal)
                    return {
                        storageRevision: this.storageRevision(authorizedSource),
                        revision,
                        byteLength: data.byteLength,
                        mediaType: inferMediaType(authorizedSource, data),
                    }
                },
            })
            ownedAttempt.promise = scheduled.finally(() => {
                ownedAttempt.settled = true
                if (this.digestAttempts.get(key) === ownedAttempt) this.digestAttempts.delete(key)
            })
        }
        return this.waitForDigestAttempt(attempt, waiter)
    }

    private async assetReference(
        source: ContextAssetSource,
        origin: ContextAssetRef['origin'],
        validateCurrentSource: () => Promise<ContextAssetSource>,
        generation: number,
        signal?: AbortSignal,
        stagedHandles?: Map<string, IssuedAssetHandle>,
    ) {
        const digest = await this.assetDigest(source, validateCurrentSource, generation, signal)
        // Native captures validate every selected source together immediately before
        // publication. Avoid a redundant per-item probe here so first capture plus
        // final metadata probe remains bounded to two targeted probes per source.
        if (!stagedHandles || !this.adapter.revalidateAssetSource) {
            const currentSource = await validateCurrentSource()
            this.assertActive(generation, signal)
            if (this.digestKey(currentSource) !== this.digestKey(source)) throw this.contextChanged()
        }
        lruSet(this.digestCache, this.digestKey(source), digest, MAX_DIGEST_RECORDS)
        const assetId = await this.fenced(this.handleFor(source, origin, digest.revision), generation, signal)
        lruSet(
            stagedHandles ?? this.issuedHandles,
            assetId,
            { identity: source.identity, origin },
            MAX_ISSUED_HANDLES,
        )
        const reference: ContextAssetRef = {
            assetId,
            revision: digest.revision,
            name: source.name,
            ...(source.extension ? { extension: source.extension } : {}),
            mediaType: digest.mediaType,
            byteLength: digest.byteLength,
            role: source.role,
            origin,
        }
        return reference
    }

    private characterAssets(state: ContextHostState, characterId: string) {
        const character = state.characters.find((item) => item.id === characterId)
        if (!character) throw new PluginApiError('NOT_FOUND', 'Character was not found')
        return character.assets.map((source) => ({
            source: { ...source },
            origin: { kind: 'character' as const, characterId },
        }))
    }

    private moduleAssets(modules: readonly ContextModuleSource[]) {
        return modules.flatMap((module) => module.assets.map((source) => ({
            source: { ...source },
            origin: { kind: 'module' as const, moduleId: module.id },
        })))
    }

    private sameAssetSource(left: ContextAssetSource, right: ContextAssetSource) {
        return left.identity === right.identity
            && left.storageKey === right.storageKey
            && this.storageRevision(left) === this.storageRevision(right)
    }

    private sourceStillAuthorized(
        state: ContextHostState,
        located: { source: ContextAssetSource; origin: ContextAssetRef['origin'] },
        moduleScope: 'active' | 'installed' | 'none',
    ) {
        if (located.origin.kind === 'character') {
            const characterId = located.origin.characterId
            if (!this.authorizedCharacterIds(state).has(characterId)) return false
            const character = state.characters.find((item) => item.id === characterId)
            return Boolean(character?.assets.some((source) => this.sameAssetSource(source, located.source)))
        }
        const moduleId = located.origin.moduleId
        const modules = moduleScope === 'installed' ? state.installedModules : state.activeModules
        return modules.some((module) => module.id === moduleId
            && module.assets.some((source) => this.sameAssetSource(source, located.source)))
    }

    private currentListSource(
        state: ContextHostState,
        located: { source: ContextAssetSource; origin: ContextAssetRef['origin'] },
        moduleScope: 'active' | 'installed' | 'none',
    ) {
        if (!this.sourceStillAuthorized(state, located, moduleScope)) throw this.contextChanged()
        const origin = located.origin
        if (origin.kind === 'character') {
            return state.characters.find((character) => character.id === origin.characterId)!.assets
                .find((source) => this.sameAssetSource(source, located.source))!
        }
        const modules = moduleScope === 'installed' ? state.installedModules : state.activeModules
        return modules.find((module) => module.id === origin.moduleId)!.assets
            .find((source) => this.sameAssetSource(source, located.source))!
    }

    private async validateListSource(
        located: { source: ContextAssetSource; origin: ContextAssetRef['origin'] },
        moduleScope: 'active' | 'installed' | 'none',
        selectors: { characterId: string; conversationId: string },
        selectorOptions: { characterId?: CharacterId; conversationId?: ConversationId },
        generation: number,
        signal?: AbortSignal,
    ) {
        await this.permission('contextAssets', generation, signal)
        if (moduleScope === 'installed') {
            await this.permission('installedModulesRead', generation, signal)
            await this.permission('contextAssets', generation, signal)
        }
        const state = await this.state(generation, signal)
        const currentSelectors = this.resolveSelectors(state, selectorOptions)
        if (!this.sameSelectors(selectors, currentSelectors)) throw this.contextChanged()
        return this.currentListSource(state, located, moduleScope)
    }

    private async boundedMap<T, U>(
        values: readonly T[],
        workerCount: number,
        generation: number,
        signal: AbortSignal | undefined,
        transform: (value: T, index: number) => Promise<U>,
    ) {
        const results = new Array<U>(values.length)
        let nextIndex = 0
        let stopped = false
        const worker = async () => {
            while (!stopped) {
                this.assertActive(generation, signal)
                const index = nextIndex
                if (index >= values.length) return
                nextIndex += 1
                try {
                    results[index] = await transform(values[index], index)
                } catch (error) {
                    stopped = true
                    throw error
                }
            }
        }
        await Promise.all(Array.from(
            { length: Math.min(workerCount, values.length) },
            () => worker(),
        ))
        this.assertActive(generation, signal)
        return results
    }

    private normalizeIncludes(value: ContextAssetRole[] | undefined) {
        const order: ContextAssetRole[] = ['portrait', 'emotion', 'additional', 'module']
        if (value === undefined) return order
        if (!Array.isArray(value) || value.some((role) => !order.includes(role))) {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid context asset role')
        }
        return order.filter((role) => value.includes(role))
    }

    private normalizeMediaTypes(value: string[] | undefined) {
        if (value === undefined) return undefined
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !normalizedMediaType(item))) {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid media type filter')
        }
        return [...new Set(value.map((item) => normalizedMediaType(item)!))].sort()
    }

    private normalizeModuleIds(value: string[] | undefined) {
        if (value === undefined) return { moduleIds: [], specified: false }
        if (!Array.isArray(value)) {
            throw new PluginApiError(
                'INVALID_ARGUMENT',
                'Invalid module ID filter',
            )
        }
        const normalized = value.map((moduleId) => {
            if (typeof moduleId !== 'string' || !moduleId.trim()) {
                throw new PluginApiError('INVALID_ARGUMENT', 'Module IDs must be non-empty strings')
            }
            return moduleId.trim()
        })
        const moduleIds = [...new Set(normalized)].sort()
        if (moduleIds.length > MAX_MODULE_IDS_PER_ASSET_LIST) {
            throw new PluginApiError(
                'RESOURCE_LIMIT',
                'Module ID filter exceeds the advertised maximum',
                { details: { maximum: MAX_MODULE_IDS_PER_ASSET_LIST } },
            )
        }
        return { moduleIds, specified: true }
    }

    private async captureAssetCollection(
        input: ContextAssetCollectionInput,
        generation: number,
    ): Promise<ContextAssetCollection> {
        if (this.adapter.captureAssetSources) {
            return this.fenced(this.adapter.captureAssetSources(input), generation, input.signal)
        }
        const state = await this.state(generation, input.signal)
        const characterId = input.characterIds[0]
        const selectors = this.resolveSelectors(state, {
            characterId,
            conversationId: input.conversationId,
        })
        const modules = input.moduleScope === 'installed'
            ? state.installedModules
            : input.moduleScope === 'active' ? state.activeModules : []
        const filteredModules = input.moduleIdsSpecified
            ? modules.filter((module) => input.moduleIds.includes(module.id))
            : modules
        const assets = [
            ...this.characterAssets(state, selectors.characterId),
            ...this.moduleAssets(filteredModules),
        ].filter(({ source }) => input.include.includes(source.role))
            .map(({ source, origin }) => ({ source: { ...source }, origin: { ...origin } }))
        return { selectors, assets }
    }

    private async revalidateCapturedAsset(
        located: ContextLocatedAssetSource,
        input: ContextAssetCollectionInput,
        selectors: { characterId: string; conversationId: string },
        generation: number,
        signal?: AbortSignal,
    ) {
        await this.permission('contextAssets', generation, signal)
        if (input.moduleScope === 'installed' && located.origin.kind === 'module') {
            await this.permission('installedModulesRead', generation, signal)
            await this.permission('contextAssets', generation, signal)
        }
        if (this.adapter.revalidateAssetSource) {
            return this.fenced(
                this.adapter.revalidateAssetSource({ located, input: { ...input, signal } }),
                generation,
                signal,
            )
        }
        const current = await this.captureAssetCollection({ ...input, signal }, generation)
        if (!this.sameSelectors(selectors, current.selectors)) throw this.contextChanged()
        const matched = current.assets.find((candidate) => this.sameOrigin(candidate.origin, located.origin)
            && this.sameAssetSource(candidate.source, located.source))
        if (!matched) throw this.contextChanged()
        return matched.source
    }

    private async revalidateCapturedAssetCollection(
        sources: readonly ContextLocatedAssetSource[],
        selectors: { characterId: CharacterId; conversationId: ConversationId },
        input: ContextAssetCollectionInput,
        generation: number,
        signal?: AbortSignal,
    ) {
        if (this.adapter.revalidateAssetCollection) {
            await this.fenced(
                this.adapter.revalidateAssetCollection({ sources, selectors, input: { ...input, signal } }),
                generation,
                signal,
            )
            return
        }
        const current = await this.captureAssetCollection({ ...input, signal }, generation)
        if (!this.sameSelectors(selectors, current.selectors)
            || current.assets.length !== sources.length
            || current.assets.some((located, index) => {
                const expected = sources[index]
                return !this.sameOrigin(located.origin, expected.origin)
                    || JSON.stringify(located.source) !== JSON.stringify(expected.source)
            })) throw this.contextChanged()
    }

    private async listCapturedContextAssets(
        options: ContextAssetListOptions,
        moduleScope: 'active' | 'installed' | 'none',
        include: ContextAssetRole[],
        mediaTypes: string[] | undefined,
        moduleIds: string[],
        moduleIdsSpecified: boolean,
        limit: number,
    ) {
        const signal = options.signal
        this.refreshCaptureGeneration()
        const generation = this.generation
        this.assertActive(generation, signal)
        if (moduleIdsSpecified && moduleScope !== 'installed') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Module ID filtering requires installed module scope')
        }
        await this.permission('contextAssets', generation, signal)
        if (moduleScope === 'installed') {
            await this.permission('installedModulesRead', generation, signal)
            await this.permission('contextAssets', generation, signal)
        }
        const resolvedSelectors = await this.resolveCaptureSelectors({
            characterId: options.characterId,
            conversationId: options.conversationId,
            allowMissingCurrent: false,
            signal,
        }, generation) as { characterId: CharacterId; conversationId: ConversationId }
        let preflightSelectors = resolvedSelectors
        let input: ContextAssetCollectionInput = {
            characterIds: [preflightSelectors.characterId],
            conversationId: preflightSelectors.conversationId,
            include,
            moduleScope,
            moduleIds,
            moduleIdsSpecified,
            mediaTypes: mediaTypes ?? [],
            signal,
        }
        const query = {
            kind: 'assets-capture',
            characterId: preflightSelectors.characterId,
            conversationId: preflightSelectors.conversationId,
            include,
            moduleScope,
            moduleIds,
            moduleIdsSpecified,
            mediaTypes: mediaTypes ?? null,
            serviceGeneration: this.captureGeneration,
        }
        const owner = this.captureOwner('context-assets')
        let offset = 0
        let captureRevision: Revision
        let sources: readonly ContextLocatedAssetSource[]
        let verificationSources: readonly ContextLocatedAssetSource[]
        let capturePreparation: QueryCapturePreparation
        const stagedHandles = new Map<string, IssuedAssetHandle>()
        let stagedCapture = false
        if (options.cursor) {
            const [cursorRecord, preparation] = await Promise.all([
                this.cursorRegistry.read<CapturePageRecord>(
                    options.cursor,
                    this.context.principalId,
                    'context-assets',
                    this.context.instanceId,
                    query,
                ),
                this.queryCaptureCache.prepareCreate(owner, query),
            ])
            this.cursorRegistry.clear(options.cursor)
            if (options.captureRevision && options.captureRevision !== cursorRecord.captureRevision) {
                throw new PluginApiError('INVALID_ARGUMENT', 'Context query capture does not match this request')
            }
            offset = cursorRecord.offset
            captureRevision = cursorRecord.captureRevision
            capturePreparation = preparation
            sources = this.queryCaptureCache.readPrepared<ContextLocatedAssetSource>(
                capturePreparation, captureRevision,
            ).items
            verificationSources = sources
        } else {
            const preparation = await this.queryCaptureCache.prepareCreate(owner, query)
            const retained = options.captureRevision
                ? this.queryCaptureCache.readPrepared<ContextLocatedAssetSource>(
                    preparation, options.captureRevision,
                )
                : undefined
            const collection = await this.captureAssetCollection(input, generation)
            if (preflightSelectors.characterId
                && !this.sameSelectors(preflightSelectors, collection.selectors)) throw this.contextChanged()
            preflightSelectors = collection.selectors
            input = {
                ...input,
                characterIds: [collection.selectors.characterId],
                conversationId: collection.selectors.conversationId,
            }
            verificationSources = collection.assets
            capturePreparation = preparation
            if (retained && options.captureRevision) {
                captureRevision = createSynchronousRevision({
                    queryDigest: preparation.queryDigest,
                    items: collection.assets,
                })
                if (options.captureRevision !== captureRevision) throw this.contextChanged()
                sources = retained.items
            } else {
                captureRevision = createSynchronousRevision({
                    queryDigest: preparation.queryDigest,
                    items: collection.assets,
                })
                sources = collection.assets
            }
            if (!options.captureRevision) {
                stagedCapture = true
                try {
                    await this.boundedMap(
                        sources,
                        MAX_LIST_DIGEST_WORKERS,
                        generation,
                        signal,
                        async (located) => {
                            if (!this.assetCaptureProjections.has(located)) {
                                this.assetCaptureProjections.set(located, await this.assetReference(
                                    located.source,
                                    located.origin,
                                    () => this.revalidateCapturedAsset(
                                        located, input, preflightSelectors, generation, signal,
                                    ),
                                    generation,
                                    signal,
                                    stagedHandles,
                                ))
                            }
                            return undefined
                        },
                    )
                } catch (error) { throw error }
            }
        }

        const pageSources = sources.slice(offset, offset + limit)
        const references = pageSources.flatMap((source) => {
            const projection = this.assetCaptureProjections.get(source)
            return projection ? [projection] : []
        })
        const items = mediaTypes
            ? references.filter((reference) => reference.mediaType && mediaTypes.includes(reference.mediaType))
            : references
        const nextOffset = offset + pageSources.length
        const nextCursorValue = !options.captureRevision && nextOffset < sources.length
            ? { offset: nextOffset, captureRevision }
            : undefined
        const nextCursorPreparation = nextCursorValue
            ? await this.cursorRegistry.prepareCreate(
                this.context.principalId,
                'context-assets',
                this.context.instanceId,
                query,
            )
            : undefined
        await this.permission('contextAssets', generation, signal)
        if (moduleScope === 'installed') {
            await this.permission('installedModulesRead', generation, signal)
            await this.permission('contextAssets', generation, signal)
        }
        const publicationSources = stagedCapture && this.adapter.revalidateAssetSource
            ? sources
            : options.captureRevision
                ? []
                : pageSources
        await this.boundedMap(
            publicationSources,
            MAX_LIST_DIGEST_WORKERS,
            generation,
            signal,
            async (located) => {
                await this.revalidateCapturedAsset(
                    located, input, preflightSelectors, generation, signal,
                )
                return undefined
            },
        )
        this.refreshCaptureGeneration()
        this.assertActive(generation, signal)
        await this.revalidateCapturedAssetCollection(
            verificationSources, preflightSelectors, input, generation, signal,
        )
        this.refreshCaptureGeneration()
        this.assertActive(generation, signal)
        const nextCursorCommit = nextCursorValue && nextCursorPreparation
            ? this.cursorRegistry.prepareCommit(nextCursorPreparation, nextCursorValue)
            : undefined
        const result = {
            contextRevision: captureRevision,
            assets: items,
            ...(nextCursorCommit ? { nextCursor: nextCursorCommit.cursor } : {}),
            ...(options.captureScope === 'query' ? { captureRevision } : {}),
        }
        assertContextSnapshotLimits(result)
        if (stagedCapture) this.queryCaptureCache.commitPrepared(capturePreparation, sources)
        this.queryCaptureCache.readPrepared<ContextLocatedAssetSource>(capturePreparation, captureRevision)
        for (const [assetId, issued] of stagedHandles) {
            lruSet(this.issuedHandles, assetId, issued, MAX_ISSUED_HANDLES)
        }
        if (nextCursorValue && nextCursorPreparation && nextCursorCommit) {
            this.cursorRegistry.commitPrepared(nextCursorPreparation, nextCursorValue, nextCursorCommit)
        }
        return result
    }

    async listContextAssets(options: ContextAssetListOptions = {}): Promise<ContextAssetPage> {
        const generation = this.generation
        const signal = options.signal
        this.assertActive(generation, signal)
        const moduleScope = options.moduleScope ?? 'active'
        if (!['active', 'installed', 'none'].includes(moduleScope)) {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid module asset scope')
        }
        const limit = normalizeLimit(options.limit)
        const include = this.normalizeIncludes(options.include)
        const mediaTypes = this.normalizeMediaTypes(options.mediaTypes)
        const { moduleIds, specified: moduleIdsSpecified } = this.normalizeModuleIds(options.moduleIds)
        const captured = this.normalizeCaptureOptions(options.captureScope, options.captureRevision)
        if (captured || options.moduleIds !== undefined) {
            return this.listCapturedContextAssets(
                options, moduleScope as 'active' | 'installed' | 'none', include, mediaTypes,
                moduleIds, moduleIdsSpecified, limit,
            )
        }
        const preflight = await this.state(generation, signal)
        this.current(preflight)
        await this.permission('contextAssets', generation, signal)
        if (moduleScope === 'installed') {
            await this.permission('installedModulesRead', generation, signal)
            await this.permission('contextAssets', generation, signal)
        }
        const state = await this.state(generation, signal)
        const selectors = this.resolveSelectors(state, options)
        const query = {
            kind: 'assets',
            ...selectors,
            include,
            moduleScope,
            mediaTypes: mediaTypes ?? null,
            limit,
        }
        let authorizedPageSources: Array<{
            source: ContextAssetSource
            origin: ContextAssetRef['origin']
        }> = []
        const page = await this.page(
            'context-assets',
            query,
            limit,
            options.cursor,
            async (offset, pageLimit) => {
                const sources = [
                    ...this.characterAssets(state, selectors.characterId),
                    ...(moduleScope === 'none' ? [] : this.moduleAssets(
                        moduleScope === 'installed' ? state.installedModules : state.activeModules,
                    )),
                ].filter(({ source }) => include.includes(source.role))
                const pageSources = sources.slice(offset, offset + pageLimit)
                authorizedPageSources = pageSources
                const references = await this.boundedMap(
                    pageSources,
                    MAX_LIST_DIGEST_WORKERS,
                    generation,
                    signal,
                    ({ source, origin }) => this.assetReference(
                        source,
                        origin,
                        () => this.validateListSource(
                            { source, origin }, moduleScope, selectors, options, generation, signal,
                        ),
                        generation,
                        signal,
                    ),
                )
                const nextOffset = offset + pageSources.length
                return {
                    items: mediaTypes
                        ? references.filter((reference) => reference.mediaType && mediaTypes.includes(reference.mediaType))
                        : references,
                    contextRevision: await this.fenced(this.contextRevision(state), generation, signal),
                    ...(nextOffset < sources.length ? { nextOffset } : {}),
                }
            },
        )
        const result = {
            contextRevision: page.contextRevision!,
            assets: page.items,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        }
        try {
            await this.permission('contextAssets', generation, signal)
            if (moduleScope === 'installed') {
                await this.permission('installedModulesRead', generation, signal)
                await this.permission('contextAssets', generation, signal)
            }
            const fresh = await this.state(generation, signal)
            const refreshed = this.resolveSelectors(fresh, options)
            if (!this.sameSelectors(selectors, refreshed)
                || authorizedPageSources.some((source) => !this.sourceStillAuthorized(fresh, source, moduleScope))) {
                throw this.contextChanged()
            }
            assertContextSnapshotLimits(result)
            this.assertActive(generation, signal)
            return result
        } catch (error) {
            if (page.nextCursor) this.cursorRegistry.clear(page.nextCursor)
            throw error
        }
    }

    private allAssets(state: ContextHostState) {
        const moduleAssetKey = (module: ContextModuleSource, source: ContextAssetSource) =>
            `${module.id}\u0000${source.identity}\u0000${source.storageKey}`
        const activeAssetKeys = new Set(state.activeModules.flatMap((module) =>
            module.assets.map((source) => moduleAssetKey(module, source))))
        const moduleAssets = new Map<string, LocatedAsset>()
        for (const module of [...state.installedModules, ...state.activeModules]) {
            for (const source of module.assets) {
                const key = moduleAssetKey(module, source)
                const existing = moduleAssets.get(key)
                if (existing) {
                    existing.activeModule ||= activeAssetKeys.has(key)
                    continue
                }
                moduleAssets.set(key, {
                    source,
                    origin: { kind: 'module', moduleId: module.id },
                    activeModule: activeAssetKeys.has(key),
                })
            }
        }
        return [
            ...state.characters.flatMap((character) => character.assets.map((source): LocatedAsset => ({
                source,
                origin: { kind: 'character', characterId: character.id },
                activeModule: false,
            }))),
            ...moduleAssets.values(),
        ]
    }

    private sameOrigin(left: ContextAssetRef['origin'], right: ContextAssetRef['origin']) {
        return left.kind === right.kind && (left.kind === 'character'
            ? left.characterId === (right as { kind: 'character'; characterId: string }).characterId
            : left.moduleId === (right as { kind: 'module'; moduleId: string }).moduleId)
    }

    private authorizedScanAssets(state: ContextHostState) {
        const authorized = this.authorizedCharacterIds(state)
        return this.allAssets({
            ...state,
            characters: state.characters.filter((character) => authorized.has(character.id)),
        })
    }

    private findIssuedAsset(state: ContextHostState, issued: IssuedAssetHandle) {
        const origin = issued.origin
        if (origin.kind === 'character') {
            if (!this.authorizedCharacterIds(state).has(origin.characterId)) {
                throw new PluginApiError('PERMISSION_DENIED', 'Character asset is outside the current context')
            }
            const character = state.characters.find((candidate) => candidate.id === origin.characterId)
            const source = character?.assets.find((candidate) => candidate.identity === issued.identity)
            return source ? {
                source: { ...source },
                origin: { ...issued.origin },
                activeModule: false,
            } : undefined
        }
        const candidate = this.allAssets({ ...state, characters: [] }).find((candidate) =>
            candidate.source.identity === issued.identity && this.sameOrigin(candidate.origin, issued.origin))
        return candidate ? {
            ...candidate,
            source: { ...candidate.source },
            origin: { ...candidate.origin },
        } : undefined
    }

    private async locateAsset(
        state: ContextHostState,
        assetId: string,
        expectedSelectors: { characterId: string; conversationId: string },
        expectedRevision: Revision | undefined,
        generation: number,
        signal?: AbortSignal,
    ) {
        this.assertActive(generation, signal)
        const issued = lruGet(this.issuedHandles, assetId)
        if (issued) {
            const candidate = this.findIssuedAsset(state, issued)
            if (candidate) return candidate
            throw new PluginApiError('NOT_FOUND', 'Context asset was not found')
        }

        const candidates = this.authorizedScanAssets(state)
        for (const candidate of candidates) {
            this.assertActive(generation, signal)
            let revision = expectedRevision
            if (!revision) {
                const digest = await this.assetDigest(
                    candidate.source,
                    () => this.reauthorizeAssetOrigin(candidate, expectedSelectors, generation, signal),
                    generation,
                    signal,
                )
                await this.reauthorizeAssetOrigin(candidate, expectedSelectors, generation, signal)
                this.assertActive(generation, signal)
                lruSet(this.digestCache, this.digestKey(candidate.source), digest, MAX_DIGEST_RECORDS)
                revision = digest.revision
            }
            if (await this.fenced(this.handleFor(candidate.source, candidate.origin, revision), generation, signal) === assetId) {
                await this.reauthorizeAssetOrigin(candidate, expectedSelectors, generation, signal)
                this.assertActive(generation, signal)
                lruSet(
                    this.issuedHandles,
                    assetId,
                    { identity: candidate.source.identity, origin: candidate.origin },
                    MAX_ISSUED_HANDLES,
                )
                return {
                    ...candidate,
                    source: { ...candidate.source },
                    origin: { ...candidate.origin },
                }
            }
        }
        throw new PluginApiError('NOT_FOUND', 'Context asset was not found')
    }

    private async authorizeAssetOrigin(
        state: ContextHostState,
        located: LocatedAsset,
        generation: number,
        signal?: AbortSignal,
    ) {
        this.assertActive(generation, signal)
        if (located.origin.kind === 'character') {
            if (!this.authorizedCharacterIds(state).has(located.origin.characterId)) {
                throw new PluginApiError('PERMISSION_DENIED', 'Character asset is outside the current context')
            }
            return
        }
        if (!located.activeModule) {
            await this.permission('installedModulesRead', generation, signal)
            await this.permission('contextAssets', generation, signal)
        }
    }

    private async reauthorizeAssetOrigin(
        located: LocatedAsset,
        expectedSelectors: { characterId: string; conversationId: string },
        generation: number,
        signal?: AbortSignal,
    ) {
        let installedModulesAuthorized = false
        while (true) {
            await this.permission('contextAssets', generation, signal)
            const state = await this.state(generation, signal)
            const current = this.findIssuedAsset(state, {
                identity: located.source.identity,
                origin: located.origin,
            })
            if (!current) throw new PluginApiError('NOT_FOUND', 'Context asset was removed while it was being read')
            const actualSelectors = this.resolveSelectors(state, {})
            if (!this.sameSelectors(expectedSelectors, actualSelectors)) throw this.contextChanged()
            if (current.origin.kind === 'module' && !current.activeModule && !installedModulesAuthorized) {
                await this.permission('installedModulesRead', generation, signal)
                installedModulesAuthorized = true
                continue
            }
            this.assertActive(generation, signal)
            if (current.source.storageKey !== located.source.storageKey) {
                throw new PluginApiError('CONFLICT', 'Context asset source changed while it was being read')
            }
            if (this.storageRevision(current.source) !== this.storageRevision(located.source)) {
                throw new PluginApiError('CONFLICT', 'Context asset changed while it was being read')
            }
            return current.source
        }
    }

    async readContextAsset(
        assetId: string,
        options: ContextAssetReadOptions = {},
    ) {
        const generation = this.generation
        const signal = options.signal
        this.assertActive(generation, signal)
        const variant = options.variant ?? 'original'
        if (variant !== 'original' && variant !== 'thumbnail') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid context asset variant')
        }
        const maxBytes = normalizeAssetReadBytes(options.maxBytes)
        validateAssetReadIdentifiers(assetId, options.ifRevision)
        const preflight = await this.state(generation, signal)
        this.current(preflight)
        await this.permission('contextAssets', generation, signal)
        const state = await this.state(generation, signal)
        const selectors = this.resolveSelectors(state, {})
        const located = await this.locateAsset(
            state, assetId, selectors, options.ifRevision, generation, signal,
        )
        await this.authorizeAssetOrigin(state, located, generation, signal)
        if (located.source.byteLength !== undefined && located.source.byteLength > MAX_ASSET_READ_BYTES) {
            throw sourceLimitError()
        }
        const cached = lruGet(this.digestCache, this.digestKey(located.source))
        if (variant === 'original' && cached && cached.byteLength > maxBytes) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Context asset exceeds maxBytes')
        }

        return this.readCoordinator.schedule({
            owner: {
                principalId: this.context.principalId,
                instanceId: this.context.instanceId,
            },
            lane: variant,
            signal,
            run: async (physicalSignal) => {
                const currentSource = await this.reauthorizeAssetOrigin(
                    located, selectors, generation, physicalSignal,
                )
                if (currentSource.byteLength !== undefined && currentSource.byteLength > MAX_ASSET_READ_BYTES) {
                    throw sourceLimitError()
                }
                const data = await this.adapter.readAsset(currentSource, physicalSignal)
                this.assertActive(generation, physicalSignal)
                if (!(data instanceof Uint8Array)) {
                    throw new PluginApiError('INTERNAL', 'Asset backend returned invalid binary data')
                }
                if (data.byteLength > MAX_ASSET_READ_BYTES) throw sourceLimitError()
                if (variant === 'original' && data.byteLength > maxBytes) {
                    throw new PluginApiError('RESOURCE_LIMIT', 'Context asset exceeds maxBytes')
                }
                const revision = await digestBytes(data)
                this.assertActive(generation, physicalSignal)
                const digest: AssetDigestRecord = {
                    storageRevision: this.storageRevision(currentSource),
                    revision,
                    byteLength: data.byteLength,
                    mediaType: inferMediaType(currentSource, data),
                }
                let thumbnail: BoundedThumbnailResult | undefined
                if (variant === 'thumbnail') {
                    if (!digest.mediaType.startsWith('image/')) {
                        throw new PluginApiError('DECODE_FAILED', 'Only image assets can be thumbnailed')
                    }
                    thumbnail = await this.adapter.createThumbnail(currentSource, data, {
                        longEdge: THUMBNAIL_LONG_EDGE,
                        maxPixels: MAX_THUMBNAIL_PIXELS,
                        maxOutputBytes: MAX_THUMBNAIL_OUTPUT_BYTES,
                    }, physicalSignal)
                    this.assertActive(generation, physicalSignal)
                    if (!(thumbnail.data instanceof Uint8Array)
                        || !Number.isInteger(thumbnail.width) || thumbnail.width <= 0
                        || !Number.isInteger(thumbnail.height) || thumbnail.height <= 0
                        || !Number.isInteger(thumbnail.decodedPixels) || thumbnail.decodedPixels <= 0) {
                        throw new PluginApiError('DECODE_FAILED', 'Thumbnail backend returned invalid output')
                    }
                    if (Math.max(thumbnail.width, thumbnail.height) > THUMBNAIL_LONG_EDGE
                        || thumbnail.decodedPixels > MAX_THUMBNAIL_PIXELS
                        || thumbnail.data.byteLength > MAX_THUMBNAIL_OUTPUT_BYTES
                        || thumbnail.data.byteLength > maxBytes) {
                        throw new PluginApiError('RESOURCE_LIMIT', 'Thumbnail exceeds the advertised bounds')
                    }
                }

                await this.reauthorizeAssetOrigin(located, selectors, generation, physicalSignal)
                const currentHandle = await this.fenced(
                    this.handleFor(located.source, located.origin, digest.revision), generation, physicalSignal,
                )
                if (currentHandle !== assetId) {
                    throw new PluginApiError('CONFLICT', 'Context asset handle is stale', {
                        details: { actualRevision: digest.revision },
                    })
                }
                if (options.ifRevision !== undefined && options.ifRevision !== digest.revision) {
                    throw new PluginApiError('CONFLICT', 'Context asset revision changed', {
                        details: { expectedRevision: options.ifRevision, actualRevision: digest.revision },
                    })
                }
                this.assertActive(generation, physicalSignal)
                lruSet(this.digestCache, this.digestKey(located.source), digest, MAX_DIGEST_RECORDS)
                lruSet(
                    this.issuedHandles,
                    assetId,
                    { identity: located.source.identity, origin: located.origin },
                    MAX_ISSUED_HANDLES,
                )
                if (variant === 'original') {
                    return {
                        data: data.slice(),
                        revision: digest.revision,
                        name: located.source.name,
                        mediaType: digest.mediaType,
                    }
                }
                return {
                    data: thumbnail!.data.slice(),
                    revision: digest.revision,
                    name: located.source.name,
                    mediaType: normalizedMediaType(thumbnail!.mediaType) ?? 'application/octet-stream',
                }
            },
        })
    }
}
