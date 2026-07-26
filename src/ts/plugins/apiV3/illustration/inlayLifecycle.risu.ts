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
            const lifecycle = record.lifecycle as InlayLifecycleMetadata | undefined
            return {
                id,
                name: typeof record.name === 'string' ? record.name : '',
                revision: typeof lifecycle?.revision === 'string' ? lifecycle.revision : '',
                ...(lifecycle ? { lifecycle } : {}),
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
