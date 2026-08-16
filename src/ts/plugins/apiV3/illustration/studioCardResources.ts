import { PluginApiError } from './errors'
import { createRevision, validateJsonLimits } from './revision'
import {
    assertContextSnapshotLimits,
    type CharacterCardSnapshot,
    type ContextAssetRef,
    type ContextAssetRole,
} from './contextResources'
import type { PluginExecutionContext } from './permissions'
import type { ContextAssetReadCoordinator } from './contextAssetReadCoordinator'
import type { ContextAssetAuthorityRegistry } from './contextAssetAuthorityRegistry'

export type StudioCardKind = 'character' | 'group'
export interface StudioCardPortraitDescriptor { assetId: string; revision: string; name: string; mediaType: string }
export interface StudioCardSummary { cardId: string; catalogueItemRevision: string; kind: StudioCardKind; name: string; groupMemberCount: number; portrait?: StudioCardPortraitDescriptor }
export interface StudioCardCataloguePage { catalogueRevision: string; total: number; hostActiveCard?: StudioCardSummary; items: StudioCardSummary[]; nextCursor?: string }
export interface StudioCardSourceCapture { targetRevision: string; captureRevision: string; sourceRevision: string; card: CharacterCardSnapshot; groupMembers: CharacterCardSnapshot[] }
export interface StudioCardLogicalAssetDescriptor { logicalAssetId: string; assetRevision: string; ownerCardId: string; name: string; mediaType: string; role: ContextAssetRole }
export interface StudioCardAssetPage { captureRevision: string; assets: StudioCardLogicalAssetDescriptor[]; nextCursor?: string }
export interface StudioCardAssetAccessBatch { captureRevision: string; accessRevision: string; purpose: 'candidate-page' | 'selected'; assets: Array<{ logicalAssetId: string; asset: ContextAssetRef }> }
export interface StudioCardCatalogueOptions { search?: string; kind?: 'all' | StudioCardKind; cursor?: string; limit?: number; catalogueRevision?: string; signal?: AbortSignal }
export interface StudioCardSourceCaptureOptions { cardId: string; expectedCatalogueItemRevision: string; catalogueRevision: string; signal?: AbortSignal }
export type StudioCardSourceCaptureInput = StudioCardSourceCaptureOptions | { targetRevision: string; expectedSourceRevision: string; signal?: AbortSignal } | { targetRevision: string; acceptCurrentSourceRevision: true; signal?: AbortSignal }
export interface StudioCardAssetListOptions { captureRevision: string; cursor?: string; limit?: number; mediaTypes?: string[]; signal?: AbortSignal }
export interface StudioCardAssetAccessOptions { captureRevision: string; logicalAssetIds: string[]; purpose: 'candidate-page' | 'selected'; signal?: AbortSignal }
export interface StudioCardAssetLocator { ownerCardId: string; ownerRevision: string; storageRevision: string; nativeSlot: number }
export interface StudioCardNativeRecord { cardId: string; catalogueItemRevision: string; kind: StudioCardKind; name: string; groupMemberIds: string[]; portrait?: { revision: string; name: string; mediaType: string; locator: StudioCardAssetLocator } }
export interface StudioCardNativeCatalogue { nativeRevision: string; hostActiveCardId?: string; records: StudioCardNativeRecord[]; authority: object }
export interface StudioCardNativeSource { nativeRevision: string; card: CharacterCardSnapshot; groupMembers: CharacterCardSnapshot[]; assets: Array<{ logicalIdentity: string; revision: string; name: string; mediaType: string; role: ContextAssetRole; locator: StudioCardAssetLocator }>; authority: object }
export interface StudioCardResourceAdapter { captureCatalogue(): Promise<StudioCardNativeCatalogue>; revalidateCatalogue(capture: StudioCardNativeCatalogue): boolean; captureSource(cardId: string): Promise<StudioCardNativeSource | null>; revalidateSource(capture: StudioCardNativeSource): boolean; readAsset(locator: StudioCardAssetLocator): Promise<Uint8Array | null>; captureGeneration(): string; isGenerationCurrent(generation: string): boolean }
export interface StudioCardResourceService { listStudioCards(options?: StudioCardCatalogueOptions): Promise<StudioCardCataloguePage>; releaseStudioCardCatalogue(catalogueRevision: string): Promise<void>; captureStudioCardSource(input: StudioCardSourceCaptureInput): Promise<StudioCardSourceCapture>; releaseStudioCardTarget(targetRevision: string): Promise<void>; listStudioCardAssets(options: StudioCardAssetListOptions): Promise<StudioCardAssetPage>; resolveStudioCardAssetHandles(options: StudioCardAssetAccessOptions): Promise<StudioCardAssetAccessBatch>; releaseStudioCardAssetAccess(accessRevision: string): Promise<void>; releaseStudioCardSource(captureRevision: string): Promise<void>; dispose(): void }

const TTL = 300_000
const TARGET_TTL = 1_800_000
const MAX_RECORDS = 4
const MAX_CATALOGUE_BYTES = 4 * 1024 * 1024
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
const MAX_CAPTURE_ITEMS = 20_000
const textEncoder = new TextEncoder()
const abortError = () => new PluginApiError('ABORTED', 'Studio card operation was cancelled')
const notFound = (name: string) => new PluginApiError('NOT_FOUND', `${name} was not found or expired`)

interface CatalogueRecord {
    revision: string; native: StudioCardNativeCatalogue; generation: string; permission: string
    records: StudioCardNativeRecord[]; byId: Map<string, StudioCardNativeRecord>; filtered: StudioCardNativeRecord[]
    search: string; kind: 'all' | StudioCardKind; pages: Map<string, { handles: Set<string>; cardIds: Set<string> }>; retainedPages: string[]
    activeHandles: Set<string>; metadataBytes: number; lastUsed: number; expiresAt: number
}
interface CursorRecord { kind: 'catalogue' | 'assets'; parentRevision: string; offset: number; query: string; expiresAt: number }
interface AssetRecord { descriptor: StudioCardLogicalAssetDescriptor; identity: string; locator: StudioCardAssetLocator }
interface TargetRecord { revision: string; cardId: string; itemRevision: string; sourceRevision: string; generation: string; permission: string; captures: Set<string>; lastUsed: number; expiresAt: number }
interface CaptureRecord { revision: string; targetRevision: string; sourceRevision: string; native: StudioCardNativeSource; card: CharacterCardSnapshot; members: CharacterCardSnapshot[]; assets: AssetRecord[]; assetById: Map<string, AssetRecord>; accesses: Set<string>; candidateAccesses: string[]; selectedAccess?: string; metadataBytes: number; itemCount: number; lastUsed: number; expiresAt: number }
interface AccessRecord { revision: string; captureRevision: string; purpose: 'candidate-page' | 'selected'; handles: string[]; lastUsed: number; expiresAt: number }

const randomRevision = (domain: string, context: PluginExecutionContext) => createRevision({
    version: 1, domain, principalId: context.principalId, instanceId: context.instanceId,
    nonce: crypto.randomUUID(),
})
const normalizeLimit = (value: number | undefined, fallback: number) => {
    const result = value ?? fallback
    if (!Number.isInteger(result) || result < 1 || result > 100) throw new PluginApiError('INVALID_ARGUMENT', 'limit must be an integer from 1 through 100')
    return result
}
const safeString = (value: unknown, name: string) => {
    if (typeof value !== 'string' || value.length === 0) throw new PluginApiError('CONFLICT', `Native ${name} is invalid`)
    return value
}
const copyCard = (value: CharacterCardSnapshot): CharacterCardSnapshot => {
    const result: CharacterCardSnapshot = {
        id: safeString(value.id, 'card id'), revision: safeString(value.revision, 'card revision'),
        type: value.type, name: safeString(value.name, 'card name'),
        textSections: value.textSections.map((section) => ({ key: section.key, label: section.label, content: section.content })),
        lorebook: value.lorebook.map((entry) => ({ id: entry.id, name: entry.name, content: entry.content, enabled: entry.enabled })),
        ...(value.groupMemberIds ? { groupMemberIds: [...value.groupMemberIds] } : {}),
    }
    assertContextSnapshotLimits(result)
    return result
}

class StudioCardResourceServiceImpl implements StudioCardResourceService {
    private static readonly live = new Set<StudioCardResourceServiceImpl>()
    private readonly catalogues = new Map<string, CatalogueRecord>()
    private readonly cursors = new Map<string, CursorRecord>()
    private readonly targets = new Map<string, TargetRecord>()
    private readonly captures = new Map<string, CaptureRecord>()
    private readonly accesses = new Map<string, AccessRecord>()
    private disposed = false
    private serviceGeneration = 0
    private readonly abort = () => this.dispose()

    constructor(private readonly input: { context: PluginExecutionContext; adapter: StudioCardResourceAdapter; assetAuthorityRegistry: ContextAssetAuthorityRegistry; readCoordinator: ContextAssetReadCoordinator; permissionGeneration(): string; requirePermission(): Promise<void>; now?: () => number }) {
        StudioCardResourceServiceImpl.live.add(this)
        input.context.signal.addEventListener('abort', this.abort, { once: true })
        if (input.context.signal.aborted) this.dispose()
    }

    private now() { return (this.input.now ?? Date.now)() }
    private owner() { return { principalId: this.input.context.principalId, instanceId: this.input.context.instanceId } }
    private assertActive(generation = this.serviceGeneration, signal?: AbortSignal) {
        if (this.disposed || generation !== this.serviceGeneration || this.input.context.signal.aborted || signal?.aborted) throw abortError()
    }
    private async authorize(generation: number, signal?: AbortSignal) {
        this.assertActive(generation, signal)
        const permission = this.input.permissionGeneration()
        await this.input.requirePermission()
        this.assertActive(generation, signal)
        if (permission !== this.input.permissionGeneration()) {
            this.invalidate()
            throw abortError()
        }
        return permission
    }
    private invalidate() {
        this.serviceGeneration += 1
        for (const revision of [...this.catalogues.keys()]) this.revokeCatalogue(revision)
        for (const revision of [...this.targets.keys()]) this.revokeTarget(revision)
        this.cursors.clear()
    }
    private cleanup() {
        const now = this.now()
        for (const [revision, cursor] of this.cursors) if (cursor.expiresAt <= now) this.cursors.delete(revision)
        for (const [revision, access] of this.accesses) if (access.expiresAt <= now) this.revokeAccess(revision)
        for (const [revision, capture] of this.captures) if (capture.expiresAt <= now) this.revokeCapture(revision)
        for (const [revision, target] of this.targets) if (target.expiresAt <= now) this.revokeTarget(revision)
        for (const [revision, catalogue] of this.catalogues) if (catalogue.expiresAt <= now) this.revokeCatalogue(revision)
    }
    private touchCatalogue(record: CatalogueRecord) { record.lastUsed = this.now(); record.expiresAt = record.lastUsed + TTL }
    private touchTarget(record: TargetRecord) { record.lastUsed = this.now(); record.expiresAt = record.lastUsed + TARGET_TTL }
    private touchCapture(record: CaptureRecord) { record.lastUsed = this.now(); record.expiresAt = record.lastUsed + TTL; const target = this.targets.get(record.targetRevision); if (target) this.touchTarget(target) }
    private touchAccess(record: AccessRecord) { record.lastUsed = this.now(); record.expiresAt = record.lastUsed + TTL; const capture = this.captures.get(record.captureRevision); if (capture) this.touchCapture(capture) }
    private ensurePrincipalRoom(kind: 'catalogue' | 'target' | 'capture', metadataBytes = 0, itemCount = 0) {
        const peers = [...StudioCardResourceServiceImpl.live].filter((service) =>
            !service.disposed && service.input.context.principalId === this.input.context.principalId)
        const entries = () => peers.flatMap((service) => {
            const records = kind === 'catalogue' ? service.catalogues : kind === 'target' ? service.targets : service.captures
            return [...records].map(([revision, record]) => ({ service, revision, record }))
        })
        const overBudget = () => {
            const current = entries()
            if (current.length >= MAX_RECORDS) return true
            if (kind === 'catalogue') return current.reduce((sum, item) => sum + (item.record as CatalogueRecord).metadataBytes, 0) + metadataBytes > MAX_CATALOGUE_BYTES
            if (kind === 'capture') return current.reduce((sum, item) => sum + (item.record as CaptureRecord).metadataBytes, 0) + metadataBytes > MAX_CAPTURE_BYTES
                || current.reduce((sum, item) => sum + (item.record as CaptureRecord).itemCount, 0) + itemCount > MAX_CAPTURE_ITEMS
            return false
        }
        while (overBudget()) {
            const candidate = entries().filter(({ record }) => kind === 'catalogue'
                || kind === 'target' && (record as TargetRecord).captures.size === 0
                || kind === 'capture' && (record as CaptureRecord).accesses.size === 0)
                .sort((left, right) => left.record.lastUsed - right.record.lastUsed)[0]
            if (!candidate) throw new PluginApiError('RESOURCE_LIMIT', 'All retained Studio card authorities are pinned', { retryable: true })
            if (kind === 'catalogue') candidate.service.revokeCatalogue(candidate.revision)
            else if (kind === 'target') candidate.service.revokeTarget(candidate.revision)
            else candidate.service.revokeCapture(candidate.revision)
        }
    }
    private catalogue(revision: string) { this.cleanup(); const value = this.catalogues.get(revision); if (!value) throw notFound('Studio card catalogue'); this.touchCatalogue(value); return value }
    private target(revision: string) { this.cleanup(); const value = this.targets.get(revision); if (!value) throw notFound('Studio card target'); this.touchTarget(value); return value }
    private capture(revision: string) { this.cleanup(); const value = this.captures.get(revision); if (!value) throw notFound('Studio card capture'); this.touchCapture(value); return value }
    private access(revision: string) { this.cleanup(); const value = this.accesses.get(revision); if (!value) throw notFound('Studio card access'); this.touchAccess(value); return value }

    private validateCatalogue(record: CatalogueRecord) {
        if (record.permission !== this.input.permissionGeneration() || !this.input.adapter.isGenerationCurrent(record.generation)
            || !this.input.adapter.revalidateCatalogue(record.native)) throw new PluginApiError('CONFLICT', 'Studio card catalogue changed')
    }
    private async assetHandle(parentRevision: string, identity: string) {
        const revision = await createRevision({ version: 1, domain: 'studio-card-asset-handle.v1', ...this.owner(), parentRevision, identity })
        return `ctxasset_${revision.slice('sha256:'.length)}`
    }
    private async portrait(record: CatalogueRecord, native: StudioCardNativeRecord, parentRevision: string) {
        if (!native.portrait) return undefined
        const portrait = native.portrait
        const assetId = await this.assetHandle(parentRevision, `${native.cardId}:${portrait.revision}:${portrait.locator.nativeSlot}`)
        const authority = {
            ...this.owner(), assetId, parentRevision, authorityKind: 'studio-catalogue-portrait' as const,
            revision: portrait.revision, name: portrait.name, mediaType: portrait.mediaType,
            validate: async (signal?: AbortSignal) => {
                const generation = this.serviceGeneration
                await this.authorize(generation, signal)
                if (this.catalogues.get(record.revision) !== record || !record.pages.has(parentRevision) && parentRevision !== record.revision) throw notFound('Studio catalogue portrait')
                this.validateCatalogue(record)
                this.touchCatalogue(record)
            },
            read: (signal?: AbortSignal) => this.input.adapter.readAsset(portrait.locator).then((data) => {
                this.assertActive(this.serviceGeneration, signal)
                return data
            }),
        }
        this.input.assetAuthorityRegistry.register(authority)
        return { assetId, revision: portrait.revision, name: portrait.name, mediaType: portrait.mediaType }
    }
    private async summary(record: CatalogueRecord, native: StudioCardNativeRecord, parentRevision: string): Promise<StudioCardSummary> {
        return {
            cardId: native.cardId, catalogueItemRevision: native.catalogueItemRevision, kind: native.kind,
            name: native.name, groupMemberCount: native.kind === 'group' ? new Set(native.groupMemberIds).size : 0,
            ...(native.portrait ? { portrait: await this.portrait(record, native, parentRevision) } : {}),
        }
    }

    async listStudioCards(options: StudioCardCatalogueOptions = {}): Promise<StudioCardCataloguePage> {
        const generation = this.serviceGeneration
        const signal = options.signal
        this.assertActive(generation, signal)
        const limit = normalizeLimit(options.limit, 24)
        const search = (options.search ?? '').normalize('NFKC')
        if (textEncoder.encode(search).byteLength > 256) throw new PluginApiError('INVALID_ARGUMENT', 'search exceeds 256 UTF-8 bytes')
        const kind = options.kind ?? 'all'
        if (!['all', 'character', 'group'].includes(kind)) throw new PluginApiError('INVALID_ARGUMENT', 'Invalid Studio card kind')
        const permission = await this.authorize(generation, signal)
        let record: CatalogueRecord
        let offset = 0
        if (options.cursor || options.catalogueRevision) {
            if (!options.cursor || !options.catalogueRevision) throw new PluginApiError('INVALID_ARGUMENT', 'cursor and catalogueRevision must be supplied together')
            record = this.catalogue(options.catalogueRevision)
            const cursor = this.cursors.get(options.cursor)
            if (!cursor || cursor.kind !== 'catalogue' || cursor.parentRevision !== record.revision || cursor.expiresAt <= this.now()
                || cursor.query !== JSON.stringify([search, kind])) throw new PluginApiError('INVALID_ARGUMENT', 'Invalid or expired Studio card cursor')
            this.cursors.delete(options.cursor)
            offset = cursor.offset
            this.validateCatalogue(record)
        } else {
            this.cleanup()
            const adapterGeneration = this.input.adapter.captureGeneration()
            const native = await this.input.adapter.captureCatalogue()
            this.assertActive(generation, signal)
            if (!this.input.adapter.isGenerationCurrent(adapterGeneration) || !this.input.adapter.revalidateCatalogue(native)) throw new PluginApiError('CONFLICT', 'Studio card catalogue changed during capture')
            const seen = new Set<string>()
            const records = native.records.map((item) => {
                safeString(item.cardId, 'card id'); safeString(item.catalogueItemRevision, 'catalogue item revision'); safeString(item.name, 'card name')
                if (seen.has(item.cardId) || !['character', 'group'].includes(item.kind)) throw new PluginApiError('CONFLICT', 'Native Studio catalogue is malformed')
                seen.add(item.cardId)
                return { ...item, groupMemberIds: [...new Set(item.groupMemberIds)].sort() }
            })
            const catalogueCanonical = validateJsonLimits(records.map(({ portrait, ...item }) => ({ ...item, ...(portrait ? { portrait: { revision: portrait.revision, name: portrait.name, mediaType: portrait.mediaType } } : {}) })), { maxDepth: 16, maxBytes: MAX_CATALOGUE_BYTES })
            const filtered = records.filter((item) => (kind === 'all' || item.kind === kind)
                && item.name.normalize('NFKC').toLocaleLowerCase().includes(search.toLocaleLowerCase()))
                .sort((left, right) => left.name.localeCompare(right.name) || left.cardId.localeCompare(right.cardId))
            const revision = await randomRevision('studio-card-catalogue.v1', this.input.context)
            this.assertActive(generation, signal)
            this.ensurePrincipalRoom('catalogue', textEncoder.encode(catalogueCanonical).byteLength)
            record = { revision, native, generation: adapterGeneration, permission, records, byId: new Map(records.map((item) => [item.cardId, item])), filtered, search, kind, pages: new Map(), retainedPages: [], activeHandles: new Set(), metadataBytes: textEncoder.encode(catalogueCanonical).byteLength, lastUsed: this.now(), expiresAt: this.now() + TTL }
            this.catalogues.set(revision, record)
        }
        const pageNative = record.filtered.slice(offset, offset + limit)
        const pageRevision = await randomRevision('studio-card-catalogue-page.v1', this.input.context)
        const handles = new Set<string>()
        record.pages.set(pageRevision, { handles, cardIds: new Set(pageNative.map((item) => item.cardId)) })
        let items: StudioCardSummary[]
        try {
            items = await Promise.all(pageNative.map((item) => this.summary(record, item, pageRevision)))
        } catch (error) {
            record.pages.delete(pageRevision)
            this.input.assetAuthorityRegistry.revokeParent(this.input.context.principalId, this.input.context.instanceId, pageRevision)
            throw error
        }
        for (const item of items) if (item.portrait) handles.add(item.portrait.assetId)
        record.retainedPages.push(pageRevision)
        while (record.retainedPages.length > 2) {
            const expired = record.retainedPages.shift()!
            record.pages.delete(expired)
            this.input.assetAuthorityRegistry.revokeParent(this.input.context.principalId, this.input.context.instanceId, expired)
        }
        let hostActiveCard: StudioCardSummary | undefined
        const active = record.native.hostActiveCardId ? record.byId.get(record.native.hostActiveCardId) : undefined
        if (active) hostActiveCard = await this.summary(record, active, record.revision)
        const nextOffset = offset + pageNative.length
        let nextCursor: string | undefined
        if (nextOffset < record.filtered.length) {
            nextCursor = crypto.randomUUID()
            this.cursors.set(nextCursor, { kind: 'catalogue', parentRevision: record.revision, offset: nextOffset, query: JSON.stringify([search, kind]), expiresAt: this.now() + TTL })
        }
        this.validateCatalogue(record)
        return { catalogueRevision: record.revision, total: record.filtered.length, ...(hostActiveCard ? { hostActiveCard } : {}), items, ...(nextCursor ? { nextCursor } : {}) }
    }

    async releaseStudioCardCatalogue(revision: string) { this.catalogue(revision); this.revokeCatalogue(revision) }
    private revokeCatalogue(revision: string) {
        const record = this.catalogues.get(revision); if (!record) return
        this.catalogues.delete(revision)
        for (const page of record.pages.keys()) this.input.assetAuthorityRegistry.revokeParent(this.input.context.principalId, this.input.context.instanceId, page)
        this.input.assetAuthorityRegistry.revokeParent(this.input.context.principalId, this.input.context.instanceId, revision)
        for (const [cursor, value] of this.cursors) if (value.parentRevision === revision) this.cursors.delete(cursor)
    }

    private async materialize(native: StudioCardNativeSource, cardId: string) {
        const root = copyCard(native.card)
        if (root.id !== cardId) throw new PluginApiError('CONFLICT', 'Native source returned the wrong card')
        const wanted = root.type === 'group' ? [...new Set(root.groupMemberIds ?? [])].sort() : []
        if (wanted.length > 100 || root.type === 'character' && native.groupMembers.length > 0) throw new PluginApiError('RESOURCE_LIMIT', 'Studio card has too many direct members')
        const memberMap = new Map<string, CharacterCardSnapshot>()
        for (const member of native.groupMembers) {
            if (member.type !== 'character') throw new PluginApiError('CONFLICT', 'Nested or malformed Studio group membership')
            if (!memberMap.has(member.id)) memberMap.set(member.id, copyCard(member))
        }
        if (wanted.some((id) => !memberMap.has(id)) || [...memberMap.keys()].some((id) => !wanted.includes(id))) throw new PluginApiError('CONFLICT', 'Studio group membership changed')
        const members = wanted.map((id) => memberMap.get(id)!)
        const owners = new Set([root.id, ...members.map((member) => member.id)])
        if (native.assets.length + 1 + members.length > MAX_CAPTURE_ITEMS) throw new PluginApiError('RESOURCE_LIMIT', 'Studio card capture item limit exceeded')
        const assets: AssetRecord[] = []
        const identities = new Map<string, string>()
        for (const asset of native.assets) {
            if (!owners.has(asset.locator.ownerCardId) || !Number.isInteger(asset.locator.nativeSlot) || asset.locator.nativeSlot < 0) throw new PluginApiError('CONFLICT', 'Native Studio asset locator is invalid')
            const digest = await createRevision({ version: 1, domain: 'studio-card-logical-asset.v1', principalId: this.input.context.principalId, logicalIdentity: asset.logicalIdentity })
            const logicalAssetId = `studioasset_${digest.slice('sha256:'.length)}`
            const collision = identities.get(logicalAssetId)
            if (collision !== undefined && collision !== asset.logicalIdentity || collision === asset.logicalIdentity) throw new PluginApiError('CONFLICT', 'Native Studio logical asset identity collision')
            identities.set(logicalAssetId, asset.logicalIdentity)
            assets.push({ descriptor: { logicalAssetId, assetRevision: asset.revision, ownerCardId: asset.locator.ownerCardId, name: asset.name, mediaType: asset.mediaType, role: asset.role }, identity: asset.logicalIdentity, locator: { ...asset.locator } })
        }
        assets.sort((left, right) => left.descriptor.logicalAssetId.localeCompare(right.descriptor.logicalAssetId))
        const publicShape = { card: root, groupMembers: members, assets: assets.map((item) => item.descriptor) }
        const canonical = validateJsonLimits(publicShape, { maxDepth: 32, maxBytes: MAX_CAPTURE_BYTES })
        const sourceRevision = await createRevision({ version: 1, domain: 'studio-card-source.v1', ...publicShape })
        return { root, members, assets, sourceRevision, metadataBytes: textEncoder.encode(canonical).byteLength, itemCount: native.assets.length + 1 + members.length }
    }

    async captureStudioCardSource(input: StudioCardSourceCaptureInput): Promise<StudioCardSourceCapture> {
        const generation = this.serviceGeneration; const signal = input.signal
        const permission = await this.authorize(generation, signal)
        let cardId: string; let target: TargetRecord | undefined; let explicit = false; let itemRevision = ''
        if ('cardId' in input) {
            const catalogue = this.catalogue(input.catalogueRevision); this.validateCatalogue(catalogue)
            const admitted = catalogue.native.hostActiveCardId === input.cardId
                || [...catalogue.pages].some(([page, retained]) => catalogue.retainedPages.includes(page)
                    && retained.cardIds.has(input.cardId))
            const nativeRecord = catalogue.byId.get(input.cardId)
            if (!admitted || !nativeRecord || nativeRecord.catalogueItemRevision !== input.expectedCatalogueItemRevision) throw new PluginApiError('CONFLICT', 'Studio card selection is stale or was not retained')
            cardId = input.cardId; itemRevision = nativeRecord.catalogueItemRevision
        } else {
            target = this.target(input.targetRevision); cardId = target.cardId; itemRevision = target.itemRevision
            if ('expectedSourceRevision' in input && input.expectedSourceRevision !== target.sourceRevision) throw new PluginApiError('CONFLICT', 'Studio card source revision is stale')
            explicit = 'acceptCurrentSourceRevision' in input
        }
        const adapterGeneration = this.input.adapter.captureGeneration()
        const native = await this.input.adapter.captureSource(cardId)
        this.assertActive(generation, signal)
        if (!native) throw notFound('Studio card source')
        if (!this.input.adapter.isGenerationCurrent(adapterGeneration) || !this.input.adapter.revalidateSource(native)) throw new PluginApiError('CONFLICT', 'Studio card source changed during capture')
        const materialized = await this.materialize(native, cardId)
        this.assertActive(generation, signal)
        if (!this.input.adapter.isGenerationCurrent(adapterGeneration) || !this.input.adapter.revalidateSource(native)) throw new PluginApiError('CONFLICT', 'Studio card source changed during capture')
        if (target && !explicit && materialized.sourceRevision !== target.sourceRevision) throw new PluginApiError('CONFLICT', 'Studio card source changed')
        const captureRevision = await randomRevision('studio-card-capture.v1', this.input.context)
        const targetRevision = !target || explicit ? await randomRevision('studio-card-target.v1', this.input.context) : target.revision
        this.assertActive(generation, signal)
        if (!this.input.adapter.isGenerationCurrent(adapterGeneration) || !this.input.adapter.revalidateSource(native)) throw new PluginApiError('CONFLICT', 'Studio card source changed during capture')
        this.ensurePrincipalRoom('capture', materialized.metadataBytes, materialized.itemCount)
        if (!target || explicit) {
            this.ensurePrincipalRoom('target')
            target = { revision: targetRevision, cardId, itemRevision, sourceRevision: materialized.sourceRevision, generation: adapterGeneration, permission, captures: new Set(), lastUsed: this.now(), expiresAt: this.now() + TARGET_TTL }
            this.targets.set(targetRevision, target)
        }
        const capture: CaptureRecord = { revision: captureRevision, targetRevision: target.revision, sourceRevision: materialized.sourceRevision, native, card: materialized.root, members: materialized.members, assets: materialized.assets, assetById: new Map(materialized.assets.map((asset) => [asset.descriptor.logicalAssetId, asset])), accesses: new Set(), candidateAccesses: [], metadataBytes: materialized.metadataBytes, itemCount: materialized.itemCount, lastUsed: this.now(), expiresAt: this.now() + TTL }
        this.captures.set(captureRevision, capture); target.captures.add(captureRevision); target.sourceRevision = materialized.sourceRevision
        return { targetRevision: target.revision, captureRevision, sourceRevision: materialized.sourceRevision, card: structuredClone(materialized.root), groupMembers: structuredClone(materialized.members) }
    }

    async releaseStudioCardTarget(revision: string) { this.target(revision); this.revokeTarget(revision) }
    private revokeTarget(revision: string) { const target = this.targets.get(revision); if (!target) return; this.targets.delete(revision); for (const capture of [...target.captures]) this.revokeCapture(capture) }
    async releaseStudioCardSource(revision: string) { this.capture(revision); this.revokeCapture(revision) }
    private revokeCapture(revision: string) { const capture = this.captures.get(revision); if (!capture) return; this.captures.delete(revision); for (const access of [...capture.accesses]) this.revokeAccess(access); this.targets.get(capture.targetRevision)?.captures.delete(revision); for (const [cursor, value] of this.cursors) if (value.parentRevision === revision) this.cursors.delete(cursor) }

    async listStudioCardAssets(options: StudioCardAssetListOptions): Promise<StudioCardAssetPage> {
        const generation = this.serviceGeneration; await this.authorize(generation, options.signal)
        const capture = this.capture(options.captureRevision)
        const limit = normalizeLimit(options.limit, 100)
        const mediaTypes = options.mediaTypes?.map((value) => value.trim().toLowerCase()).filter(Boolean) ?? []
        let offset = 0
        if (options.cursor) {
            const cursor = this.cursors.get(options.cursor)
            if (!cursor || cursor.kind !== 'assets' || cursor.parentRevision !== capture.revision || cursor.query !== JSON.stringify(mediaTypes) || cursor.expiresAt <= this.now()) throw new PluginApiError('INVALID_ARGUMENT', 'Invalid or expired Studio asset cursor')
            this.cursors.delete(options.cursor); offset = cursor.offset
        }
        if (!this.input.adapter.revalidateSource(capture.native)) throw new PluginApiError('CONFLICT', 'Studio card source changed')
        const filtered = mediaTypes.length ? capture.assets.filter((asset) => mediaTypes.includes(asset.descriptor.mediaType.toLowerCase())) : capture.assets
        const assets = filtered.slice(offset, offset + limit).map((asset) => ({ ...asset.descriptor }))
        let nextCursor: string | undefined
        if (offset + assets.length < filtered.length) { nextCursor = crypto.randomUUID(); this.cursors.set(nextCursor, { kind: 'assets', parentRevision: capture.revision, offset: offset + assets.length, query: JSON.stringify(mediaTypes), expiresAt: this.now() + TTL }) }
        return { captureRevision: capture.revision, assets, ...(nextCursor ? { nextCursor } : {}) }
    }

    async resolveStudioCardAssetHandles(options: StudioCardAssetAccessOptions): Promise<StudioCardAssetAccessBatch> {
        const generation = this.serviceGeneration; await this.authorize(generation, options.signal)
        const capture = this.capture(options.captureRevision)
        const maximum = options.purpose === 'candidate-page' ? 24 : options.purpose === 'selected' ? 3 : 0
        if (options.logicalAssetIds.length < 1 || options.logicalAssetIds.length > maximum) throw new PluginApiError('INVALID_ARGUMENT', 'Invalid Studio card asset access batch size')
        const ids = new Set<string>(); let bytes = 0; const selected: AssetRecord[] = []
        for (const id of options.logicalAssetIds) {
            const size = textEncoder.encode(id).byteLength; bytes += size
            if (size > 256 || bytes > 6_144 || ids.has(id)) throw new PluginApiError('INVALID_ARGUMENT', 'Invalid Studio card logical asset IDs')
            ids.add(id); const asset = capture.assetById.get(id); if (!asset) throw new PluginApiError('NOT_FOUND', 'Studio card logical asset was not found'); selected.push(asset)
        }
        if (!this.input.adapter.revalidateSource(capture.native)) throw new PluginApiError('CONFLICT', 'Studio card source changed')
        const accessRevision = await randomRevision('studio-card-access.v1', this.input.context)
        const handles = await Promise.all(selected.map((asset) => this.assetHandle(accessRevision, asset.descriptor.logicalAssetId)))
        const access: AccessRecord = { revision: accessRevision, captureRevision: capture.revision, purpose: options.purpose, handles, lastUsed: this.now(), expiresAt: this.now() + TTL }
        const authorities = selected.map((asset, index) => ({
            ...this.owner(), assetId: handles[index], parentRevision: accessRevision, authorityKind: 'studio-card-capture' as const,
            revision: asset.descriptor.assetRevision, name: asset.descriptor.name, mediaType: asset.descriptor.mediaType,
            validate: async (signal?: AbortSignal) => {
                const operationGeneration = this.serviceGeneration
                await this.authorize(operationGeneration, signal)
                if (this.accesses.get(accessRevision) !== access || this.captures.get(capture.revision) !== capture || !this.targets.has(capture.targetRevision)) throw notFound('Studio card asset access')
                if (!this.input.adapter.isGenerationCurrent(this.targets.get(capture.targetRevision)!.generation) || !this.input.adapter.revalidateSource(capture.native)) throw new PluginApiError('CONFLICT', 'Studio card asset changed')
                this.touchAccess(access)
            },
            read: (_signal?: AbortSignal) => this.input.adapter.readAsset(asset.locator),
        }))
        try {
            for (const authority of authorities) this.input.assetAuthorityRegistry.register(authority)
        } catch (error) {
            this.input.assetAuthorityRegistry.revokeParent(this.input.context.principalId, this.input.context.instanceId, accessRevision)
            throw error
        }
        this.accesses.set(accessRevision, access); capture.accesses.add(accessRevision)
        if (options.purpose === 'candidate-page') {
            capture.candidateAccesses.push(accessRevision)
            while (capture.candidateAccesses.length > 2) this.revokeAccess(capture.candidateAccesses.shift()!)
        } else {
            if (capture.selectedAccess) this.revokeAccess(capture.selectedAccess)
            capture.selectedAccess = accessRevision
        }
        return { captureRevision: capture.revision, accessRevision, purpose: options.purpose, assets: selected.map((asset, index) => ({ logicalAssetId: asset.descriptor.logicalAssetId, asset: { assetId: handles[index], revision: asset.descriptor.assetRevision, name: asset.descriptor.name, mediaType: asset.descriptor.mediaType, role: asset.descriptor.role, origin: { kind: 'character', characterId: asset.descriptor.ownerCardId } } })) }
    }

    async releaseStudioCardAssetAccess(revision: string) { this.access(revision); this.revokeAccess(revision) }
    private revokeAccess(revision: string) { const access = this.accesses.get(revision); if (!access) return; this.accesses.delete(revision); this.input.assetAuthorityRegistry.revokeParent(this.input.context.principalId, this.input.context.instanceId, revision); const capture = this.captures.get(access.captureRevision); if (capture) { capture.accesses.delete(revision); capture.candidateAccesses = capture.candidateAccesses.filter((item) => item !== revision); if (capture.selectedAccess === revision) capture.selectedAccess = undefined } }
    dispose() { if (this.disposed) return; this.disposed = true; StudioCardResourceServiceImpl.live.delete(this); this.serviceGeneration += 1; this.input.context.signal.removeEventListener('abort', this.abort); this.input.assetAuthorityRegistry.clearInstance(this.input.context.principalId, this.input.context.instanceId); this.catalogues.clear(); this.cursors.clear(); this.targets.clear(); this.captures.clear(); this.accesses.clear(); this.input.readCoordinator.cancelInstance?.(this.owner()) }
}

export function createStudioCardResourceService(input: { context: PluginExecutionContext; adapter: StudioCardResourceAdapter; assetAuthorityRegistry: ContextAssetAuthorityRegistry; readCoordinator: ContextAssetReadCoordinator; permissionGeneration(): string; requirePermission(): Promise<void>; now?: () => number }): StudioCardResourceService {
    return new StudioCardResourceServiceImpl(input)
}
