import { CursorRegistry, illustrationCursorRegistry } from './cursorRegistry'
import { PluginApiError } from './errors'
import { createRevision, validateJsonLimits } from './revision'
import type { PluginExecutionContext } from './permissions'
import type { ModuleActivationReason } from './moduleActivation'

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
    readAsset(source: ContextAssetSource): Promise<Uint8Array>
    createThumbnail(
        source: ContextAssetSource,
        data: Uint8Array,
        constraints: { longEdge: number; maxPixels: number; maxOutputBytes: number },
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
    cursor?: string
    limit?: number
}

export interface ContextModuleListOptions {
    characterId?: CharacterId
    conversationId?: ConversationId
    scope?: 'active' | 'installed'
    cursor?: string
    limit?: number
}

export interface ContextResourceServiceDependencies {
    requirePermission(permission: 'contextAssets' | 'installedModulesRead'): Promise<void>
    cursorRegistry?: CursorRegistry
    now?: () => number
    readRateLimiter?: ContextAssetReadRateLimiter
}

const MAX_SNAPSHOT_JSON_BYTES = 2_097_152
const MAX_JSON_DEPTH = 32
const MAX_TEXT_FIELD_UTF8_BYTES = 524_288
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const MAX_ACTIVE_MODULES = 100
const DEFAULT_ASSET_READ_BYTES = 16_777_216
const MAX_ASSET_READ_BYTES = 33_554_432
const ASSET_READS_PER_MINUTE = 60
const THUMBNAIL_LONG_EDGE = 512
const MAX_THUMBNAIL_PIXELS = 262_144
const MAX_THUMBNAIL_OUTPUT_BYTES = 1_048_576
const CONTEXT_ASSET_ID_LENGTH = 'ctxasset_'.length + 64
const REVISION_LENGTH = 'sha256:'.length + 64
const CONTEXT_ASSET_ID_PATTERN = /^ctxasset_[0-9a-f]{64}$/
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/

const textEncoder = new TextEncoder()

function assertNotAborted(context: PluginExecutionContext) {
    if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance is no longer active')
}

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

interface LocatedAsset {
    source: ContextAssetSource
    origin: ContextAssetRef['origin']
    activeModule: boolean
}

interface IssuedAssetHandle {
    identity: string
    origin: ContextAssetRef['origin']
}

export class ContextAssetReadRateLimiter {
    private reads = new Map<string, number[]>()

    constructor(private readonly now: () => number = Date.now) {}

    consume(principalId: string) {
        const now = this.now()
        const cutoff = now - 60_000
        const retained = (this.reads.get(principalId) ?? []).filter((value) => value > cutoff)
        if (retained.length >= ASSET_READS_PER_MINUTE) {
            const retryAfterMs = Math.max(1, retained[0] + 60_000 - now)
            this.reads.set(principalId, retained)
            throw new PluginApiError('RESOURCE_LIMIT', 'Context asset read rate exceeded', {
                retryable: true,
                retryAfterMs,
            })
        }
        retained.push(now)
        this.reads.set(principalId, retained)
    }

    clearPrincipal(principalId: string) {
        this.reads.delete(principalId)
    }
}

const sharedReadRateLimiter = new ContextAssetReadRateLimiter()

export class ContextResourceService {
    private readonly cursorRegistry: CursorRegistry
    private readonly now: () => number
    private readonly readRateLimiter: ContextAssetReadRateLimiter
    private readonly digestCache = new Map<string, AssetDigestRecord>()
    private readonly issuedHandles = new Map<string, IssuedAssetHandle>()
    private readonly abortCleanup: () => void

    constructor(
        private readonly context: PluginExecutionContext,
        private readonly adapter: ContextResourceAdapter,
        private readonly dependencies: ContextResourceServiceDependencies,
    ) {
        this.cursorRegistry = dependencies.cursorRegistry ?? illustrationCursorRegistry
        this.now = dependencies.now ?? Date.now
        this.readRateLimiter = dependencies.readRateLimiter
            ?? (dependencies.now ? new ContextAssetReadRateLimiter(dependencies.now) : sharedReadRateLimiter)
        this.abortCleanup = () => this.cursorRegistry.clearInstance(context.principalId, context.instanceId)
        context.signal.addEventListener('abort', this.abortCleanup, { once: true })
    }

    private async state() {
        assertNotAborted(this.context)
        const state = await this.adapter.getState()
        assertNotAborted(this.context)
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

    private async moduleSnapshot(source: ContextModuleSource): Promise<ContextModuleSnapshot> {
        const base = {
            ...this.activeSummary(source),
            description: source.description,
            lorebook: copyLorebook(source.lorebook),
        }
        assertContextSnapshotLimits(base)
        const snapshot = { ...base, revision: await createRevision(base) }
        assertContextSnapshotLimits(snapshot)
        return snapshot
    }

    private moduleSourceIdentity(source: ContextModuleSource) {
        return JSON.stringify([
            source.id,
            source.namespace ?? null,
            source.name,
            source.description,
            source.lorebook.map((entry) => [entry.id, entry.name, entry.content, entry.enabled]),
            source.assets.map((asset) => [
                asset.identity,
                asset.storageKey,
                this.storageRevision(asset),
                asset.role,
            ]),
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
        left: { characterId: string; conversationId: string },
        right: { characterId: string; conversationId: string },
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

    async listContextModules(options: ContextModuleListOptions = {}): Promise<CursorPage<ContextModuleSnapshot>> {
        const scope = options.scope ?? 'active'
        if (scope !== 'active' && scope !== 'installed') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid module scope')
        }
        const limit = normalizeLimit(options.limit)
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

    private async assetDigest(source: ContextAssetSource, force = false) {
        const storageRevision = this.storageRevision(source)
        const cached = this.digestCache.get(source.storageKey)
        if (!force && cached?.storageRevision === storageRevision) return cached
        const data = await this.adapter.readAsset(source)
        if (!(data instanceof Uint8Array)) {
            throw new PluginApiError('INTERNAL', 'Asset backend returned invalid binary data')
        }
        const record: AssetDigestRecord = {
            storageRevision,
            revision: await digestBytes(data),
            byteLength: data.byteLength,
            mediaType: inferMediaType(source, data),
        }
        this.digestCache.set(source.storageKey, record)
        return record
    }

    private async assetReference(source: ContextAssetSource, origin: ContextAssetRef['origin']) {
        const digest = await this.assetDigest(source)
        const assetId = await this.handleFor(source, origin, digest.revision)
        this.issuedHandles.set(assetId, { identity: source.identity, origin })
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
            source,
            origin: { kind: 'character' as const, characterId },
        }))
    }

    private moduleAssets(modules: readonly ContextModuleSource[]) {
        return modules.flatMap((module) => module.assets.map((source) => ({
            source,
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

    async listContextAssets(options: ContextAssetListOptions = {}) {
        const moduleScope = options.moduleScope ?? 'active'
        if (!['active', 'installed', 'none'].includes(moduleScope)) {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid module asset scope')
        }
        const limit = normalizeLimit(options.limit)
        const include = this.normalizeIncludes(options.include)
        const mediaTypes = this.normalizeMediaTypes(options.mediaTypes)
        const preflight = await this.state()
        this.current(preflight)
        await this.dependencies.requirePermission('contextAssets')
        if (moduleScope === 'installed') await this.dependencies.requirePermission('installedModulesRead')
        const state = await this.state()
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
                const references = await Promise.all(pageSources
                    .map(({ source, origin }) => this.assetReference(source, origin)))
                const nextOffset = offset + pageSources.length
                return {
                    items: mediaTypes
                        ? references.filter((reference) => reference.mediaType && mediaTypes.includes(reference.mediaType))
                        : references,
                    contextRevision: await this.contextRevision(state),
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
            const fresh = await this.state()
            const refreshed = this.resolveSelectors(fresh, options)
            if (!this.sameSelectors(selectors, refreshed)
                || authorizedPageSources.some((source) => !this.sourceStillAuthorized(fresh, source, moduleScope))) {
                throw this.contextChanged()
            }
            assertContextSnapshotLimits(result)
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

    private async locateAsset(state: ContextHostState, assetId: string, expectedRevision?: Revision) {
        const issued = this.issuedHandles.get(assetId)
        if (!issued && !expectedRevision) {
            throw new PluginApiError('NOT_FOUND', 'Context asset was not found')
        }
        const candidates = this.allAssets(state)
        if (issued) {
            const candidate = candidates.find((value) => value.source.identity === issued.identity
                && this.sameOrigin(value.origin, issued.origin))
            if (candidate) return candidate
            throw new PluginApiError('NOT_FOUND', 'Context asset was not found')
        }
        for (const candidate of candidates) {
            if (await this.handleFor(candidate.source, candidate.origin, expectedRevision) === assetId) {
                this.issuedHandles.set(assetId, { identity: candidate.source.identity, origin: candidate.origin })
                return candidate
            }
        }
        throw new PluginApiError('NOT_FOUND', 'Context asset was not found')
    }

    private async authorizeAssetOrigin(state: ContextHostState, located: LocatedAsset) {
        if (located.origin.kind === 'character') {
            if (!this.authorizedCharacterIds(state).has(located.origin.characterId)) {
                throw new PluginApiError('PERMISSION_DENIED', 'Character asset is outside the current context')
            }
            return
        }
        if (!located.activeModule) await this.dependencies.requirePermission('installedModulesRead')
    }

    private async reauthorizeAssetOrigin(located: LocatedAsset) {
        const state = await this.state()
        const current = this.allAssets(state).find((candidate) => candidate.source.identity === located.source.identity
            && this.sameOrigin(candidate.origin, located.origin))
        if (!current) throw new PluginApiError('NOT_FOUND', 'Context asset was removed while it was being read')
        await this.authorizeAssetOrigin(state, current)
        assertNotAborted(this.context)
        if (this.storageRevision(current.source) !== this.storageRevision(located.source)) {
            throw new PluginApiError('CONFLICT', 'Context asset changed while it was being read')
        }
    }

    async readContextAsset(
        assetId: string,
        options: { ifRevision?: Revision; variant?: 'original' | 'thumbnail'; maxBytes?: number } = {},
    ) {
        const variant = options.variant ?? 'original'
        if (variant !== 'original' && variant !== 'thumbnail') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid context asset variant')
        }
        const maxBytes = normalizeAssetReadBytes(options.maxBytes)
        validateAssetReadIdentifiers(assetId, options.ifRevision)
        const preflight = await this.state()
        this.current(preflight)
        await this.dependencies.requirePermission('contextAssets')
        // Charge every well-formed, permission-bearing attempt before handle or digest scanning.
        this.readRateLimiter.consume(this.context.principalId)
        const state = await this.state()
        this.current(state)
        const located = await this.locateAsset(state, assetId, options.ifRevision)
        await this.authorizeAssetOrigin(state, located)
        const cached = this.digestCache.get(located.source.storageKey)
        if (variant === 'original' && cached && cached.storageRevision === this.storageRevision(located.source)
            && cached.byteLength > maxBytes) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Context asset exceeds maxBytes')
        }
        const data = await this.adapter.readAsset(located.source)
        if (!(data instanceof Uint8Array)) {
            throw new PluginApiError('INTERNAL', 'Asset backend returned invalid binary data')
        }
        if (data.byteLength > MAX_ASSET_READ_BYTES) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Context asset exceeds the hard read limit')
        }
        const digest: AssetDigestRecord = {
            storageRevision: this.storageRevision(located.source),
            revision: await digestBytes(data),
            byteLength: data.byteLength,
            mediaType: inferMediaType(located.source, data),
        }
        this.digestCache.set(located.source.storageKey, digest)
        const currentHandle = await this.handleFor(located.source, located.origin, digest.revision)
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
        if (variant === 'original') {
            if (data.byteLength > maxBytes) throw new PluginApiError('RESOURCE_LIMIT', 'Context asset exceeds maxBytes')
            await this.reauthorizeAssetOrigin(located)
            return {
                data: data.slice(),
                revision: digest.revision,
                name: located.source.name,
                mediaType: digest.mediaType,
            }
        }
        if (!digest.mediaType.startsWith('image/')) {
            throw new PluginApiError('DECODE_FAILED', 'Only image assets can be thumbnailed')
        }
        const thumbnail = await this.adapter.createThumbnail(located.source, data, {
            longEdge: THUMBNAIL_LONG_EDGE,
            maxPixels: MAX_THUMBNAIL_PIXELS,
            maxOutputBytes: MAX_THUMBNAIL_OUTPUT_BYTES,
        })
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
        await this.reauthorizeAssetOrigin(located)
        return {
            data: thumbnail.data.slice(),
            revision: digest.revision,
            name: located.source.name,
            mediaType: normalizedMediaType(thumbnail.mediaType) ?? 'application/octet-stream',
        }
    }
}
