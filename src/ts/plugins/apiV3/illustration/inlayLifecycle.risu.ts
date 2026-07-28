import type {
    InlayAssetRecord,
    InlayLifecycleMetadata as StoredInlayLifecycleMetadata,
} from 'src/ts/process/files/inlays'
import { PluginApiError } from './errors'
import type {
    InlayLifecycleAdapter,
    InlayLifecycleMetadata,
} from './inlayLifecycle'

type UnknownRecord = Record<string, any>
const MAX_INLAY_OUTPUT_BYTES = 33_554_432
const missingDataProperty = Symbol('missingDataProperty')

export interface RisuInlayLifecycleDependencies {
    getDatabase(): { characters?: UnknownRecord[] }
    getCurrentCharacter(): UnknownRecord | undefined
    listColdDataKeys(): Promise<string[]>
    getColdStorageItem(key: string): Promise<unknown>
    getInlayAssetRecord(id: string): Promise<InlayAssetRecord | null>
    writeInlayImageFromBytes(data: Uint8Array, options: {
        id: string
        name: string
        lifecycle: StoredInlayLifecycleMetadata
        maxDecodedPixels: number
        beforeStore(): void | Promise<void>
    }): Promise<string>
    removeInlayAsset(id: string): Promise<boolean>
}

const exactTokens = (id: string) => [
    `{{inlay::${id}}}`,
    `{{inlayed::${id}}}`,
    `{{inlayeddata::${id}}}`,
]

const containsToken = (value: string, tokens: readonly string[]) => tokens.some((token) => value.includes(token))

const hydratedMessagesContain = (messages: unknown, tokens: readonly string[]) => Array.isArray(messages)
    && messages.some((message) => typeof message?.data === 'string' && containsToken(message.data, tokens))

const coldMessagesContain = (messages: unknown, tokens: readonly string[]) => {
    if (!Array.isArray(messages)) throw new Error('Cold-storage message list is malformed')
    for (const message of messages) {
        if (!message || typeof message !== 'object' || typeof message.data !== 'string') {
            throw new Error('Cold-storage message is malformed')
        }
        if (containsToken(message.data, tokens)) return true
    }
    return false
}

const coldPayloadContains = (payload: unknown, tokens: readonly string[]) => {
    if (Array.isArray(payload)) return coldMessagesContain(payload, tokens)
    if (!payload || typeof payload !== 'object') throw new Error('Cold-storage payload is unreadable')
    const record = payload as UnknownRecord
    if (Object.hasOwn(record, 'message')) return coldMessagesContain(record.message, tokens)
    if (Object.hasOwn(record, 'character')) {
        const character = record.character
        if (!character || typeof character !== 'object' || !Array.isArray(character.chats)) {
            throw new Error('Cold-storage character payload is malformed')
        }
        for (const chat of character.chats) {
            if (!chat || typeof chat !== 'object') throw new Error('Cold-storage chat is malformed')
            if (coldMessagesContain(chat.message, tokens)) return true
        }
        return false
    }
    throw new Error('Cold-storage payload shape is unsupported')
}

const storageFailure = (message: string) => new PluginApiError('INTERNAL', message, { retryable: true })

const ownDataProperty = (value: unknown, key: PropertyKey): unknown | typeof missingDataProperty => {
    try {
        if (!value || typeof value !== 'object') return missingDataProperty
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor && Object.hasOwn(descriptor, 'value')
            ? descriptor.value
            : missingDataProperty
    } catch {
        return missingDataProperty
    }
}

const exactDataObject = (value: unknown, keys: readonly string[]) => {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return null
        const ownKeys = Reflect.ownKeys(value)
        if (ownKeys.length !== keys.length
            || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return null
        const result: Record<string, unknown> = {}
        for (const key of ownKeys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
            result[key as string] = descriptor.value
        }
        return result
    } catch {
        return null
    }
}

const lifecycleSnapshot = (value: unknown): InlayLifecycleMetadata | null => {
    const lifecycle = exactDataObject(value, [
        'version', 'ownerPrincipalId', 'operation', 'idempotencyKey',
        'argumentDigest', 'revision', 'context',
    ])
    const context = lifecycle
        ? exactDataObject(lifecycle.context, ['kind', 'characterId'])
        : null
    if (!lifecycle
        || lifecycle.version !== 1
        || typeof lifecycle.ownerPrincipalId !== 'string'
        || lifecycle.ownerPrincipalId.length === 0
        || lifecycle.operation !== 'inlay.create.v1'
        || typeof lifecycle.idempotencyKey !== 'string'
        || lifecycle.idempotencyKey.length === 0
        || typeof lifecycle.argumentDigest !== 'string'
        || !/^[0-9a-f]{64}$/.test(lifecycle.argumentDigest)
        || typeof lifecycle.revision !== 'string'
        || !/^sha256:[0-9a-f]{64}$/.test(lifecycle.revision)
        || !context
        || context.kind !== 'character'
        || typeof context.characterId !== 'string'
        || context.characterId.length === 0) return null
    return {
        version: 1,
        ownerPrincipalId: lifecycle.ownerPrincipalId,
        operation: 'inlay.create.v1',
        idempotencyKey: lifecycle.idempotencyKey,
        argumentDigest: lifecycle.argumentDigest,
        revision: lifecycle.revision,
        context: { kind: 'character', characterId: context.characterId },
    }
}

const projectRecord = (id: string, value: unknown) => {
    const lifecycle = lifecycleSnapshot(ownDataProperty(value, 'lifecycle'))
    const name = ownDataProperty(value, 'name')
    return {
        id,
        name: typeof name === 'string' ? name : '',
        revision: lifecycle?.revision ?? '',
        ...(lifecycle ? { lifecycle } : {}),
    }
}

const normalizeImageMediaType = (value: string) => value.split(';', 1)[0].trim().toLowerCase()

const sameProjectedRecord = (
    left: ReturnType<typeof projectRecord>,
    right: ReturnType<typeof projectRecord>,
) => {
    if (!left.lifecycle || !right.lifecycle) return false
    return left.id === right.id
        && left.name === right.name
        && left.revision === right.revision
        && left.lifecycle.version === right.lifecycle.version
        && left.lifecycle.ownerPrincipalId === right.lifecycle.ownerPrincipalId
        && left.lifecycle.operation === right.lifecycle.operation
        && left.lifecycle.idempotencyKey === right.lifecycle.idempotencyKey
        && left.lifecycle.argumentDigest === right.lifecycle.argumentDigest
        && left.lifecycle.revision === right.lifecycle.revision
        && left.lifecycle.context.kind === right.lifecycle.context.kind
        && left.lifecycle.context.characterId === right.lifecycle.context.characterId
}

const imageSnapshot = (id: string, value: unknown) => {
    const data = ownDataProperty(value, 'data')
    const type = ownDataProperty(value, 'type')
    if (type !== 'image' || !(data instanceof Blob)) {
        throw new PluginApiError('DECODE_FAILED', 'Stored Inlay is not an image Blob')
    }
    const mediaType = normalizeImageMediaType(data.type)
    if (!mediaType.startsWith('image/')) {
        throw new PluginApiError('DECODE_FAILED', 'Stored Inlay has an invalid image media type')
    }
    const record = projectRecord(id, value)
    if (!record.lifecycle) {
        throw new PluginApiError('PERMISSION_DENIED', 'Stored Inlay lifecycle is malformed')
    }
    const ext = ownDataProperty(value, 'ext')
    const width = ownDataProperty(value, 'width')
    const height = ownDataProperty(value, 'height')
    const lifecycle = record.lifecycle
    const evidence = JSON.stringify([
        record.id, record.name, record.revision,
        lifecycle.version, lifecycle.ownerPrincipalId, lifecycle.operation,
        lifecycle.idempotencyKey, lifecycle.argumentDigest, lifecycle.revision,
        lifecycle.context.kind, lifecycle.context.characterId,
        typeof ext === 'string' ? ext : null,
        typeof width === 'number' ? width : null,
        typeof height === 'number' ? height : null,
        type, data.size, data.type, mediaType,
    ])
    return { blob: data, evidence, mediaType, record }
}

const changedDuringRead = () => new PluginApiError(
    'CONFLICT',
    'Inlay changed while it was being read',
    { retryable: true },
)

export function createRisuInlayLifecycleAdapter(
    dependencies: RisuInlayLifecycleDependencies,
): InlayLifecycleAdapter {
    return {
        getCurrentCharacterId() {
            const id = dependencies.getCurrentCharacter()?.chaId
            return typeof id === 'string' && id.length > 0 ? id : null
        },
        async getInlay(id) {
            let record: InlayAssetRecord | null
            try {
                record = await dependencies.getInlayAssetRecord(id)
            } catch {
                throw storageFailure('Unable to read Inlay storage')
            }
            if (!record) return null
            return projectRecord(id, record)
        },
        async readImage(id, maxBytes, approvedRecord) {
            let beforeRecord: InlayAssetRecord | null
            try {
                beforeRecord = await dependencies.getInlayAssetRecord(id)
            } catch (error) {
                if (error instanceof PluginApiError) throw error
                throw storageFailure('Unable to read Inlay storage')
            }
            if (!beforeRecord) return null

            const approvedId = ownDataProperty(approvedRecord, 'id')
            const approved = projectRecord(typeof approvedId === 'string' ? approvedId : '', approvedRecord)
            const candidate = projectRecord(id, beforeRecord)
            if (!sameProjectedRecord(candidate, approved)) throw changedDuringRead()
            const before = imageSnapshot(id, beforeRecord)
            if (before.blob.size > maxBytes || before.blob.size > MAX_INLAY_OUTPUT_BYTES) {
                throw new PluginApiError('RESOURCE_LIMIT', 'Inlay bytes exceed maxBytes')
            }

            let buffer: ArrayBuffer
            try {
                buffer = await before.blob.arrayBuffer()
            } catch (error) {
                if (error instanceof PluginApiError) throw error
                throw storageFailure('Unable to read Inlay bytes')
            }
            if (buffer.byteLength !== before.blob.size) throw changedDuringRead()

            let afterRecord: InlayAssetRecord | null
            try {
                afterRecord = await dependencies.getInlayAssetRecord(id)
            } catch (error) {
                if (error instanceof PluginApiError) throw error
                throw storageFailure('Unable to confirm Inlay storage')
            }
            if (!afterRecord) throw changedDuringRead()
            let after
            try {
                after = imageSnapshot(id, afterRecord)
            } catch (error) {
                if (error instanceof PluginApiError) throw changedDuringRead()
                throw storageFailure('Unable to confirm Inlay storage')
            }
            if (before.evidence !== after.evidence) throw changedDuringRead()

            return {
                record: after.record,
                mediaType: after.mediaType,
                data: new Uint8Array(buffer).slice(),
            }
        },
        async writeImage(data, request) {
            try {
                await dependencies.writeInlayImageFromBytes(data.slice(), {
                    id: request.id,
                    name: request.name,
                    lifecycle: {
                        ...request.lifecycle,
                        context: { ...request.lifecycle.context },
                    },
                    maxDecodedPixels: 64_000_000,
                    beforeStore: request.beforeMutation,
                })
            } catch (error) {
                if (error instanceof PluginApiError) throw error
                if (error instanceof Error && error.name === 'InlayImageDecodeError') {
                    throw new PluginApiError('DECODE_FAILED', 'Unable to decode Inlay image')
                }
                throw storageFailure('Unable to store Inlay image')
            }
        },
        async hasReference(id) {
            const tokens = exactTokens(id)
            const characters = dependencies.getDatabase().characters ?? []
            for (const character of characters) {
                if (!Array.isArray(character?.chats)) continue
                for (const chat of character.chats) {
                    if (hydratedMessagesContain(chat?.message, tokens)) return true
                }
            }

            try {
                const keys = await dependencies.listColdDataKeys()
                if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || key.length === 0)) {
                    throw new Error('Cold-storage key list is malformed')
                }
                for (const key of new Set(keys)) {
                    const payload = await dependencies.getColdStorageItem(key)
                    if (coldPayloadContains(payload, tokens)) return true
                }
                return false
            } catch (error) {
                if (error instanceof PluginApiError) throw error
                throw storageFailure('Unable to verify cold-storage Inlay references')
            }
        },
        async removeInlay(id) {
            try {
                return await dependencies.removeInlayAsset(id)
            } catch {
                throw storageFailure('Unable to remove Inlay from storage')
            }
        },
    }
}
