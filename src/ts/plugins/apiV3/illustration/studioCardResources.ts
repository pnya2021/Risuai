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
import { CursorRegistry, illustrationCursorRegistry } from './cursorRegistry'
import type {
    ContextAssetAuthorityRegistry,
    StudioContextAssetAuthority,
} from './contextAssetAuthorityRegistry'
import { registerStudioCardRpcFinalizer } from '../studioCardRpcTransport'

export type StudioCardKind = 'character' | 'group'

export interface StudioCardPortraitDescriptor {
    assetId: string
    revision: string
    name: string
    mediaType: string
}

export interface StudioCardSummary {
    cardId: string
    catalogueItemRevision: string
    kind: StudioCardKind
    name: string
    groupMemberCount: number
    portrait?: StudioCardPortraitDescriptor
}

export interface StudioCardCataloguePage {
    catalogueRevision: string
    total: number
    hostActiveCard?: StudioCardSummary
    items: StudioCardSummary[]
    nextCursor?: string
}

export interface StudioCardSourceCapture {
    targetRevision: string
    captureRevision: string
    sourceRevision: string
    card: CharacterCardSnapshot
    groupMembers: CharacterCardSnapshot[]
}

export interface StudioCardLogicalAssetDescriptor {
    logicalAssetId: string
    assetRevision: string
    ownerCardId: string
    name: string
    mediaType: string
    role: ContextAssetRole
}

export interface StudioCardAssetPage {
    captureRevision: string
    assets: StudioCardLogicalAssetDescriptor[]
    nextCursor?: string
}

export interface StudioCardAssetAccessBatch {
    captureRevision: string
    accessRevision: string
    purpose: 'candidate-page' | 'selected'
    assets: Array<{ logicalAssetId: string; asset: ContextAssetRef }>
}

export interface StudioCardCatalogueOptions {
    search?: string
    kind?: 'all' | StudioCardKind
    cursor?: string
    limit?: number
    catalogueRevision?: string
    signal?: AbortSignal
}

export interface StudioCardSourceCaptureOptions {
    cardId: string
    expectedCatalogueItemRevision: string
    catalogueRevision: string
    signal?: AbortSignal
}

export type StudioCardSourceCaptureInput =
    | StudioCardSourceCaptureOptions
    | { targetRevision: string; expectedSourceRevision: string; signal?: AbortSignal }
    | { targetRevision: string; acceptCurrentSourceRevision: true; signal?: AbortSignal }

export interface StudioCardAssetListOptions {
    captureRevision: string
    cursor?: string
    limit?: number
    mediaTypes?: string[]
    signal?: AbortSignal
}

export interface StudioCardAssetAccessOptions {
    captureRevision: string
    logicalAssetIds: string[]
    purpose: 'candidate-page' | 'selected'
    signal?: AbortSignal
}

export interface StudioCardAssetLocator {
    ownerCardId: string
    ownerRevision: string
    storageRevision: string
    nativeSlot: number
}

export interface StudioCardNativeRecord {
    cardId: string
    catalogueItemRevision: string
    kind: StudioCardKind
    name: string
    groupMemberIds: string[]
    portrait?: {
        revision: string
        name: string
        mediaType: string
        locator: StudioCardAssetLocator
    }
}

export interface StudioCardNativeCatalogue {
    nativeRevision: string
    hostActiveCardId?: string
    records: StudioCardNativeRecord[]
    authority: object
}

export interface StudioCardNativeSource {
    nativeRevision: string
    card: CharacterCardSnapshot
    groupMembers: CharacterCardSnapshot[]
    assets: Array<{
        logicalIdentity: string
        revision: string
        name: string
        mediaType: string
        role: ContextAssetRole
        locator: StudioCardAssetLocator
    }>
    authority: object
}

export interface StudioCardResourceAdapter {
    captureCatalogue(): Promise<StudioCardNativeCatalogue>
    revalidateCatalogue(capture: StudioCardNativeCatalogue): boolean
    captureSource(cardId: string): Promise<StudioCardNativeSource | null>
    revalidateSource(capture: StudioCardNativeSource): boolean
    readAsset(locator: StudioCardAssetLocator): Promise<Uint8Array | null>
    captureGeneration(): string
    isGenerationCurrent(generation: string): boolean
}

export interface StudioCardResourceService {
    listStudioCards(options?: StudioCardCatalogueOptions): Promise<StudioCardCataloguePage>
    releaseStudioCardCatalogue(catalogueRevision: string): Promise<void>
    captureStudioCardSource(input: StudioCardSourceCaptureInput): Promise<StudioCardSourceCapture>
    releaseStudioCardTarget(targetRevision: string): Promise<void>
    listStudioCardAssets(options: StudioCardAssetListOptions): Promise<StudioCardAssetPage>
    resolveStudioCardAssetHandles(options: StudioCardAssetAccessOptions): Promise<StudioCardAssetAccessBatch>
    releaseStudioCardAssetAccess(accessRevision: string): Promise<void>
    releaseStudioCardSource(captureRevision: string): Promise<void>
    dispose(): void
}

interface StudioCardResourceInput {
    context: PluginExecutionContext
    adapter: StudioCardResourceAdapter
    assetAuthorityRegistry: ContextAssetAuthorityRegistry
    readCoordinator: ContextAssetReadCoordinator
    permissionGeneration(): string
    requirePermission(): Promise<void>
    cursorRegistry?: CursorRegistry
    now?: () => number
}

const TTL = 300_000
const TARGET_TTL = 1_800_000
const MAX_RECORDS = 4
const MAX_CATALOGUE_BYTES = 4 * 1024 * 1024
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
const MAX_CAPTURE_ITEMS = 20_000
const MAX_MEMBER_COUNT = 100
const MAX_STRING_BYTES = 524_288
const MAX_OPAQUE_BYTES = 512
const MAX_MEDIA_TYPES = 100
const STUDIO_CARD_RPC_TRANSPORT = Object.freeze({ kind: 'studio-card-rpc-transport' as const })
const CATALOGUE_CURSOR_SERVICE = 'studio-card-catalogue'
const ASSET_CURSOR_SERVICE = 'studio-card-assets'
const textEncoder = new TextEncoder()
const roles = new Set<ContextAssetRole>(['portrait', 'emotion', 'additional', 'module'])
const mediaTypePattern = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[^\u0000-\u001f\u007f]*)?$/

const abortError = () => new PluginApiError('ABORTED', 'Studio card operation was cancelled')
const notFound = (name: string) => new PluginApiError('NOT_FOUND', `${name} was not found or expired`)
const invalid = (message: string) => new PluginApiError('INVALID_ARGUMENT', message)
const malformed = (message: string) => new PluginApiError('CONFLICT', message)
const limitError = (message: string) => new PluginApiError('RESOURCE_LIMIT', message, { retryable: true })

type DataValues = Record<string, unknown>

const boundary = <T>(kind: 'public' | 'native', parse: () => T): T => {
    try {
        return parse()
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        throw kind === 'public'
            ? invalid('Invalid Studio card input')
            : malformed('Native Studio card data is malformed')
    }
}

const exactObject = (
    value: unknown,
    required: readonly string[],
    optional: readonly string[],
    kind: 'public' | 'native',
    name: string,
): DataValues => boundary(kind, () => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw kind === 'public' ? invalid(`${name} must be an object`) : malformed(`Native ${name} is invalid`)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw kind === 'public' ? invalid(`${name} must be a plain object`) : malformed(`Native ${name} is invalid`)
    }
    const allowed = new Set([...required, ...optional])
    const result: DataValues = Object.create(null) as DataValues
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
        throw kind === 'public' ? invalid(`${name} has unexpected fields`) : malformed(`Native ${name} is invalid`)
    }
    for (const key of required) {
        if (!keys.includes(key)) {
            throw kind === 'public' ? invalid(`${name} is missing ${key}`) : malformed(`Native ${name} is invalid`)
        }
    }
    for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw kind === 'public' ? invalid(`${name} fields must be own data`) : malformed(`Native ${name} is invalid`)
        }
        result[key] = descriptor.value
    }
    return result
})

const denseArray = (value: unknown, kind: 'public' | 'native', name: string): unknown[] => boundary(kind, () => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw kind === 'public' ? invalid(`${name} must be an array`) : malformed(`Native ${name} is invalid`)
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw kind === 'public' ? invalid(`${name} must be a dense array`) : malformed(`Native ${name} is invalid`)
    }
    const length = lengthDescriptor.value as number
    const keys = Reflect.ownKeys(value)
    if (keys.length !== length + 1 || keys.some((key) => {
        if (key === 'length') return false
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) return true
        const index = Number(key)
        return !Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key
    })) {
        throw kind === 'public' ? invalid(`${name} must be a dense array`) : malformed(`Native ${name} is invalid`)
    }
    const result: unknown[] = []
    for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw kind === 'public' ? invalid(`${name} must contain own data`) : malformed(`Native ${name} is invalid`)
        }
        result.push(descriptor.value)
    }
    return result
})

const boundedString = (
    value: unknown,
    kind: 'public' | 'native',
    name: string,
    options: { allowEmpty?: boolean; maxBytes?: number } = {},
) => {
    if (typeof value !== 'string' || (!options.allowEmpty && value.length === 0)
        || textEncoder.encode(value).byteLength > (options.maxBytes ?? MAX_STRING_BYTES)) {
        throw kind === 'public' ? invalid(`${name} is invalid`) : malformed(`Native ${name} is invalid`)
    }
    return value
}

const opaqueString = (value: unknown, kind: 'public' | 'native', name: string) =>
    boundedString(value, kind, name, { maxBytes: MAX_OPAQUE_BYTES })

const mediaType = (value: unknown, kind: 'public' | 'native', name: string) => {
    const result = boundedString(value, kind, name, { maxBytes: 256 })
    if (!mediaTypePattern.test(result)) {
        throw kind === 'public' ? invalid(`${name} is invalid`) : malformed(`Native ${name} is invalid`)
    }
    return result
}

const abortSignal = (value: unknown) => {
    if (value === undefined) return undefined
    if (typeof AbortSignal === 'undefined' || !(value instanceof AbortSignal)) {
        throw invalid('signal must be an AbortSignal')
    }
    return value
}

const normalizeLimit = (value: unknown, fallback: number, maximum = 100) => {
    const result = value ?? fallback
    if (!Number.isInteger(result) || (result as number) < 1 || (result as number) > maximum) {
        throw invalid(`limit must be an integer from 1 through ${maximum}`)
    }
    return result as number
}

const normalizeCatalogueOptions = (value: unknown): StudioCardCatalogueOptions => boundary('public', () => {
    const input = exactObject(value === undefined ? {} : value, [], [
        'search', 'kind', 'cursor', 'limit', 'catalogueRevision', 'signal',
    ], 'public', 'Studio card catalogue options')
    const search = input.search === undefined
        ? ''
        : boundedString(
            boundedString(input.search, 'public', 'search', {
                allowEmpty: true,
                maxBytes: 256,
            }).normalize('NFKC'),
            'public',
            'search',
            { allowEmpty: true, maxBytes: 256 },
        )
    const kind = input.kind ?? 'all'
    if (kind !== 'all' && kind !== 'character' && kind !== 'group') throw invalid('Invalid Studio card kind')
    const cursor = input.cursor === undefined ? undefined : opaqueString(input.cursor, 'public', 'cursor')
    const catalogueRevision = input.catalogueRevision === undefined
        ? undefined
        : opaqueString(input.catalogueRevision, 'public', 'catalogueRevision')
    if ((cursor === undefined) !== (catalogueRevision === undefined)) {
        throw invalid('cursor and catalogueRevision must be supplied together')
    }
    return {
        search,
        kind,
        limit: normalizeLimit(input.limit, 24, 100),
        ...(cursor ? { cursor } : {}),
        ...(catalogueRevision ? { catalogueRevision } : {}),
        ...(input.signal === undefined ? {} : { signal: abortSignal(input.signal) }),
    }
})

const normalizeCaptureInput = (value: unknown): StudioCardSourceCaptureInput => boundary('public', () => {
    const probe = exactObject(value, [], [
        'cardId', 'expectedCatalogueItemRevision', 'catalogueRevision',
        'targetRevision', 'expectedSourceRevision', 'acceptCurrentSourceRevision', 'signal',
    ], 'public', 'Studio card capture input')
    const signal = probe.signal === undefined ? undefined : abortSignal(probe.signal)
    if (probe.cardId !== undefined) {
        const exact = exactObject(value, [
            'cardId', 'expectedCatalogueItemRevision', 'catalogueRevision',
        ], ['signal'], 'public', 'Studio card selection capture input')
        return {
            cardId: opaqueString(exact.cardId, 'public', 'cardId'),
            expectedCatalogueItemRevision: opaqueString(
                exact.expectedCatalogueItemRevision, 'public', 'expectedCatalogueItemRevision',
            ),
            catalogueRevision: opaqueString(exact.catalogueRevision, 'public', 'catalogueRevision'),
            ...(signal ? { signal } : {}),
        }
    }
    if (probe.expectedSourceRevision !== undefined) {
        const exact = exactObject(value, ['targetRevision', 'expectedSourceRevision'], ['signal'], 'public', 'Studio card recapture input')
        return {
            targetRevision: opaqueString(exact.targetRevision, 'public', 'targetRevision'),
            expectedSourceRevision: opaqueString(exact.expectedSourceRevision, 'public', 'expectedSourceRevision'),
            ...(signal ? { signal } : {}),
        }
    }
    const exact = exactObject(value, ['targetRevision', 'acceptCurrentSourceRevision'], ['signal'], 'public', 'Studio card replacement input')
    if (exact.acceptCurrentSourceRevision !== true) throw invalid('acceptCurrentSourceRevision must be true')
    return {
        targetRevision: opaqueString(exact.targetRevision, 'public', 'targetRevision'),
        acceptCurrentSourceRevision: true,
        ...(signal ? { signal } : {}),
    }
})

const normalizeAssetListOptions = (value: unknown): StudioCardAssetListOptions => boundary('public', () => {
    const input = exactObject(value, ['captureRevision'], [
        'cursor', 'limit', 'mediaTypes', 'signal',
    ], 'public', 'Studio card asset list options')
    const mediaTypes = input.mediaTypes === undefined ? undefined : denseArray(
        input.mediaTypes, 'public', 'mediaTypes',
    ).map((item) => mediaType(item, 'public', 'mediaType').toLowerCase())
    if (mediaTypes && mediaTypes.length > MAX_MEDIA_TYPES) throw invalid('Too many mediaTypes')
    return {
        captureRevision: opaqueString(input.captureRevision, 'public', 'captureRevision'),
        limit: normalizeLimit(input.limit, 100),
        ...(input.cursor === undefined ? {} : { cursor: opaqueString(input.cursor, 'public', 'cursor') }),
        ...(mediaTypes ? { mediaTypes: [...new Set(mediaTypes)] } : {}),
        ...(input.signal === undefined ? {} : { signal: abortSignal(input.signal) }),
    }
})

const normalizeAssetAccessOptions = (value: unknown): StudioCardAssetAccessOptions => boundary('public', () => {
    const input = exactObject(value, [
        'captureRevision', 'logicalAssetIds', 'purpose',
    ], ['signal'], 'public', 'Studio card asset access options')
    if (input.purpose !== 'candidate-page' && input.purpose !== 'selected') {
        throw invalid('Invalid Studio card asset access purpose')
    }
    const logicalAssetIds = denseArray(input.logicalAssetIds, 'public', 'logicalAssetIds')
        .map((item) => opaqueString(item, 'public', 'logicalAssetId'))
    const maximum = input.purpose === 'candidate-page' ? 24 : 3
    if (logicalAssetIds.length < 1 || logicalAssetIds.length > maximum) {
        throw invalid('Invalid Studio card asset access batch size')
    }
    let aggregateBytes = 0
    const seen = new Set<string>()
    for (const logicalAssetId of logicalAssetIds) {
        const bytes = textEncoder.encode(logicalAssetId).byteLength
        aggregateBytes += bytes
        if (bytes > 256 || aggregateBytes > 6_144 || seen.has(logicalAssetId)) {
            throw invalid('Invalid Studio card logical asset IDs')
        }
        seen.add(logicalAssetId)
    }
    return {
        captureRevision: opaqueString(input.captureRevision, 'public', 'captureRevision'),
        logicalAssetIds,
        purpose: input.purpose,
        ...(input.signal === undefined ? {} : { signal: abortSignal(input.signal) }),
    }
})

const normalizeReleaseRevision = (value: unknown, name: string) => boundary(
    'public', () => opaqueString(value, 'public', name),
)

const parseLocator = (value: unknown): StudioCardAssetLocator => {
    const input = exactObject(value, [
        'ownerCardId', 'ownerRevision', 'storageRevision', 'nativeSlot',
    ], [], 'native', 'Studio card asset locator')
    if (!Number.isSafeInteger(input.nativeSlot) || (input.nativeSlot as number) < 0) {
        throw malformed('Native Studio card asset locator is invalid')
    }
    return {
        ownerCardId: opaqueString(input.ownerCardId, 'native', 'locator ownerCardId'),
        ownerRevision: opaqueString(input.ownerRevision, 'native', 'locator ownerRevision'),
        storageRevision: opaqueString(input.storageRevision, 'native', 'locator storageRevision'),
        nativeSlot: input.nativeSlot as number,
    }
}

const parseTextSection = (value: unknown) => {
    const input = exactObject(value, ['key', 'label', 'content'], [], 'native', 'card text section')
    return {
        key: boundedString(input.key, 'native', 'text section key'),
        label: boundedString(input.label, 'native', 'text section label', { allowEmpty: true }),
        content: boundedString(input.content, 'native', 'text section content', { allowEmpty: true }),
    }
}

const parseLore = (value: unknown) => {
    const input = exactObject(value, ['id', 'name', 'content', 'enabled'], [], 'native', 'card lore entry')
    if (typeof input.enabled !== 'boolean') throw malformed('Native card lore enabled flag is invalid')
    return {
        id: opaqueString(input.id, 'native', 'lore id'),
        name: boundedString(input.name, 'native', 'lore name', { allowEmpty: true }),
        content: boundedString(input.content, 'native', 'lore content', { allowEmpty: true }),
        enabled: input.enabled,
    }
}

const parseCard = (value: unknown): CharacterCardSnapshot => {
    const input = exactObject(value, [
        'id', 'revision', 'type', 'name', 'textSections', 'lorebook',
    ], ['groupMemberIds'], 'native', 'card snapshot')
    if (input.type !== 'character' && input.type !== 'group') throw malformed('Native card type is invalid')
    const groupMemberIds = input.groupMemberIds === undefined ? undefined : denseArray(
        input.groupMemberIds, 'native', 'groupMemberIds',
    ).map((item) => opaqueString(item, 'native', 'group member id'))
    if (input.type === 'character' && groupMemberIds && groupMemberIds.length > 0) {
        throw malformed('Native character card has group members')
    }
    const result: CharacterCardSnapshot = {
        id: opaqueString(input.id, 'native', 'card id'),
        revision: opaqueString(input.revision, 'native', 'card revision'),
        type: input.type,
        name: boundedString(input.name, 'native', 'card name'),
        textSections: denseArray(input.textSections, 'native', 'card textSections').map(parseTextSection),
        lorebook: denseArray(input.lorebook, 'native', 'card lorebook').map(parseLore),
        ...(groupMemberIds ? { groupMemberIds } : {}),
    }
    assertContextSnapshotLimits(result)
    return result
}

const parsePortrait = (value: unknown) => {
    const input = exactObject(value, [
        'revision', 'name', 'mediaType', 'locator',
    ], [], 'native', 'Studio card portrait')
    return {
        revision: opaqueString(input.revision, 'native', 'portrait revision'),
        name: boundedString(input.name, 'native', 'portrait name'),
        mediaType: mediaType(input.mediaType, 'native', 'portrait mediaType'),
        locator: parseLocator(input.locator),
    }
}

const rawCodePointCompare = (leftValue: string, rightValue: string) => {
    const left = [...leftValue]
    const right = [...rightValue]
    const length = Math.min(left.length, right.length)
    for (let index = 0; index < length; index++) {
        const difference = left[index].codePointAt(0)! - right[index].codePointAt(0)!
        if (difference !== 0) return difference
    }
    return left.length - right.length
}

const codePointCompare = (leftValue: string, rightValue: string) =>
    rawCodePointCompare(leftValue.normalize('NFKC'), rightValue.normalize('NFKC'))
    || rawCodePointCompare(leftValue, rightValue)

const parseNativeCatalogue = (value: unknown): StudioCardNativeCatalogue => boundary('native', () => {
    const input = exactObject(value, ['nativeRevision', 'records', 'authority'], [
        'hostActiveCardId',
    ], 'native', 'Studio card catalogue')
    if (input.authority === null || typeof input.authority !== 'object' || Array.isArray(input.authority)) {
        throw malformed('Native Studio card catalogue authority is invalid')
    }
    const seen = new Set<string>()
    const records = denseArray(input.records, 'native', 'Studio card catalogue records').map((value) => {
        const record = exactObject(value, [
            'cardId', 'catalogueItemRevision', 'kind', 'name', 'groupMemberIds',
        ], ['portrait'], 'native', 'Studio card catalogue record')
        if (record.kind !== 'character' && record.kind !== 'group') throw malformed('Native Studio card kind is invalid')
        const cardId = opaqueString(record.cardId, 'native', 'catalogue card id')
        if (seen.has(cardId)) throw malformed('Native Studio catalogue has duplicate cards')
        seen.add(cardId)
        const groupMemberIds = denseArray(
            record.groupMemberIds, 'native', 'catalogue groupMemberIds',
        ).map((item) => opaqueString(item, 'native', 'catalogue group member id'))
        if (record.kind === 'character' && groupMemberIds.length > 0) {
            throw malformed('Native character catalogue row has group members')
        }
        const portrait = record.portrait === undefined ? undefined : parsePortrait(record.portrait)
        if (portrait && portrait.locator.ownerCardId !== cardId) {
            throw malformed('Native Studio portrait owner is invalid')
        }
        return {
            cardId,
            catalogueItemRevision: opaqueString(
                record.catalogueItemRevision, 'native', 'catalogue item revision',
            ),
            kind: record.kind,
            name: boundedString(record.name, 'native', 'catalogue card name'),
            groupMemberIds: [...new Set(groupMemberIds)].sort(codePointCompare),
            ...(portrait ? { portrait } : {}),
        } satisfies StudioCardNativeRecord
    })
    const hostActiveCardId = input.hostActiveCardId === undefined
        ? undefined
        : opaqueString(input.hostActiveCardId, 'native', 'host active card id')
    if (hostActiveCardId && !seen.has(hostActiveCardId)) {
        throw malformed('Native Host-active card is absent from the Studio catalogue')
    }
    return {
        nativeRevision: opaqueString(input.nativeRevision, 'native', 'catalogue native revision'),
        ...(hostActiveCardId ? { hostActiveCardId } : {}),
        records,
        authority: input.authority,
    }
})

interface NativeSourceEnvelope {
    nativeRevision: string
    card: unknown
    groupMembers: unknown[]
    assets: unknown[]
    authority: object
}

const parseNativeSourceEnvelope = (value: unknown): NativeSourceEnvelope => boundary('native', () => {
    const input = exactObject(value, [
        'nativeRevision', 'card', 'groupMembers', 'assets', 'authority',
    ], [], 'native', 'Studio card source')
    if (input.authority === null || typeof input.authority !== 'object' || Array.isArray(input.authority)) {
        throw malformed('Native Studio card source authority is invalid')
    }
    return {
        nativeRevision: opaqueString(input.nativeRevision, 'native', 'source native revision'),
        card: input.card,
        groupMembers: denseArray(input.groupMembers, 'native', 'source groupMembers'),
        assets: denseArray(input.assets, 'native', 'source assets'),
        authority: input.authority,
    }
})

const parseNativeSource = (envelope: NativeSourceEnvelope): StudioCardNativeSource => boundary('native', () => ({
    nativeRevision: envelope.nativeRevision,
    card: parseCard(envelope.card),
    groupMembers: envelope.groupMembers.map(parseCard),
    assets: envelope.assets.map((value) => {
        const input = exactObject(value, [
            'logicalIdentity', 'revision', 'name', 'mediaType', 'role', 'locator',
        ], [], 'native', 'Studio card source asset')
        if (!roles.has(input.role as ContextAssetRole)) throw malformed('Native Studio card asset role is invalid')
        return {
            logicalIdentity: opaqueString(input.logicalIdentity, 'native', 'logical asset identity'),
            revision: opaqueString(input.revision, 'native', 'asset revision'),
            name: boundedString(input.name, 'native', 'asset name'),
            mediaType: mediaType(input.mediaType, 'native', 'asset mediaType'),
            role: input.role as ContextAssetRole,
            locator: parseLocator(input.locator),
        }
    }),
    authority: envelope.authority,
}))

const cloneCard = (card: CharacterCardSnapshot): CharacterCardSnapshot => ({
    id: card.id,
    revision: card.revision,
    type: card.type,
    name: card.name,
    textSections: card.textSections.map((section) => ({ ...section })),
    lorebook: card.lorebook.map((entry) => ({ ...entry })),
    ...(card.groupMemberIds ? { groupMemberIds: [...card.groupMemberIds] } : {}),
})

const randomRevision = (domain: string, context: PluginExecutionContext) => createRevision({
    version: 1,
    domain,
    principalId: context.principalId,
    instanceId: context.instanceId,
    nonce: crypto.randomUUID(),
})

interface CataloguePageRecord {
    handles: Set<string>
    cardIds: Set<string>
}

interface CatalogueRecord {
    revision: string
    native: StudioCardNativeCatalogue
    generation: string
    permission: string
    records: StudioCardNativeRecord[]
    byId: Map<string, StudioCardNativeRecord>
    filtered: StudioCardNativeRecord[]
    search: string
    kind: 'all' | StudioCardKind
    pages: Map<string, CataloguePageRecord>
    retainedPages: string[]
    activeHandles: Set<string>
    metadataBytes: number
    lastUsed: number
    expiresAt: number
}

interface CursorRecord {
    kind: 'catalogue' | 'assets'
    parentRevision: string
    offset: number
    query: string
    expiresAt: number
}

interface AssetRecord {
    descriptor: StudioCardLogicalAssetDescriptor
    identity: string
    locator: StudioCardAssetLocator
}

interface TargetRecord {
    revision: string
    cardId: string
    itemRevision: string
    sourceRevision: string
    permission: string
    captures: Set<string>
    lastUsed: number
    expiresAt: number
}

interface CaptureRecord {
    revision: string
    targetRevision: string
    target: TargetRecord
    sourceRevision: string
    permission: string
    native: StudioCardNativeSource
    card: CharacterCardSnapshot
    members: CharacterCardSnapshot[]
    assets: AssetRecord[]
    assetById: Map<string, AssetRecord>
    accesses: Set<string>
    candidateAccesses: string[]
    selectedAccess?: string
    metadataBytes: number
    itemCount: number
    pinOwner: 'adopted-capture'
    lastUsed: number
    expiresAt: number
}

interface AccessRecord {
    revision: string
    captureRevision: string
    capture: CaptureRecord
    purpose: 'candidate-page' | 'selected'
    permission: string
    handles: string[]
    lastUsed: number
    expiresAt: number
}

interface CapacityReservation {
    kind: 'catalogue' | 'capture'
    service: StudioCardResourceServiceImpl
    metadataBytes: number
    itemCount: number
    wantsTarget: boolean
    catalogue?: CatalogueRecord
    target?: TargetRecord
    pinOwner: 'provisional-capture' | 'catalogue-capture'
    catalogueVictims: Array<{
        service: StudioCardResourceServiceImpl
        revision: string
        record: CatalogueRecord
    }>
    targetVictims: Array<{
        service: StudioCardResourceServiceImpl
        revision: string
        record: TargetRecord
    }>
}

interface MaterializedSource {
    root: CharacterCardSnapshot
    members: CharacterCardSnapshot[]
    assets: AssetRecord[]
    sourceRevision: string
    metadataBytes: number
    itemCount: number
}

class StudioCardResourceServiceImpl implements StudioCardResourceService {
    private static readonly live = new Set<StudioCardResourceServiceImpl>()
    private readonly catalogues = new Map<string, CatalogueRecord>()
    private readonly cursors = new Map<string, CursorRecord>()
    private readonly targets = new Map<string, TargetRecord>()
    private readonly captures = new Map<string, CaptureRecord>()
    private readonly accesses = new Map<string, AccessRecord>()
    private readonly reservations = new Set<CapacityReservation>()
    private readonly cursorRegistry: CursorRegistry
    private disposed = false
    private serviceGeneration = 0
    private readonly abort = () => this.dispose()

    constructor(private readonly input: StudioCardResourceInput) {
        this.cursorRegistry = input.cursorRegistry ?? illustrationCursorRegistry
        StudioCardResourceServiceImpl.live.add(this)
        input.context.signal.addEventListener('abort', this.abort, { once: true })
        if (input.context.signal.aborted) this.dispose()
    }

    private now() {
        return (this.input.now ?? Date.now)()
    }

    private owner() {
        return {
            principalId: this.input.context.principalId,
            instanceId: this.input.context.instanceId,
        }
    }

    private clearCursor(cursor: string) {
        this.cursorRegistry.clear(cursor)
        this.cursors.delete(cursor)
    }

    private clearInstanceCursors() {
        this.cursorRegistry.clearInstance(
            this.input.context.principalId,
            this.input.context.instanceId,
        )
        this.cursors.clear()
    }

    private assertActive(generation: number, signal?: AbortSignal) {
        if (this.disposed || generation !== this.serviceGeneration
            || this.input.context.signal.aborted || signal?.aborted) throw abortError()
    }

    private assertPermission(generation: number, permission: string, signal?: AbortSignal) {
        this.assertActive(generation, signal)
        if (permission !== this.input.permissionGeneration()) {
            this.invalidate()
            throw abortError()
        }
    }

    private async authorize(generation: number, signal?: AbortSignal) {
        this.assertActive(generation, signal)
        const permission = this.input.permissionGeneration()
        await this.input.requirePermission()
        this.assertPermission(generation, permission, signal)
        return permission
    }

    private adapterGeneration() {
        try {
            return opaqueString(this.input.adapter.captureGeneration(), 'native', 'adapter generation')
        } catch (error) {
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Native Studio adapter generation failed')
        }
    }

    private generationIsCurrent(generation: string) {
        try {
            return this.input.adapter.isGenerationCurrent(generation) === true
        } catch (error) {
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Native Studio adapter generation check failed')
        }
    }

    private catalogueRevalidates(native: StudioCardNativeCatalogue) {
        try {
            return this.input.adapter.revalidateCatalogue(native) === true
        } catch (error) {
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Native Studio catalogue revalidation failed')
        }
    }

    private sourceRevalidates(native: StudioCardNativeSource) {
        try {
            return this.input.adapter.revalidateSource(native) === true
        } catch (error) {
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Native Studio source revalidation failed')
        }
    }

    private async captureNativeCatalogue() {
        try {
            return await this.input.adapter.captureCatalogue()
        } catch (error) {
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Native Studio catalogue capture failed')
        }
    }

    private async captureNativeSource(cardId: string) {
        try {
            return await this.input.adapter.captureSource(cardId)
        } catch (error) {
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Native Studio source capture failed')
        }
    }

    private async readNativeAsset(locator: StudioCardAssetLocator) {
        try {
            const value = await this.input.adapter.readAsset(locator)
            if (value !== null && !(value instanceof Uint8Array)) {
                throw malformed('Native Studio asset bytes are invalid')
            }
            return value
        } catch (error) {
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Native Studio asset read failed')
        }
    }

    private invalidate() {
        if (this.disposed) return
        this.serviceGeneration += 1
        for (const revision of [...this.catalogues.keys()]) this.revokeCatalogue(revision)
        for (const revision of [...this.targets.keys()]) this.revokeTarget(revision)
        this.clearInstanceCursors()
        this.reservations.clear()
        this.input.readCoordinator.cancelInstance?.(this.owner())
    }

    private peers() {
        return [...StudioCardResourceServiceImpl.live].filter((service) =>
            !service.disposed
            && service.input.context.principalId === this.input.context.principalId)
    }

    private cleanup() {
        const now = this.now()
        for (const [revision, cursor] of this.cursors) {
            if (cursor.expiresAt <= now) this.clearCursor(revision)
        }
        for (const [revision, access] of this.accesses) {
            if (access.expiresAt <= now) this.revokeAccess(revision)
        }
        for (const [revision, capture] of this.captures) {
            if (capture.expiresAt <= now) this.revokeCapture(revision)
        }
        for (const [revision, target] of this.targets) {
            if (target.expiresAt <= now) this.revokeTarget(revision)
        }
        for (const [revision, catalogue] of this.catalogues) {
            if (catalogue.expiresAt <= now) this.revokeCatalogue(revision)
        }
    }

    private cleanupPeers() {
        for (const peer of this.peers()) peer.cleanup()
    }

    private touchCatalogue(record: CatalogueRecord) {
        const now = this.now()
        record.lastUsed = now
        record.expiresAt = now + TTL
    }

    private touchTarget(record: TargetRecord) {
        const now = this.now()
        record.lastUsed = now
        record.expiresAt = now + TARGET_TTL
    }

    private touchCapture(record: CaptureRecord) {
        const now = this.now()
        record.lastUsed = now
        record.expiresAt = now + TTL
        if (this.targets.get(record.targetRevision) === record.target) this.touchTarget(record.target)
    }

    private touchAccess(record: AccessRecord) {
        const now = this.now()
        record.lastUsed = now
        record.expiresAt = now + TTL
        if (this.captures.get(record.captureRevision) === record.capture) this.touchCapture(record.capture)
    }

    private peekCatalogue(revision: string) {
        this.cleanup()
        const record = this.catalogues.get(revision)
        if (!record) throw notFound('Studio card catalogue')
        return record
    }

    private peekTarget(revision: string) {
        this.cleanup()
        const record = this.targets.get(revision)
        if (!record) throw notFound('Studio card target')
        return record
    }

    private peekCapture(revision: string) {
        this.cleanup()
        const record = this.captures.get(revision)
        if (!record) throw notFound('Studio card capture')
        return record
    }

    private peekAccess(revision: string) {
        this.cleanup()
        const record = this.accesses.get(revision)
        if (!record) throw notFound('Studio card access')
        return record
    }

    private assertCatalogueCurrent(
        record: CatalogueRecord,
        generation: number,
        permission: string,
        signal?: AbortSignal,
    ) {
        this.assertPermission(generation, permission, signal)
        this.cleanup()
        if (record.permission !== permission) {
            this.invalidate()
            throw abortError()
        }
        if (this.catalogues.get(record.revision) !== record) {
            throw notFound('Studio card catalogue')
        }
        if (!this.generationIsCurrent(record.generation)
            || !this.catalogueRevalidates(record.native)) {
            throw new PluginApiError('CONFLICT', 'Studio card catalogue changed')
        }
        this.assertPermission(generation, permission, signal)
        if (this.catalogues.get(record.revision) !== record) throw notFound('Studio card catalogue')
    }

    private assertUnpublishedCatalogueCurrent(
        record: CatalogueRecord,
        generation: number,
        permission: string,
        signal?: AbortSignal,
    ) {
        this.assertPermission(generation, permission, signal)
        if (record.expiresAt <= this.now()) throw notFound('Studio card catalogue')
        if (record.permission !== permission) {
            this.invalidate()
            throw abortError()
        }
        if (!this.generationIsCurrent(record.generation)
            || !this.catalogueRevalidates(record.native)) {
            throw new PluginApiError('CONFLICT', 'Studio card catalogue changed')
        }
        this.assertPermission(generation, permission, signal)
    }

    private assertTargetCurrent(
        record: TargetRecord,
        generation: number,
        permission: string,
        signal?: AbortSignal,
    ) {
        this.assertPermission(generation, permission, signal)
        this.cleanup()
        if (record.permission !== permission) {
            this.invalidate()
            throw abortError()
        }
        if (this.targets.get(record.revision) !== record) {
            throw notFound('Studio card target')
        }
        this.assertPermission(generation, permission, signal)
        if (this.targets.get(record.revision) !== record) throw notFound('Studio card target')
    }

    private assertCaptureCurrent(
        record: CaptureRecord,
        generation: number,
        permission: string,
        signal?: AbortSignal,
    ) {
        this.assertPermission(generation, permission, signal)
        this.cleanup()
        if (record.permission !== permission || record.target.permission !== permission) {
            this.invalidate()
            throw abortError()
        }
        if (this.captures.get(record.revision) !== record
            || this.targets.get(record.targetRevision) !== record.target
            || !record.target.captures.has(record.revision)) {
            throw notFound('Studio card capture')
        }
        if (!this.sourceRevalidates(record.native)) {
            throw new PluginApiError('CONFLICT', 'Studio card source changed')
        }
        this.assertPermission(generation, permission, signal)
        if (this.captures.get(record.revision) !== record
            || this.targets.get(record.targetRevision) !== record.target
            || !record.target.captures.has(record.revision)) {
            throw notFound('Studio card capture')
        }
    }

    private assertAccessCurrent(
        record: AccessRecord,
        generation: number,
        permission: string,
        signal?: AbortSignal,
    ) {
        this.assertPermission(generation, permission, signal)
        this.cleanup()
        if (record.permission !== permission) {
            this.invalidate()
            throw abortError()
        }
        if (this.accesses.get(record.revision) !== record
            || this.captures.get(record.captureRevision) !== record.capture
            || !record.capture.accesses.has(record.revision)) {
            throw notFound('Studio card asset access')
        }
        this.assertCaptureCurrent(record.capture, generation, permission, signal)
    }

    private cataloguePinned(record: CatalogueRecord) {
        return this.peers().some((service) => [...service.reservations].some((reservation) =>
            reservation.catalogue === record
            || reservation.catalogueVictims.some((victim) => victim.record === record)))
    }

    private targetPinned(record: TargetRecord) {
        if (record.captures.size > 0) return true
        return this.peers().some((service) => [...service.reservations].some((reservation) =>
            reservation.target === record
            || reservation.targetVictims.some((victim) => victim.record === record)))
    }

    private catalogueEntries() {
        return this.peers().flatMap((service) => [...service.catalogues].map(([revision, record]) => ({
            service,
            revision,
            record,
        })))
    }

    private targetEntries() {
        return this.peers().flatMap((service) => [...service.targets].map(([revision, record]) => ({
            service,
            revision,
            record,
        })))
    }

    private captureEntries() {
        return this.peers().flatMap((service) => [...service.captures].map(([revision, record]) => ({
            service,
            revision,
            record,
        })))
    }

    private reservationEntries(kind: CapacityReservation['kind']) {
        return this.peers().flatMap((service) => [...service.reservations])
            .filter((reservation) => reservation.kind === kind)
    }

    private reserveCatalogueVictim(reservation: CapacityReservation, excluded?: CatalogueRecord) {
        const candidate = this.catalogueEntries()
            .filter(({ record }) => record !== excluded && !this.cataloguePinned(record))
            .sort((left, right) => left.record.lastUsed - right.record.lastUsed
                || codePointCompare(left.revision, right.revision))[0]
        if (!candidate) throw limitError('All retained Studio card catalogues are pinned')
        reservation.catalogueVictims.push(candidate)
    }

    private reserveTargetVictim(reservation: CapacityReservation, excluded?: TargetRecord) {
        const candidate = this.targetEntries()
            .filter(({ record }) => record !== excluded && !this.targetPinned(record))
            .sort((left, right) => left.record.lastUsed - right.record.lastUsed
                || codePointCompare(left.revision, right.revision))[0]
        if (!candidate) throw limitError('All retained Studio card targets are pinned')
        reservation.targetVictims.push(candidate)
    }

    private catalogueVictims() {
        return new Set(this.peers().flatMap((service) => [...service.reservations])
            .flatMap((reservation) => reservation.catalogueVictims)
            .filter(({ service, revision, record }) => service.catalogues.get(revision) === record)
            .map(({ record }) => record))
    }

    private targetVictims() {
        return new Set(this.peers().flatMap((service) => [...service.reservations])
            .flatMap((reservation) => reservation.targetVictims)
            .filter(({ service, revision, record }) => service.targets.get(revision) === record)
            .map(({ record }) => record))
    }

    private effectiveCatalogueEntries() {
        const victims = this.catalogueVictims()
        return this.catalogueEntries().filter(({ record }) => !victims.has(record))
    }

    private effectiveTargetEntries() {
        const victims = this.targetVictims()
        return this.targetEntries().filter(({ record }) => !victims.has(record))
    }

    private reserveCatalogue() {
        this.cleanupPeers()
        const reservation: CapacityReservation = {
            kind: 'catalogue',
            service: this,
            metadataBytes: 0,
            itemCount: 0,
            wantsTarget: false,
            pinOwner: 'catalogue-capture',
            catalogueVictims: [],
            targetVictims: [],
        }
        this.reservations.add(reservation)
        try {
            while (this.effectiveCatalogueEntries().length
                + this.reservationEntries('catalogue').length > MAX_RECORDS) {
                this.reserveCatalogueVictim(reservation)
            }
            return reservation
        } catch (error) {
            this.reservations.delete(reservation)
            throw error
        }
    }

    private adjustCatalogueReservation(reservation: CapacityReservation, metadataBytes: number) {
        reservation.metadataBytes = metadataBytes
        while (this.effectiveCatalogueEntries().reduce((sum, item) => sum + item.record.metadataBytes, 0)
            + this.reservationEntries('catalogue').reduce((sum, item) => sum + item.metadataBytes, 0)
            > MAX_CATALOGUE_BYTES) {
            this.reserveCatalogueVictim(reservation)
        }
    }

    private reserveCapture(input: {
        catalogue?: CatalogueRecord
        target?: TargetRecord
        wantsTarget: boolean
    }) {
        this.cleanupPeers()
        if (input.catalogue && this.catalogueVictims().has(input.catalogue)) {
            throw limitError('Studio card catalogue is pending retirement')
        }
        if (input.target && this.targetVictims().has(input.target)) {
            throw limitError('Studio card target is pending retirement')
        }
        const reservation: CapacityReservation = {
            kind: 'capture',
            service: this,
            metadataBytes: 0,
            itemCount: 0,
            wantsTarget: input.wantsTarget,
            catalogue: input.catalogue,
            target: input.target,
            pinOwner: 'provisional-capture',
            catalogueVictims: [],
            targetVictims: [],
        }
        this.reservations.add(reservation)
        try {
            if (this.captureEntries().length + this.reservationEntries('capture').length > MAX_RECORDS) {
                throw limitError('All retained Studio card captures are pinned')
            }
            if (input.wantsTarget) {
                while (this.effectiveTargetEntries().length
                    + this.reservationEntries('capture').filter((item) => item.wantsTarget).length > MAX_RECORDS) {
                    this.reserveTargetVictim(reservation, input.target)
                }
            }
            return reservation
        } catch (error) {
            this.reservations.delete(reservation)
            throw error
        }
    }

    private adjustCaptureReservation(
        reservation: CapacityReservation,
        metadataBytes: number,
        itemCount: number,
    ) {
        reservation.metadataBytes = metadataBytes
        reservation.itemCount = itemCount
        const captureBytes = this.captureEntries().reduce((sum, item) => sum + item.record.metadataBytes, 0)
            + this.reservationEntries('capture').reduce((sum, item) => sum + item.metadataBytes, 0)
        const captureItems = this.captureEntries().reduce((sum, item) => sum + item.record.itemCount, 0)
            + this.reservationEntries('capture').reduce((sum, item) => sum + item.itemCount, 0)
        if (captureBytes > MAX_CAPTURE_BYTES || captureItems > MAX_CAPTURE_ITEMS) {
            throw limitError('Studio card capture aggregate limit exceeded')
        }
    }

    private releaseReservation(reservation: CapacityReservation) {
        reservation.service.reservations.delete(reservation)
    }

    private validateCatalogueReservation(reservation: CapacityReservation) {
        const liveVictims = reservation.catalogueVictims.filter(
            ({ service, revision, record }) => service.catalogues.get(revision) === record,
        )
        if (liveVictims.some(({ record }) => this.peers().some((service) =>
            [...service.reservations].some((candidate) => candidate !== reservation
                && candidate.catalogue === record)))) {
            throw limitError('A retained Studio card catalogue became pinned during admission')
        }
    }

    private commitCatalogueReservation(reservation: CapacityReservation) {
        const liveVictims = reservation.catalogueVictims.filter(
            ({ service, revision, record }) => service.catalogues.get(revision) === record,
        )
        for (const { service, revision, record } of liveVictims) {
            if (service.catalogues.get(revision) === record) service.revokeCatalogue(revision)
        }
    }

    private validateTargetReservation(reservation: CapacityReservation) {
        const liveVictims = reservation.targetVictims.filter(
            ({ service, revision, record }) => service.targets.get(revision) === record,
        )
        if (liveVictims.some(({ record }) => record.captures.size > 0
            || this.peers().some((service) => [...service.reservations].some((candidate) =>
                candidate !== reservation && candidate.target === record)))) {
            throw limitError('A retained Studio card target became pinned during admission')
        }
    }

    private commitTargetReservation(reservation: CapacityReservation) {
        const liveVictims = reservation.targetVictims.filter(
            ({ service, revision, record }) => service.targets.get(revision) === record,
        )
        for (const { service, revision, record } of liveVictims) {
            if (service.targets.get(revision) === record) service.revokeTarget(revision)
        }
    }

    private async assetHandle(parentRevision: string, identity: string) {
        const revision = await createRevision({
            version: 1,
            domain: 'studio-card-asset-handle.v1',
            ...this.owner(),
            parentRevision,
            identity,
        })
        return `ctxasset_${revision.slice('sha256:'.length)}`
    }

    private makePortraitAuthority(
        catalogue: CatalogueRecord,
        page: CataloguePageRecord | undefined,
        parentRevision: string,
        native: StudioCardNativeRecord,
        assetId: string,
    ): StudioContextAssetAuthority {
        const portrait = native.portrait!
        const locator = { ...portrait.locator }
        return {
            ...this.owner(),
            assetId,
            parentRevision,
            authorityKind: 'studio-catalogue-portrait',
            revision: portrait.revision,
            name: portrait.name,
            mediaType: portrait.mediaType,
            validate: async (signal?: AbortSignal) => {
                const generation = this.serviceGeneration
                const permission = await this.authorize(generation, signal)
                this.assertCatalogueCurrent(catalogue, generation, permission, signal)
                const retained = page
                    ? catalogue.pages.get(parentRevision) === page
                    : catalogue.activeHandles.has(assetId)
                if (!retained) throw notFound('Studio catalogue portrait')
            },
            read: async () => this.readNativeAsset(locator),
            touch: () => {
                if (this.catalogues.get(catalogue.revision) === catalogue) this.touchCatalogue(catalogue)
            },
        }
    }

    private async summary(
        catalogue: CatalogueRecord,
        native: StudioCardNativeRecord,
        parentRevision: string,
        page?: CataloguePageRecord,
    ): Promise<{ summary: StudioCardSummary; authority?: StudioContextAssetAuthority }> {
        let portrait: StudioCardPortraitDescriptor | undefined
        let authority: StudioContextAssetAuthority | undefined
        if (native.portrait) {
            const assetId = await this.assetHandle(
                parentRevision,
                `${native.cardId}:${native.portrait.revision}:${native.portrait.locator.nativeSlot}`,
            )
            portrait = {
                assetId,
                revision: native.portrait.revision,
                name: native.portrait.name,
                mediaType: native.portrait.mediaType,
            }
            authority = this.makePortraitAuthority(catalogue, page, parentRevision, native, assetId)
        }
        return {
            summary: {
                cardId: native.cardId,
                catalogueItemRevision: native.catalogueItemRevision,
                kind: native.kind,
                name: native.name,
                groupMemberCount: native.kind === 'group' ? new Set(native.groupMemberIds).size : 0,
                ...(portrait ? { portrait } : {}),
            },
            ...(authority ? { authority } : {}),
        }
    }

    async listStudioCards(
        optionsValue: StudioCardCatalogueOptions = {},
        transport?: typeof STUDIO_CARD_RPC_TRANSPORT,
    ): Promise<StudioCardCataloguePage> {
        const options = normalizeCatalogueOptions(optionsValue)
        const generation = this.serviceGeneration
        const signal = options.signal
        const permission = await this.authorize(generation, signal)
        let catalogue: CatalogueRecord
        let offset = 0
        let consumedCursor: [string, CursorRecord] | undefined
        let reservation: CapacityReservation | undefined
        let unpublished = false
        let finalizerPending = false
        try {
            if (options.cursor && options.catalogueRevision) {
                catalogue = this.peekCatalogue(options.catalogueRevision)
                this.assertCatalogueCurrent(catalogue, generation, permission, signal)
                const cursorQuery = {
                    parentRevision: catalogue.revision,
                    search: options.search ?? '',
                    kind: options.kind ?? 'all',
                }
                let cursor: CursorRecord
                try {
                    cursor = await this.cursorRegistry.read<CursorRecord>(
                        options.cursor,
                        this.input.context.principalId,
                        CATALOGUE_CURSOR_SERVICE,
                        this.input.context.instanceId,
                        cursorQuery,
                    )
                } catch (error) {
                    this.assertPermission(generation, permission, signal)
                    if (this.catalogues.get(catalogue.revision) !== catalogue) {
                        throw notFound('Studio card catalogue')
                    }
                    throw error
                }
                this.assertCatalogueCurrent(catalogue, generation, permission, signal)
                if (this.cursors.get(options.cursor) !== cursor || cursor.kind !== 'catalogue'
                    || cursor.parentRevision !== catalogue.revision
                    || cursor.expiresAt <= this.now()
                    || cursor.query !== JSON.stringify([options.search, options.kind])) {
                    throw invalid('Invalid or expired Studio card cursor')
                }
                offset = cursor.offset
                consumedCursor = [options.cursor, cursor]
            } else {
                reservation = this.reserveCatalogue()
                const adapterGeneration = this.adapterGeneration()
                const nativeValue = await this.captureNativeCatalogue()
                this.assertPermission(generation, permission, signal)
                const native = parseNativeCatalogue(nativeValue)
                if (!this.generationIsCurrent(adapterGeneration)
                    || !this.catalogueRevalidates(native)) {
                    throw new PluginApiError('CONFLICT', 'Studio card catalogue changed during capture')
                }
                const canonical = validateJsonLimits(native.records, {
                    maxDepth: 16,
                    maxBytes: MAX_CATALOGUE_BYTES,
                })
                const metadataBytes = textEncoder.encode(canonical).byteLength
                this.adjustCatalogueReservation(reservation, metadataBytes)
                const search = options.search ?? ''
                const kind = options.kind ?? 'all'
                const foldedSearch = search.toLowerCase()
                const filtered = native.records.filter((item) =>
                    (kind === 'all' || item.kind === kind)
                    && item.name.normalize('NFKC').toLowerCase().includes(foldedSearch))
                    .sort((left, right) => codePointCompare(left.name, right.name)
                        || codePointCompare(left.cardId, right.cardId))
                const revision = await randomRevision('studio-card-catalogue.v1', this.input.context)
                this.assertPermission(generation, permission, signal)
                if (!this.generationIsCurrent(adapterGeneration)
                    || !this.catalogueRevalidates(native)) {
                    throw new PluginApiError('CONFLICT', 'Studio card catalogue changed during capture')
                }
                const now = this.now()
                catalogue = {
                    revision,
                    native,
                    generation: adapterGeneration,
                    permission,
                    records: native.records,
                    byId: new Map(native.records.map((item) => [item.cardId, item])),
                    filtered,
                    search,
                    kind,
                    pages: new Map(),
                    retainedPages: [],
                    activeHandles: new Set(),
                    metadataBytes,
                    lastUsed: now,
                    expiresAt: now + TTL,
                }
                reservation.catalogue = catalogue
                unpublished = true
            }

            const pageNative = catalogue.filtered.slice(offset, offset + (options.limit ?? 24))
            const pageRevision = await randomRevision('studio-card-catalogue-page.v1', this.input.context)
            this.assertPermission(generation, permission, signal)
            if (unpublished) this.assertUnpublishedCatalogueCurrent(catalogue, generation, permission, signal)
            else this.assertCatalogueCurrent(catalogue, generation, permission, signal)

            const pageRecord: CataloguePageRecord = {
                handles: new Set(),
                cardIds: new Set(pageNative.map((item) => item.cardId)),
            }
            const pageSummaries: Array<{ summary: StudioCardSummary; authority?: StudioContextAssetAuthority }> = []
            for (const native of pageNative) {
                pageSummaries.push(await this.summary(catalogue, native, pageRevision, pageRecord))
                this.assertPermission(generation, permission, signal)
                if (unpublished) this.assertUnpublishedCatalogueCurrent(catalogue, generation, permission, signal)
                else this.assertCatalogueCurrent(catalogue, generation, permission, signal)
            }
            const activeNative = catalogue.native.hostActiveCardId
                ? catalogue.byId.get(catalogue.native.hostActiveCardId)
                : undefined
            const activeSummary = activeNative
                ? await this.summary(catalogue, activeNative, catalogue.revision)
                : undefined
            this.assertPermission(generation, permission, signal)
            if (unpublished) this.assertUnpublishedCatalogueCurrent(catalogue, generation, permission, signal)
            else this.assertCatalogueCurrent(catalogue, generation, permission, signal)

            const nextOffset = offset + pageNative.length
            const nextCursorRecord: CursorRecord | undefined = nextOffset < catalogue.filtered.length
                ? {
                    kind: 'catalogue',
                    parentRevision: catalogue.revision,
                    offset: nextOffset,
                    query: JSON.stringify([options.search, options.kind]),
                    expiresAt: this.now() + TTL,
                }
                : undefined
            const nextCursorPreparation = nextCursorRecord
                ? await this.cursorRegistry.prepareCreate(
                    this.input.context.principalId,
                    CATALOGUE_CURSOR_SERVICE,
                    this.input.context.instanceId,
                    {
                        parentRevision: catalogue.revision,
                        search: options.search ?? '',
                        kind: options.kind ?? 'all',
                    },
                )
                : undefined
            this.assertPermission(generation, permission, signal)
            if (unpublished) this.assertUnpublishedCatalogueCurrent(catalogue, generation, permission, signal)
            else this.assertCatalogueCurrent(catalogue, generation, permission, signal)
            if (consumedCursor && this.cursors.get(consumedCursor[0]) !== consumedCursor[1]) {
                throw invalid('Invalid or expired Studio card cursor')
            }
            const nextCursorCommit = nextCursorPreparation && nextCursorRecord
                ? this.cursorRegistry.prepareCommit(
                    nextCursorPreparation,
                    nextCursorRecord,
                    consumedCursor?.[0],
                )
                : undefined
            const authorities = [
                ...pageSummaries.flatMap((item) => item.authority ? [item.authority] : []),
                ...(activeSummary?.authority ? [activeSummary.authority] : []),
            ]
            const registration = this.input.assetAuthorityRegistry.registerBatch(authorities)
            try {
                if (unpublished) {
                    if (this.catalogues.has(catalogue.revision)) throw malformed('Studio catalogue revision collision')
                    if (reservation) this.validateCatalogueReservation(reservation)
                    this.catalogues.set(catalogue.revision, catalogue)
                }
                catalogue.pages.set(pageRevision, pageRecord)
                for (const item of pageSummaries) {
                    if (item.summary.portrait) pageRecord.handles.add(item.summary.portrait.assetId)
                }
                catalogue.retainedPages.push(pageRevision)
                const addedActiveHandles = new Set<string>()
                if (activeSummary?.summary.portrait) {
                    if (!catalogue.activeHandles.has(activeSummary.summary.portrait.assetId)) {
                        addedActiveHandles.add(activeSummary.summary.portrait.assetId)
                    }
                    catalogue.activeHandles.add(activeSummary.summary.portrait.assetId)
                }
                const retainedPageVictims = catalogue.retainedPages.slice(
                    0,
                    Math.max(0, catalogue.retainedPages.length - 2),
                )
                const result: StudioCardCataloguePage = {
                    catalogueRevision: catalogue.revision,
                    total: catalogue.filtered.length,
                    ...(activeSummary ? { hostActiveCard: activeSummary.summary } : {}),
                    items: pageSummaries.map((item) => item.summary),
                    ...(nextCursorCommit ? { nextCursor: nextCursorCommit.cursor } : {}),
                }
                let settled = false
                const rollback = () => {
                    if (settled) return
                    settled = true
                    registration.rollback()
                    if (catalogue.pages.get(pageRevision) === pageRecord) {
                        catalogue.pages.delete(pageRevision)
                    }
                    catalogue.retainedPages = catalogue.retainedPages.filter(
                        (revision) => revision !== pageRevision,
                    )
                    for (const assetId of addedActiveHandles) catalogue.activeHandles.delete(assetId)
                    if (unpublished && this.catalogues.get(catalogue.revision) === catalogue) {
                        this.catalogues.delete(catalogue.revision)
                    }
                    if (reservation) this.releaseReservation(reservation)
                }
                const commit = () => {
                    if (settled) return
                    try {
                        if (nextCursorPreparation && nextCursorRecord && nextCursorCommit) {
                            const cursor = this.cursorRegistry.commitPrepared(
                                nextCursorPreparation,
                                nextCursorRecord,
                                nextCursorCommit,
                            )
                            if (consumedCursor) this.cursors.delete(consumedCursor[0])
                            this.cursors.set(cursor, nextCursorRecord)
                        } else if (consumedCursor) {
                            this.clearCursor(consumedCursor[0])
                        }
                    } catch (error) {
                        rollback()
                        throw error
                    }
                    settled = true
                    if (reservation) {
                        this.commitCatalogueReservation(reservation)
                        this.releaseReservation(reservation)
                    }
                    for (const expired of retainedPageVictims) {
                        if (expired === pageRevision || !catalogue.pages.has(expired)) continue
                        catalogue.pages.delete(expired)
                        catalogue.retainedPages = catalogue.retainedPages.filter(
                            (revision) => revision !== expired,
                        )
                        this.input.assetAuthorityRegistry.revokeParent(
                            this.input.context.principalId,
                            this.input.context.instanceId,
                            expired,
                        )
                    }
                    this.touchCatalogue(catalogue)
                }
                if (transport === STUDIO_CARD_RPC_TRANSPORT) {
                    finalizerPending = true
                    return registerStudioCardRpcFinalizer(result, { commit, rollback })
                }
                commit()
                return result
            } catch (error) {
                registration.rollback()
                if (unpublished && this.catalogues.get(catalogue.revision) === catalogue) {
                    this.catalogues.delete(catalogue.revision)
                }
                throw error
            }
        } finally {
            if (reservation && !finalizerPending) this.releaseReservation(reservation)
        }
    }

    async releaseStudioCardCatalogue(revisionValue: string) {
        const revision = normalizeReleaseRevision(revisionValue, 'catalogueRevision')
        const catalogue = this.peekCatalogue(revision)
        if (this.catalogues.get(revision) !== catalogue) throw notFound('Studio card catalogue')
        this.revokeCatalogue(revision)
    }

    private revokeCatalogue(revision: string) {
        const catalogue = this.catalogues.get(revision)
        if (!catalogue) return
        this.catalogues.delete(revision)
        for (const page of catalogue.pages.keys()) {
            this.input.assetAuthorityRegistry.revokeParent(
                this.input.context.principalId,
                this.input.context.instanceId,
                page,
            )
        }
        this.input.assetAuthorityRegistry.revokeParent(
            this.input.context.principalId,
            this.input.context.instanceId,
            revision,
        )
        for (const [cursor, value] of this.cursors) {
            if (value.parentRevision === revision) this.clearCursor(cursor)
        }
    }

    private async materialize(
        native: StudioCardNativeSource,
        cardId: string,
        fence: () => void,
    ): Promise<MaterializedSource> {
        const root = cloneCard(native.card)
        if (root.id !== cardId) throw malformed('Native source returned the wrong card')
        const wanted = root.type === 'group'
            ? [...new Set(root.groupMemberIds ?? [])].sort(codePointCompare)
            : []
        if (wanted.length > MAX_MEMBER_COUNT
            || (root.type === 'character' && native.groupMembers.length > 0)) {
            throw limitError('Studio card has too many direct members')
        }
        const memberMap = new Map<string, CharacterCardSnapshot>()
        for (const member of native.groupMembers) {
            if (member.type !== 'character') throw malformed('Nested or malformed Studio group membership')
            if (memberMap.has(member.id)) continue
            memberMap.set(member.id, cloneCard(member))
        }
        if (wanted.some((id) => !memberMap.has(id))
            || [...memberMap.keys()].some((id) => !wanted.includes(id))) {
            throw malformed('Studio group membership changed')
        }
        const members = wanted.map((id) => memberMap.get(id)!)
        const owners = new Set([root.id, ...members.map((member) => member.id)])
        const identities = new Set<string>()
        const logicalIds = new Set<string>()
        const assets: AssetRecord[] = []
        for (const asset of native.assets) {
            if (!owners.has(asset.locator.ownerCardId)) throw malformed('Native Studio asset owner is invalid')
            if (identities.has(asset.logicalIdentity)) throw malformed('Native Studio logical asset identity collision')
            identities.add(asset.logicalIdentity)
            const digest = await createRevision({
                version: 1,
                domain: 'studio-card-logical-asset.v1',
                principalId: this.input.context.principalId,
                logicalIdentity: asset.logicalIdentity,
            })
            fence()
            const logicalAssetId = `studioasset_${digest.slice('sha256:'.length)}`
            if (logicalIds.has(logicalAssetId)) {
                throw malformed('Native Studio logical asset identity collision')
            }
            logicalIds.add(logicalAssetId)
            assets.push({
                descriptor: {
                    logicalAssetId,
                    assetRevision: asset.revision,
                    ownerCardId: asset.locator.ownerCardId,
                    name: asset.name,
                    mediaType: asset.mediaType,
                    role: asset.role,
                },
                identity: asset.logicalIdentity,
                locator: { ...asset.locator },
            })
        }
        assets.sort((left, right) => codePointCompare(
            left.descriptor.logicalAssetId,
            right.descriptor.logicalAssetId,
        ))
        const publicShape = {
            card: root,
            groupMembers: members,
            assets: assets.map((asset) => asset.descriptor),
        }
        const canonical = validateJsonLimits(publicShape, {
            maxDepth: 32,
            maxBytes: MAX_CAPTURE_BYTES,
        })
        const sourceRevision = await createRevision({
            version: 1,
            domain: 'studio-card-source.v1',
            ...publicShape,
        })
        fence()
        return {
            root,
            members,
            assets,
            sourceRevision,
            metadataBytes: textEncoder.encode(canonical).byteLength,
            itemCount: native.assets.length + 1 + members.length,
        }
    }

    async captureStudioCardSource(
        inputValue: StudioCardSourceCaptureInput,
        transport?: typeof STUDIO_CARD_RPC_TRANSPORT,
    ): Promise<StudioCardSourceCapture> {
        const input = normalizeCaptureInput(inputValue)
        const generation = this.serviceGeneration
        const signal = input.signal
        const permission = await this.authorize(generation, signal)
        let cardId: string
        let itemRevision: string
        let catalogue: CatalogueRecord | undefined
        let target: TargetRecord | undefined
        let explicit = false
        if ('cardId' in input) {
            catalogue = this.peekCatalogue(input.catalogueRevision)
            this.assertCatalogueCurrent(catalogue, generation, permission, signal)
            const admitted = catalogue.native.hostActiveCardId === input.cardId
                || [...catalogue.pages].some(([pageRevision, page]) =>
                    catalogue!.retainedPages.includes(pageRevision) && page.cardIds.has(input.cardId))
            const nativeRecord = catalogue.byId.get(input.cardId)
            if (!admitted || !nativeRecord
                || nativeRecord.catalogueItemRevision !== input.expectedCatalogueItemRevision) {
                throw new PluginApiError('CONFLICT', 'Studio card selection is stale or was not retained')
            }
            cardId = input.cardId
            itemRevision = nativeRecord.catalogueItemRevision
        } else {
            target = this.peekTarget(input.targetRevision)
            this.assertTargetCurrent(target, generation, permission, signal)
            cardId = target.cardId
            itemRevision = target.itemRevision
            if ('expectedSourceRevision' in input
                && input.expectedSourceRevision !== target.sourceRevision) {
                throw new PluginApiError('CONFLICT', 'Studio card source revision is stale')
            }
            explicit = 'acceptCurrentSourceRevision' in input
        }

        const reservation = this.reserveCapture({
            catalogue,
            target,
            wantsTarget: !target || explicit,
        })
        let finalizerPending = false
        try {
            const assertParent = () => {
                this.assertPermission(generation, permission, signal)
                if (catalogue) this.assertCatalogueCurrent(catalogue, generation, permission, signal)
                if (target) this.assertTargetCurrent(target, generation, permission, signal)
            }
            assertParent()
            const nativeValue = await this.captureNativeSource(cardId)
            assertParent()
            if (nativeValue === null) throw notFound('Studio card source')
            const envelope = parseNativeSourceEnvelope(nativeValue)
            const itemCount = envelope.assets.length + envelope.groupMembers.length + 1
            if (itemCount > MAX_CAPTURE_ITEMS) throw limitError('Studio card capture item limit exceeded')
            this.adjustCaptureReservation(reservation, 0, itemCount)
            const native = parseNativeSource(envelope)
            if (!this.sourceRevalidates(native)) {
                throw new PluginApiError('CONFLICT', 'Studio card source changed during capture')
            }
            const conservativeCanonical = validateJsonLimits({
                card: native.card,
                groupMembers: native.groupMembers,
                assets: native.assets,
            }, { maxDepth: 32, maxBytes: MAX_CAPTURE_BYTES })
            const conservativeMetadataBytes = textEncoder.encode(conservativeCanonical).byteLength
            this.adjustCaptureReservation(reservation, conservativeMetadataBytes, itemCount)
            const materialized = await this.materialize(native, cardId, assertParent)
            assertParent()
            if (!this.sourceRevalidates(native)) {
                throw new PluginApiError('CONFLICT', 'Studio card source changed during capture')
            }
            const retainedMetadataBytes = Math.max(
                conservativeMetadataBytes,
                materialized.metadataBytes,
            )
            this.adjustCaptureReservation(reservation, retainedMetadataBytes, materialized.itemCount)
            if (target && !explicit && materialized.sourceRevision !== target.sourceRevision) {
                throw new PluginApiError('CONFLICT', 'Studio card source changed')
            }
            const captureRevision = await randomRevision('studio-card-capture.v1', this.input.context)
            assertParent()
            const targetRevision = !target || explicit
                ? await randomRevision('studio-card-target.v1', this.input.context)
                : target.revision
            assertParent()
            if (!this.sourceRevalidates(native)) {
                throw new PluginApiError('CONFLICT', 'Studio card source changed during capture')
            }

            const now = this.now()
            const committedTarget: TargetRecord = !target || explicit ? {
                revision: targetRevision,
                cardId,
                itemRevision,
                sourceRevision: materialized.sourceRevision,
                permission,
                captures: new Set(),
                lastUsed: now,
                expiresAt: now + TARGET_TTL,
            } : target
            const capture: CaptureRecord = {
                revision: captureRevision,
                targetRevision: committedTarget.revision,
                target: committedTarget,
                sourceRevision: materialized.sourceRevision,
                permission,
                native,
                card: materialized.root,
                members: materialized.members,
                assets: materialized.assets,
                assetById: new Map(materialized.assets.map((asset) => [
                    asset.descriptor.logicalAssetId,
                    asset,
                ])),
                accesses: new Set(),
                candidateAccesses: [],
                metadataBytes: retainedMetadataBytes,
                itemCount: materialized.itemCount,
                pinOwner: 'adopted-capture',
                lastUsed: now,
                expiresAt: now + TTL,
            }
            assertParent()
            const createdTarget = !target || explicit
            if (this.captures.has(capture.revision)) throw malformed('Studio capture revision collision')
            if (createdTarget) {
                this.validateTargetReservation(reservation)
                if (this.targets.has(committedTarget.revision)) {
                    throw malformed('Studio target revision collision')
                }
                this.targets.set(committedTarget.revision, committedTarget)
            }
            this.captures.set(capture.revision, capture)
            committedTarget.captures.add(capture.revision)
            const result: StudioCardSourceCapture = {
                targetRevision: committedTarget.revision,
                captureRevision: capture.revision,
                sourceRevision: materialized.sourceRevision,
                card: cloneCard(materialized.root),
                groupMembers: materialized.members.map(cloneCard),
            }
            let settled = false
            const rollback = () => {
                if (settled) return
                settled = true
                if (this.captures.get(capture.revision) === capture) {
                    this.revokeCapture(capture.revision)
                }
                if (createdTarget && this.targets.get(committedTarget.revision) === committedTarget) {
                    this.revokeTarget(committedTarget.revision)
                }
                this.releaseReservation(reservation)
            }
            const commit = () => {
                if (settled) return
                settled = true
                if (createdTarget) this.commitTargetReservation(reservation)
                this.releaseReservation(reservation)
                this.touchCapture(capture)
            }
            if (transport === STUDIO_CARD_RPC_TRANSPORT) {
                finalizerPending = true
                return registerStudioCardRpcFinalizer(result, { commit, rollback })
            }
            commit()
            return result
        } finally {
            if (!finalizerPending) this.releaseReservation(reservation)
        }
    }

    async releaseStudioCardTarget(revisionValue: string) {
        const revision = normalizeReleaseRevision(revisionValue, 'targetRevision')
        const target = this.peekTarget(revision)
        if (this.targets.get(revision) !== target) throw notFound('Studio card target')
        this.revokeTarget(revision)
    }

    private revokeTarget(revision: string) {
        const target = this.targets.get(revision)
        if (!target) return
        this.targets.delete(revision)
        for (const capture of [...target.captures]) this.revokeCapture(capture)
    }

    async releaseStudioCardSource(revisionValue: string) {
        const revision = normalizeReleaseRevision(revisionValue, 'captureRevision')
        const capture = this.peekCapture(revision)
        if (this.captures.get(revision) !== capture) throw notFound('Studio card capture')
        this.revokeCapture(revision)
    }

    private revokeCapture(revision: string) {
        const capture = this.captures.get(revision)
        if (!capture) return
        this.captures.delete(revision)
        for (const access of [...capture.accesses]) this.revokeAccess(access)
        if (this.targets.get(capture.targetRevision) === capture.target) {
            capture.target.captures.delete(revision)
        }
        for (const [cursor, value] of this.cursors) {
            if (value.parentRevision === revision) this.clearCursor(cursor)
        }
    }

    async listStudioCardAssets(optionsValue: StudioCardAssetListOptions): Promise<StudioCardAssetPage> {
        const options = normalizeAssetListOptions(optionsValue)
        const generation = this.serviceGeneration
        const permission = await this.authorize(generation, options.signal)
        const capture = this.peekCapture(options.captureRevision)
        this.assertCaptureCurrent(capture, generation, permission, options.signal)
        const mediaTypes = options.mediaTypes ?? []
        const query = JSON.stringify(mediaTypes)
        const cursorQuery = { parentRevision: capture.revision, mediaTypes }
        let offset = 0
        let consumedCursor: [string, CursorRecord] | undefined
        if (options.cursor) {
            let cursor: CursorRecord
            try {
                cursor = await this.cursorRegistry.read<CursorRecord>(
                    options.cursor,
                    this.input.context.principalId,
                    ASSET_CURSOR_SERVICE,
                    this.input.context.instanceId,
                    cursorQuery,
                )
            } catch (error) {
                this.assertPermission(generation, permission, options.signal)
                if (this.captures.get(capture.revision) !== capture) {
                    throw notFound('Studio card capture')
                }
                throw error
            }
            this.assertCaptureCurrent(capture, generation, permission, options.signal)
            if (this.cursors.get(options.cursor) !== cursor || cursor.kind !== 'assets'
                || cursor.parentRevision !== capture.revision
                || cursor.query !== query
                || cursor.expiresAt <= this.now()) {
                throw invalid('Invalid or expired Studio asset cursor')
            }
            offset = cursor.offset
            consumedCursor = [options.cursor, cursor]
        }
        const filtered = mediaTypes.length > 0
            ? capture.assets.filter((asset) => mediaTypes.includes(asset.descriptor.mediaType.toLowerCase()))
            : capture.assets
        const assets = filtered.slice(offset, offset + (options.limit ?? 100))
            .map((asset) => ({ ...asset.descriptor }))
        const nextOffset = offset + assets.length
        const nextCursorRecord: CursorRecord | undefined = nextOffset < filtered.length
            ? {
                kind: 'assets',
                parentRevision: capture.revision,
                offset: nextOffset,
                query,
                expiresAt: this.now() + TTL,
            }
            : undefined
        const nextCursorPreparation = nextCursorRecord
            ? await this.cursorRegistry.prepareCreate(
                this.input.context.principalId,
                ASSET_CURSOR_SERVICE,
                this.input.context.instanceId,
                cursorQuery,
            )
            : undefined
        this.assertCaptureCurrent(capture, generation, permission, options.signal)
        if (consumedCursor && this.cursors.get(consumedCursor[0]) !== consumedCursor[1]) {
            throw invalid('Invalid or expired Studio asset cursor')
        }
        const nextCursorCommit = nextCursorPreparation && nextCursorRecord
            ? this.cursorRegistry.prepareCommit(
                nextCursorPreparation,
                nextCursorRecord,
                consumedCursor?.[0],
            )
            : undefined
        if (nextCursorPreparation && nextCursorRecord && nextCursorCommit) {
            const cursor = this.cursorRegistry.commitPrepared(
                nextCursorPreparation,
                nextCursorRecord,
                nextCursorCommit,
            )
            if (consumedCursor) this.cursors.delete(consumedCursor[0])
            this.cursors.set(cursor, nextCursorRecord)
        } else if (consumedCursor) {
            this.clearCursor(consumedCursor[0])
        }
        this.touchCapture(capture)
        return {
            captureRevision: capture.revision,
            assets,
            ...(nextCursorCommit ? { nextCursor: nextCursorCommit.cursor } : {}),
        }
    }

    async resolveStudioCardAssetHandles(
        optionsValue: StudioCardAssetAccessOptions,
        transport?: typeof STUDIO_CARD_RPC_TRANSPORT,
    ): Promise<StudioCardAssetAccessBatch> {
        const options = normalizeAssetAccessOptions(optionsValue)
        const generation = this.serviceGeneration
        const permission = await this.authorize(generation, options.signal)
        const capture = this.peekCapture(options.captureRevision)
        this.assertCaptureCurrent(capture, generation, permission, options.signal)
        const selected = options.logicalAssetIds.map((logicalAssetId) => {
            const asset = capture.assetById.get(logicalAssetId)
            if (!asset) throw notFound('Studio card logical asset')
            return asset
        })
        this.assertCaptureCurrent(capture, generation, permission, options.signal)
        const accessRevision = await randomRevision('studio-card-access.v1', this.input.context)
        this.assertCaptureCurrent(capture, generation, permission, options.signal)
        const handles: string[] = []
        for (const asset of selected) {
            handles.push(await this.assetHandle(accessRevision, asset.descriptor.logicalAssetId))
            this.assertCaptureCurrent(capture, generation, permission, options.signal)
        }
        const now = this.now()
        const access: AccessRecord = {
            revision: accessRevision,
            captureRevision: capture.revision,
            capture,
            purpose: options.purpose,
            permission,
            handles,
            lastUsed: now,
            expiresAt: now + TTL,
        }
        const authorities: StudioContextAssetAuthority[] = selected.map((asset, index) => {
            const locator = { ...asset.locator }
            return {
                ...this.owner(),
                assetId: handles[index],
                parentRevision: accessRevision,
                authorityKind: 'studio-card-capture',
                revision: asset.descriptor.assetRevision,
                name: asset.descriptor.name,
                mediaType: asset.descriptor.mediaType,
                validate: async (signal?: AbortSignal) => {
                    const operationGeneration = this.serviceGeneration
                    const operationPermission = await this.authorize(operationGeneration, signal)
                    if (operationPermission !== permission) {
                        this.invalidate()
                        throw abortError()
                    }
                    this.assertAccessCurrent(access, operationGeneration, permission, signal)
                },
                read: async () => this.readNativeAsset(locator),
                touch: () => {
                    if (this.accesses.get(access.revision) === access) this.touchAccess(access)
                },
            }
        })
        this.assertCaptureCurrent(capture, generation, permission, options.signal)
        const registration = this.input.assetAuthorityRegistry.registerBatch(authorities)
        try {
            this.assertCaptureCurrent(capture, generation, permission, options.signal)
            if (this.accesses.has(accessRevision)) throw malformed('Studio access revision collision')
            this.accesses.set(accessRevision, access)
            capture.accesses.add(accessRevision)
            const previousSelectedAccess = capture.selectedAccess
            const candidateVictims = options.purpose === 'candidate-page'
                ? [...capture.candidateAccesses, accessRevision].slice(0, -2)
                : []
            const result: StudioCardAssetAccessBatch = {
                captureRevision: capture.revision,
                accessRevision,
                purpose: options.purpose,
                assets: selected.map((asset, index) => ({
                    logicalAssetId: asset.descriptor.logicalAssetId,
                    asset: {
                        assetId: handles[index],
                        revision: asset.descriptor.assetRevision,
                        name: asset.descriptor.name,
                        mediaType: asset.descriptor.mediaType,
                        role: asset.descriptor.role,
                        origin: {
                            kind: 'character',
                            characterId: asset.descriptor.ownerCardId,
                        },
                    },
                })),
            }
            let settled = false
            const rollback = () => {
                if (settled) return
                settled = true
                registration.rollback()
                if (this.accesses.get(accessRevision) === access) this.revokeAccess(accessRevision)
            }
            const commit = () => {
                if (settled) return
                settled = true
                if (options.purpose === 'candidate-page') {
                    capture.candidateAccesses.push(accessRevision)
                    for (const victim of candidateVictims) {
                        if (victim !== accessRevision && capture.candidateAccesses.includes(victim)) {
                            this.revokeAccess(victim)
                        }
                    }
                } else if (capture.selectedAccess === previousSelectedAccess) {
                    if (previousSelectedAccess) this.revokeAccess(previousSelectedAccess)
                    capture.selectedAccess = accessRevision
                }
                this.touchAccess(access)
            }
            if (transport === STUDIO_CARD_RPC_TRANSPORT) {
                return registerStudioCardRpcFinalizer(result, { commit, rollback })
            }
            commit()
            return result
        } catch (error) {
            registration.rollback()
            if (this.accesses.get(accessRevision) === access) this.accesses.delete(accessRevision)
            capture.accesses.delete(accessRevision)
            throw error
        }
    }

    async releaseStudioCardAssetAccess(revisionValue: string) {
        const revision = normalizeReleaseRevision(revisionValue, 'accessRevision')
        const access = this.peekAccess(revision)
        if (this.accesses.get(revision) !== access) throw notFound('Studio card access')
        this.revokeAccess(revision)
    }

    private revokeAccess(revision: string) {
        const access = this.accesses.get(revision)
        if (!access) return
        this.accesses.delete(revision)
        this.input.assetAuthorityRegistry.revokeParent(
            this.input.context.principalId,
            this.input.context.instanceId,
            revision,
        )
        if (this.captures.get(access.captureRevision) === access.capture) {
            access.capture.accesses.delete(revision)
            access.capture.candidateAccesses = access.capture.candidateAccesses.filter(
                (item) => item !== revision,
            )
            if (access.capture.selectedAccess === revision) access.capture.selectedAccess = undefined
        }
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        StudioCardResourceServiceImpl.live.delete(this)
        this.serviceGeneration += 1
        this.input.context.signal.removeEventListener('abort', this.abort)
        this.reservations.clear()
        this.input.assetAuthorityRegistry.clearInstance(
            this.input.context.principalId,
            this.input.context.instanceId,
        )
        this.catalogues.clear()
        this.clearInstanceCursors()
        this.targets.clear()
        this.captures.clear()
        this.accesses.clear()
        this.input.readCoordinator.cancelInstance?.(this.owner())
    }
}

export function createStudioCardResourceService(input: StudioCardResourceInput): StudioCardResourceService {
    return new StudioCardResourceServiceImpl(input)
}

export function createStudioCardResourceRpcApi(service: StudioCardResourceService) {
    const implementation = service as StudioCardResourceServiceImpl
    return {
        listStudioCards: (options?: StudioCardCatalogueOptions) =>
            implementation.listStudioCards(options, STUDIO_CARD_RPC_TRANSPORT),
        releaseStudioCardCatalogue: (revision: string) => service.releaseStudioCardCatalogue(revision),
        captureStudioCardSource: (input: StudioCardSourceCaptureInput) =>
            implementation.captureStudioCardSource(input, STUDIO_CARD_RPC_TRANSPORT),
        releaseStudioCardTarget: (revision: string) => service.releaseStudioCardTarget(revision),
        listStudioCardAssets: (options: StudioCardAssetListOptions) => service.listStudioCardAssets(options),
        resolveStudioCardAssetHandles: (options: StudioCardAssetAccessOptions) =>
            implementation.resolveStudioCardAssetHandles(options, STUDIO_CARD_RPC_TRANSPORT),
        releaseStudioCardAssetAccess: (revision: string) => service.releaseStudioCardAssetAccess(revision),
        releaseStudioCardSource: (revision: string) => service.releaseStudioCardSource(revision),
    }
}
