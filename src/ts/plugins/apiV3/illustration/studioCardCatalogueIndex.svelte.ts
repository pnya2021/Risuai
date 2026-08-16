import { createSynchronousRevision } from './queryCaptureCache'
import type { StudioCardNativeRecord } from './studioCardResources'

type UnknownRecord = Record<PropertyKey, unknown>

const RESERVED_CARD_IDS = new Set(['§temp', '§playground'])

const ownData = (record: object, key: PropertyKey) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor) return { valid: true as const, value: undefined }
    if (!('value' in descriptor)) return { valid: false as const, value: undefined }
    return { valid: true as const, value: descriptor.value }
}

const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const extensionOf = (pathOrName: string) => {
    const clean = pathOrName.split(/[?#]/, 1)[0]
    const dot = clean.lastIndexOf('.')
    return dot >= 0 && dot < clean.length - 1 ? clean.slice(dot + 1).toLowerCase() : undefined
}

const mediaTypeOf = (extension?: string) => {
    switch (extension) {
        case 'png': return 'image/png'
        case 'jpg':
        case 'jpeg': return 'image/jpeg'
        case 'webp': return 'image/webp'
        case 'gif': return 'image/gif'
        case 'avif': return 'image/avif'
        case 'svg': return 'image/svg+xml'
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

const arrayData = (value: unknown): { valid: boolean; values: unknown[] } => {
    if (!Array.isArray(value)) return { valid: false, values: [] }
    const length = ownData(value, 'length')
    if (!length.valid || !Number.isSafeInteger(length.value) || (length.value as number) < 0) {
        return { valid: false, values: [] }
    }
    const values: unknown[] = []
    for (let index = 0; index < (length.value as number); index++) {
        const item = ownData(value, index)
        if (!item.valid) return { valid: false, values: [] }
        values.push(item.value)
    }
    return { valid: true, values }
}

export interface StudioCardCatalogueIndexDependencies {
    getCharacters(): unknown[] | undefined
    getSelectedCharacterIndex(): number
    getAssetStorageRevision(storageKey: string): string
    reactive?: boolean
}

export interface StudioCardCatalogueIndexRecord {
    raw: UnknownRecord
    rawSlot: number
    native: StudioCardNativeRecord
}

export interface StudioCardCatalogueIndexSnapshot {
    generation: string
    nativeRevision: string
    hostActiveCardId?: string
    records: StudioCardCatalogueIndexRecord[]
    byId: ReadonlyMap<string, StudioCardCatalogueIndexRecord>
    authority: object
}

interface Candidate {
    raw: UnknownRecord
    rawSlot: number
    cardId: string
    kind: 'character' | 'group'
    name: string
    groupMemberIds: string[]
    portrait?: { storageKey: string; storageRevision: string; revision: string; name: string; mediaType: string }
}

const projectCandidate = (
    raw: unknown,
    rawSlot: number,
    getAssetStorageRevision: (storageKey: string) => string,
): Candidate | null => {
    if (!isRecord(raw)) return null
    const scalar = Object.fromEntries(['chaId', 'type', 'name', 'image', 'characters', 'trashTime'].map((key) => [
        key, ownData(raw, key),
    ])) as Record<string, ReturnType<typeof ownData>>
    if (Object.values(scalar).some((value) => !value.valid)) return null
    const cardId = scalar.chaId.value
    if (!nonEmptyString(cardId) || RESERVED_CARD_IDS.has(cardId) || scalar.trashTime.value) return null
    const kind = scalar.type.value === 'group'
        ? 'group'
        : scalar.type.value === undefined || scalar.type.value === 'character'
            ? 'character'
            : null
    if (!kind || !nonEmptyString(scalar.name.value)) return null
    let groupMemberIds: string[] = []
    if (kind === 'group') {
        const members = arrayData(scalar.characters.value)
        if (!members.valid || members.values.some((value) => !nonEmptyString(value))) return null
        groupMemberIds = [...new Set(members.values as string[])]
    }
    let portrait: Candidate['portrait']
    if (canonicalStorageKey(scalar.image.value)) {
        const extension = extensionOf(scalar.image.value)
        const storageRevision = getAssetStorageRevision(scalar.image.value)
        portrait = {
            storageKey: scalar.image.value,
            storageRevision,
            revision: createSynchronousRevision({
                version: 1,
                domain: 'studio-card-asset-revision.v1',
                storageRevision,
            }),
            name: `${scalar.name.value}.${extension ?? 'png'}`,
            mediaType: mediaTypeOf(extension),
        }
    }
    return { raw, rawSlot, cardId, kind, name: scalar.name.value, groupMemberIds, ...(portrait ? { portrait } : {}) }
}

export class StudioCardCatalogueIndex {
    private revision = 0
    private snapshot?: StudioCardCatalogueIndexSnapshot
    private identity: UnknownRecord[] = []

    constructor(private readonly dependencies: StudioCardCatalogueIndexDependencies) {}

    current(): StudioCardCatalogueIndexSnapshot {
        const rawCharacters = this.dependencies.getCharacters()
        const characters = Array.isArray(rawCharacters) ? rawCharacters : []
        const candidates: Candidate[] = []
        for (let index = 0; index < characters.length; index++) {
            const slot = ownData(characters, index)
            if (!slot.valid) continue
            const candidate = projectCandidate(
                slot.value,
                index,
                this.dependencies.getAssetStorageRevision,
            )
            if (candidate) candidates.push(candidate)
        }
        const counts = new Map<string, number>()
        for (const candidate of candidates) counts.set(candidate.cardId, (counts.get(candidate.cardId) ?? 0) + 1)
        const visible = candidates.filter((candidate) => counts.get(candidate.cardId) === 1)
        const nativeShape = visible.map((candidate) => ({
            rawSlot: candidate.rawSlot,
            cardId: candidate.cardId,
            kind: candidate.kind,
            name: candidate.name,
            groupMemberIds: candidate.groupMemberIds,
            ...(candidate.portrait ? { portrait: candidate.portrait } : {}),
        }))
        const selectedIndex = this.dependencies.getSelectedCharacterIndex()
        const active = visible.find((candidate) => candidate.rawSlot === selectedIndex)
        const fingerprint = createSynchronousRevision({
            version: 1,
            records: nativeShape,
            hostActiveCardId: active?.cardId ?? null,
        })
        const sameIdentity = visible.length === this.identity.length
            && visible.every((candidate, index) => candidate.raw === this.identity[index])
        if (this.snapshot?.nativeRevision === fingerprint && sameIdentity) return this.snapshot

        this.revision += 1
        const authority = {}
        const records: StudioCardCatalogueIndexRecord[] = visible.map((candidate) => {
            const catalogueItemRevision = createSynchronousRevision({
                version: 1,
                rawSlot: candidate.rawSlot,
                cardId: candidate.cardId,
                kind: candidate.kind,
                name: candidate.name,
                groupMemberIds: candidate.groupMemberIds,
                portrait: candidate.portrait ?? null,
            })
            return {
                raw: candidate.raw,
                rawSlot: candidate.rawSlot,
                native: {
                    cardId: candidate.cardId,
                    catalogueItemRevision,
                    kind: candidate.kind,
                    name: candidate.name,
                    groupMemberIds: [...candidate.groupMemberIds],
                    ...(candidate.portrait ? {
                        portrait: {
                            revision: candidate.portrait.revision,
                            name: candidate.portrait.name,
                            mediaType: candidate.portrait.mediaType,
                            locator: {
                                ownerCardId: candidate.cardId,
                                ownerRevision: catalogueItemRevision,
                                storageRevision: candidate.portrait.storageRevision,
                                nativeSlot: 0,
                            },
                        },
                    } : {}),
                },
            }
        })
        this.identity = visible.map((candidate) => candidate.raw)
        this.snapshot = {
            generation: `studio-card-index:${this.revision}`,
            nativeRevision: fingerprint,
            ...(active ? { hostActiveCardId: active.cardId } : {}),
            records,
            byId: new Map(records.map((record) => [record.native.cardId, record])),
            authority,
        }
        return this.snapshot
    }

    isCurrent(snapshot: StudioCardCatalogueIndexSnapshot) {
        return this.current() === snapshot
    }
}

export const createStudioCardCatalogueIndex = (dependencies: StudioCardCatalogueIndexDependencies) =>
{
    const index = new StudioCardCatalogueIndex(dependencies)
    if (!dependencies.reactive) return index
    const currentSnapshot = $derived.by(() => index.current())
    return {
        current: () => currentSnapshot,
        isCurrent: (snapshot: StudioCardCatalogueIndexSnapshot) => currentSnapshot === snapshot,
    }
}
