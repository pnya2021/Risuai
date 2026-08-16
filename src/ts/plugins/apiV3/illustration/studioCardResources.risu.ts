import { PluginApiError } from './errors'
import { assertContextSnapshotLimits, type CharacterCardSnapshot, type CharacterTextSection, type ContextLoreSnapshot } from './contextResources'
import { createSynchronousRevision } from './queryCaptureCache'
import { createStudioCardCatalogueIndex, type StudioCardCatalogueIndexSnapshot } from './studioCardCatalogueIndex.svelte'
import type {
    StudioCardAssetLocator,
    StudioCardNativeCatalogue,
    StudioCardNativeSource,
    StudioCardResourceAdapter,
} from './studioCardResources'

type UnknownRecord = Record<PropertyKey, any>

export interface RisuStudioCardAdapterDependencies {
    getDatabase(): { characters?: unknown[] }
    getSelectedCharacterIndex(): number
    readImage(storageKey: string): Promise<Uint8Array | ArrayBuffer | ArrayBufferView | null | undefined>
    getAssetStorageRevision?(storageKey: string): string
    reactiveCatalogueIndex?: boolean
}

const ownData = (record: object, key: PropertyKey) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor) return { valid: true as const, value: undefined }
    if (!('value' in descriptor)) return { valid: false as const, value: undefined }
    return { valid: true as const, value: descriptor.value }
}

const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const arrayValues = (value: unknown): unknown[] | null => {
    if (!Array.isArray(value)) return null
    const length = ownData(value, 'length')
    if (!length.valid || !Number.isSafeInteger(length.value) || length.value < 0) return null
    const result: unknown[] = []
    for (let index = 0; index < length.value; index++) {
        const item = ownData(value, index)
        if (!item.valid) return null
        result.push(item.value)
    }
    return result
}

const extensionOf = (pathOrName?: string) => {
    if (!pathOrName) return undefined
    const clean = pathOrName.split(/[?#]/, 1)[0]
    const dot = clean.lastIndexOf('.')
    return dot >= 0 && dot < clean.length - 1 ? clean.slice(dot + 1).toLowerCase() : undefined
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
        default: return 'application/octet-stream'
    }
}

const canonicalStorageKey = (value: unknown): value is string => {
    if (!nonEmptyString(value) || !value.startsWith('assets/')) return false
    const fileName = value.slice('assets/'.length)
    return Boolean(fileName && fileName !== '.' && fileName !== '..'
        && fileName === fileName.normalize('NFC')
        && fileName.trim() === fileName
        && !/[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(fileName))
}

const malformed = (message: string) => new PluginApiError('CONFLICT', message, { retryable: true })

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

const textFields: Array<{ key: string; label: string; source: string }> = [
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

const mapText = (raw: UnknownRecord): CharacterTextSection[] => textFields.flatMap(({ key, label, source }) => {
    const field = ownData(raw, source)
    if (!field.valid) throw malformed('Studio card text field is accessor-backed')
    return nonEmptyString(field.value) ? [{ key, label, content: field.value }] : []
})

const mapLore = (raw: UnknownRecord): ContextLoreSnapshot[] => {
    const field = ownData(raw, 'globalLore')
    if (!field.valid) throw malformed('Studio card lore is accessor-backed')
    if (field.value === undefined) return []
    const entries = arrayValues(field.value)
    if (!entries) throw malformed('Studio card lore is malformed')
    return entries.map((entry, index) => {
        if (!isRecord(entry)) throw malformed('Studio card lore is malformed')
        const values = Object.fromEntries(
            ['id', 'comment', 'key', 'content', 'mode'].map((key) => [key, ownData(entry, key)]),
        ) as Record<string, ReturnType<typeof ownData>>
        if (Object.values(values).some((value) => !value.valid)) throw malformed('Studio card lore is accessor-backed')
        const id = nonEmptyString(values.id.value) ? values.id.value : `lore:${index}`
        return {
            id,
            name: nonEmptyString(values.comment.value) ? values.comment.value
                : nonEmptyString(values.key.value) ? values.key.value : id,
            content: typeof values.content.value === 'string' ? values.content.value : '',
            enabled: values.mode.value !== 'folder',
        }
    })
}

interface NativeAssetProjection {
    logicalIdentity: string
    revision: string
    storageRevision: string
    name: string
    mediaType: string
    role: 'portrait' | 'emotion' | 'additional'
    storageKey: string
    nativeSlot: number
}

const mapAssets = (
    raw: UnknownRecord,
    cardId: string,
    storageRevision: (storageKey: string) => string,
    createPublicRevision = true,
): NativeAssetProjection[] => {
    const result: NativeAssetProjection[] = []
    const retain = (
        collection: 'image' | 'emotionImages' | 'additionalAssets' | 'ccAssets',
        rawSlot: number,
        role: NativeAssetProjection['role'],
        storageKey: unknown,
        name: unknown,
        explicitExtension?: unknown,
    ) => {
        if (!canonicalStorageKey(storageKey)) return
        const extension = nonEmptyString(explicitExtension)
            ? explicitExtension.replace(/^\./, '').toLowerCase()
            : extensionOf(typeof name === 'string' ? name : undefined) ?? extensionOf(storageKey)
        const currentStorageRevision = storageRevision(storageKey)
        result.push({
            logicalIdentity: `character:${cardId}:${collection}:${storageKey}`,
            revision: createPublicRevision
                ? createSynchronousRevision({
                    version: 1,
                    domain: 'studio-card-asset-revision.v1',
                    storageRevision: currentStorageRevision,
                })
                : '',
            storageRevision: currentStorageRevision,
            name: nonEmptyString(name) ? name : `${collection}-${rawSlot}.${extension ?? 'bin'}`,
            mediaType: mediaTypeOf(extension),
            role,
            storageKey,
            nativeSlot: result.length,
        })
    }
    const image = ownData(raw, 'image')
    if (!image.valid) throw malformed('Studio card image is accessor-backed')
    if (canonicalStorageKey(image.value)) {
        const name = ownData(raw, 'name')
        if (!name.valid) throw malformed('Studio card name is accessor-backed')
        const extension = extensionOf(image.value)
        retain('image', 0, 'portrait', image.value, `${nonEmptyString(name.value) ? name.value : cardId}.${extension ?? 'png'}`)
    }
    for (const [collection, role] of [
        ['emotionImages', 'emotion'],
        ['additionalAssets', 'additional'],
    ] as const) {
        const field = ownData(raw, collection)
        if (!field.valid) throw malformed(`Studio card ${collection} is accessor-backed`)
        if (field.value === undefined) continue
        const entries = arrayValues(field.value)
        if (!entries) throw malformed(`Studio card ${collection} is malformed`)
        entries.forEach((entry, index) => {
            const tuple = arrayValues(entry)
            if (!tuple) throw malformed(`Studio card ${collection} is malformed`)
            retain(collection, index, role, tuple[1], nonEmptyString(tuple[0]) ? tuple[0] : `${role}-${index}`, tuple[2])
        })
    }
    const ccAssets = ownData(raw, 'ccAssets')
    if (!ccAssets.valid) throw malformed('Studio card ccAssets is accessor-backed')
    if (ccAssets.value !== undefined) {
        const entries = arrayValues(ccAssets.value)
        if (!entries) throw malformed('Studio card ccAssets is malformed')
        entries.forEach((entry, index) => {
            if (!isRecord(entry)) throw malformed('Studio card ccAssets is malformed')
            const uri = ownData(entry, 'uri')
            const name = ownData(entry, 'name')
            const extension = ownData(entry, 'ext')
            if (!uri.valid || !name.valid || !extension.valid) throw malformed('Studio card ccAssets is accessor-backed')
            retain('ccAssets', index, 'additional', uri.value,
                nonEmptyString(name.value) ? name.value : `card-asset-${index}`,
                nonEmptyString(extension.value) ? extension.value : undefined)
        })
    }
    return result
}

const normalizeBinary = (value: Uint8Array | ArrayBuffer | ArrayBufferView | null | undefined) => {
    if (value instanceof Uint8Array) return value.slice()
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    }
    return null
}

export function createRisuStudioCardResourceAdapter(
    dependencies: RisuStudioCardAdapterDependencies,
): StudioCardResourceAdapter {
    const index = createStudioCardCatalogueIndex({
        getCharacters: () => dependencies.getDatabase().characters,
        getSelectedCharacterIndex: dependencies.getSelectedCharacterIndex,
        getAssetStorageRevision: (storageKey) => dependencies.getAssetStorageRevision?.(storageKey) ?? storageKey,
        reactive: dependencies.reactiveCatalogueIndex,
    })
    const catalogueAuthorities = new WeakMap<object, StudioCardCatalogueIndexSnapshot>()
    const sourceAuthorities = new WeakMap<object, {
        cardId: string
        nativeRevision: string
        source: StudioCardNativeSource
    }>()

    const sourceRecords = (cardId: string) => {
        const catalogue = index.current()
        const rootRecord = catalogue.byId.get(cardId)
        if (!rootRecord) return null
        const rootMembers = rootRecord.native.kind === 'group'
            ? [...new Set(rootRecord.native.groupMemberIds)].sort(codePointCompare)
            : []
        const memberRecords = rootMembers.map((memberId) => catalogue.byId.get(memberId))
        if (memberRecords.some((member) => !member || member.native.kind !== 'character')) {
            throw malformed('Studio group membership is missing, nested, or malformed')
        }
        return { rootRecord, rootMembers, memberRecords: memberRecords as typeof rootRecord[] }
    }

    const projectSnapshot = (
        record: NonNullable<ReturnType<typeof sourceRecords>>['rootRecord'],
        rootMembers: string[],
    ) => {
        const base = {
            id: record.native.cardId,
            type: record.native.kind,
            name: record.native.name,
            textSections: mapText(record.raw),
            lorebook: mapLore(record.raw),
            ...(record.native.kind === 'group' ? { groupMemberIds: [...rootMembers] } : {}),
        }
        assertContextSnapshotLimits(base)
        const snapshot: CharacterCardSnapshot = { ...base, revision: createSynchronousRevision(base) }
        assertContextSnapshotLimits(snapshot)
        return snapshot
    }

    const sourceProjection = (cardId: string): StudioCardNativeSource | null => {
        const records = sourceRecords(cardId)
        if (!records) return null
        const { rootRecord, rootMembers, memberRecords } = records
        const projectCard = (record: NonNullable<(typeof memberRecords)[number]> | typeof rootRecord) => {
            const snapshot = projectSnapshot(record, rootMembers)
            const assets = mapAssets(
                record.raw,
                record.native.cardId,
                (storageKey) => dependencies.getAssetStorageRevision?.(storageKey) ?? storageKey,
            )
            const ownerRevision = createSynchronousRevision({
                version: 1,
                card: snapshot,
                assets: assets.map(({ logicalIdentity, revision, name, mediaType, role, nativeSlot }) => ({
                    logicalIdentity, revision, name, mediaType, role, nativeSlot,
                })),
            })
            return { snapshot, assets, ownerRevision }
        }
        const root = projectCard(rootRecord)
        const members = memberRecords.map(projectCard)
        const all = [root, ...members]
        const assets = all.flatMap((owner) => owner.assets.map((asset) => ({
            logicalIdentity: asset.logicalIdentity,
            revision: asset.revision,
            name: asset.name,
            mediaType: asset.mediaType,
            role: asset.role,
            locator: {
                ownerCardId: owner.snapshot.id,
                ownerRevision: owner.ownerRevision,
                storageRevision: asset.storageRevision,
                nativeSlot: asset.nativeSlot,
            },
        })))
        const publicShape = {
            card: root.snapshot,
            groupMembers: members.map((member) => member.snapshot),
            assets,
        }
        return {
            nativeRevision: createSynchronousRevision({ version: 1, ...publicShape }),
            ...publicShape,
            authority: {},
        }
    }

    const sourceMatches = (cardId: string, expected: StudioCardNativeSource) => {
        const records = sourceRecords(cardId)
        if (!records) return false
        const { rootRecord, rootMembers, memberRecords } = records
        const snapshots = [
            projectSnapshot(rootRecord, rootMembers),
            ...memberRecords.map((record) => projectSnapshot(record, rootMembers)),
        ]
        const expectedSnapshots = [expected.card, ...expected.groupMembers]
        if (snapshots.length !== expectedSnapshots.length
            || snapshots.some((snapshot, index) => snapshot.id !== expectedSnapshots[index].id
                || snapshot.revision !== expectedSnapshots[index].revision)) return false
        const currentAssets = [rootRecord, ...memberRecords].flatMap((record) => mapAssets(
            record.raw,
            record.native.cardId,
            (storageKey) => dependencies.getAssetStorageRevision?.(storageKey) ?? storageKey,
            false,
        ))
        const ownerIds = new Set(snapshots.map((snapshot) => snapshot.id))
        return currentAssets.length === expected.assets.length
            && currentAssets.every((asset, position) => {
                const retained = expected.assets[position]
                return asset.logicalIdentity === retained.logicalIdentity
                    && asset.storageRevision === retained.locator.storageRevision
                    && asset.name === retained.name
                    && asset.mediaType === retained.mediaType
                    && asset.role === retained.role
                    && asset.nativeSlot === retained.locator.nativeSlot
                    && ownerIds.has(retained.locator.ownerCardId)
            })
    }

    const coherentSource = (cardId: string) => {
        const before = sourceProjection(cardId)
        if (!before) return null
        const after = sourceProjection(cardId)
        if (!after || before.nativeRevision !== after.nativeRevision) {
            throw malformed('Studio card source changed during native projection')
        }
        sourceAuthorities.set(after.authority, {
            cardId,
            nativeRevision: after.nativeRevision,
            source: after,
        })
        return after
    }

    return {
        async captureCatalogue(): Promise<StudioCardNativeCatalogue> {
            const snapshot = index.current()
            const authority = snapshot.authority
            catalogueAuthorities.set(authority, snapshot)
            return {
                nativeRevision: snapshot.nativeRevision,
                ...(snapshot.hostActiveCardId ? { hostActiveCardId: snapshot.hostActiveCardId } : {}),
                records: snapshot.records.map(({ native }) => ({
                    ...native,
                    groupMemberIds: [...native.groupMemberIds],
                    ...(native.portrait ? { portrait: { ...native.portrait, locator: { ...native.portrait.locator } } } : {}),
                })),
                authority,
            }
        },
        revalidateCatalogue(capture) {
            const snapshot = catalogueAuthorities.get(capture.authority)
            return Boolean(snapshot
                && capture.nativeRevision === snapshot.nativeRevision
                && index.isCurrent(snapshot))
        },
        async captureSource(cardId) {
            return coherentSource(cardId)
        },
        revalidateSource(capture) {
            const authority = sourceAuthorities.get(capture.authority)
            if (!authority || authority.nativeRevision !== capture.nativeRevision) return false
            try {
                return sourceMatches(authority.cardId, authority.source)
            } catch {
                return false
            }
        },
        async readAsset(locator: StudioCardAssetLocator) {
            const catalogue = index.current()
            const owner = catalogue.byId.get(locator.ownerCardId)
            if (!owner) return null
            if (owner.native.catalogueItemRevision === locator.ownerRevision
                && owner.native.portrait?.locator.nativeSlot === locator.nativeSlot
                && owner.native.portrait.locator.storageRevision === locator.storageRevision) {
                const image = ownData(owner.raw, 'image')
                if (!image.valid || !canonicalStorageKey(image.value)) return null
                const currentStorageRevision = dependencies.getAssetStorageRevision?.(image.value) ?? image.value
                if (currentStorageRevision !== locator.storageRevision) return null
                return normalizeBinary(await dependencies.readImage(image.value))
            }
            const projection = sourceProjection(locator.ownerCardId)
            if (!projection) return null
            const ownerAssets = projection.assets.filter((asset) => asset.locator.ownerCardId === locator.ownerCardId)
            const asset = ownerAssets.find((item) => item.locator.nativeSlot === locator.nativeSlot)
            if (!asset
                || asset.locator.ownerRevision !== locator.ownerRevision
                || asset.locator.storageRevision !== locator.storageRevision) return null
            const rawAssets = mapAssets(
                owner.raw,
                owner.native.cardId,
                (storageKey) => dependencies.getAssetStorageRevision?.(storageKey) ?? storageKey,
            )
            const raw = rawAssets.find((item) => item.nativeSlot === locator.nativeSlot)
            if (!raw || raw.storageRevision !== locator.storageRevision) return null
            return normalizeBinary(await dependencies.readImage(raw.storageKey))
        },
        captureGeneration: () => index.current().generation,
        isGenerationCurrent: (generation) => index.current().generation === generation,
    }
}

export type RisuStudioCardRecord = UnknownRecord
