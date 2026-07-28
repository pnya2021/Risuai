import { PluginApiError } from './errors'
import type {
    InlayAtomicAttachHostAdapter,
    InlayAtomicAttachResult,
    PreparedInlayAtomicAttach,
} from './inlayAtomicAttach'
import type { InlayDescriptor, InlayCreateOptions } from './inlayLifecycle'
import {
    MAX_CALLER_ATTACHMENTS,
    cloneCallerMessageMetadata,
    messageRevisionValue,
    projectCallerAttachments,
    projectMessageContent,
    resolveLogicalInsertionOffset,
    type MessageQueryHostMessage,
    type MessageRef,
    type MessageSnapshot,
    type PluginJsonValue,
} from './messageQuery'
import { withMessageMutationLock } from './messagePatch.risu'
import { canonicalJson, createRevision as createCanonicalRevision, validateJsonLimits } from './revision'

type UnknownRecord = Record<string, any>
type DatabaseRoot = {
    characters?: UnknownRecord[]
    pluginAtomicAttachReceipts?: unknown
}

const OPERATION = 'inlay.atomic-attach.v1'
const CREATE_OPERATION = 'inlay.create.v1'
const MAX_METADATA_KEYS = 16
const MAX_METADATA_BYTES = 65_536
const MAX_RECEIPTS_PER_PRINCIPAL = 4_096
const MAX_RECEIPT_BYTES = 2_200_000
const MAX_RECEIPT_STORE_BYTES = 134_217_728
const MAX_SNAPSHOT_UTF16 = 262_144
const MAX_SNAPSHOT_JSON_BYTES = 2_097_152
const encoder = new TextEncoder()

interface PersistedAtomicReceipt {
    version: 1
    principalId: string
    operation: typeof OPERATION
    idempotencyKey: string
    digest: string
    target: MessageRef
    result: InlayAtomicAttachResult
    completedAt: number
}

export interface RisuInlayAtomicAttachDependencies {
    getDatabase(): DatabaseRoot
    getCurrentCharacter(): UnknownRecord | undefined
    getCurrentChat(): UnknownRecord | undefined
    preLoadChat(characterIndex: number, chatIndex: number): Promise<void>
    coldStorageHeader: string
    listInlayAssets(): Promise<Array<[string, unknown]>>
    createInlay(data: Uint8Array, options: InlayCreateOptions): Promise<InlayDescriptor>
    deleteInlay(id: string, options?: { expectedRevision?: string }): Promise<unknown>
    waitForMessagePersistence(target: MessageRef, revision: string): Promise<void>
    requestDatabaseSaveNow?(): void
    createRevision?: (value: unknown) => Promise<string>
    createId?: () => string
    now?: () => number
}

type LocatedConversation = {
    root: DatabaseRoot
    character: UnknownRecord
    characterIndex: number
    chat: UnknownRecord
    chatIndex: number
    messages: UnknownRecord[]
}

type LocatedMessage = LocatedConversation & { message: UnknownRecord; messageIndex: number }
type SourceBaseline = LocatedMessage & { signature: string }

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const plainRecord = (value: unknown): value is UnknownRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const cloneJson = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T
const conflict = (message = 'Message changed; retry the attachment') => new PluginApiError('CONFLICT', message, {
    retryable: true,
})
const notFound = () => new PluginApiError('NOT_FOUND', 'Committed message was not found')
const internal = (message: string) => new PluginApiError('INTERNAL', message, { retryable: true })

const findConversation = (root: DatabaseRoot, target: Pick<MessageRef, 'characterId' | 'conversationId'>) => {
    const characters = Array.isArray(root.characters) ? root.characters : []
    const characterMatches = characters.flatMap((character, characterIndex) =>
        character?.chaId === target.characterId ? [{ character, characterIndex }] : [])
    if (characterMatches.length !== 1) return undefined
    const { character, characterIndex } = characterMatches[0]
    const chats = Array.isArray(character.chats) ? character.chats : []
    const chatMatches = chats.flatMap((chat: UnknownRecord, chatIndex: number) =>
        chat?.id === target.conversationId ? [{ chat, chatIndex }] : [])
    if (chatMatches.length !== 1 || !Array.isArray(chatMatches[0].chat.message)) return undefined
    return {
        root,
        character,
        characterIndex,
        chat: chatMatches[0].chat,
        chatIndex: chatMatches[0].chatIndex,
        messages: chatMatches[0].chat.message as UnknownRecord[],
    }
}

const findMessage = (root: DatabaseRoot, target: MessageRef): LocatedMessage => {
    const conversation = findConversation(root, target)
    if (!conversation) throw notFound()
    const matches = conversation.messages.flatMap((message, messageIndex) =>
        message?.chatId === target.messageId ? [{ message, messageIndex }] : [])
    if (matches.length === 0) throw notFound()
    if (matches.length !== 1) throw conflict('Message identity is ambiguous')
    const located = { ...conversation, ...matches[0] }
    if (located.chat.isStreaming === true
        && located.messageIndex === located.messages.length - 1
        && located.message.role === 'char') throw conflict('Message is not committed')
    if ((located.message.role !== 'user' && located.message.role !== 'char')
        || typeof located.message.data !== 'string') throw conflict()
    return located
}

const isColdPointer = (messages: unknown, header: string) => Array.isArray(messages)
    && typeof messages[0]?.data === 'string' && messages[0].data.startsWith(header)

const isSyntheticColdFailure = (messages: unknown) => Array.isArray(messages)
    && typeof messages[0]?.data === 'string'
    && messages[0].data.startsWith('[Cold storage data could not be loaded.')

const sourceSignature = (located: LocatedMessage) => canonicalJson({
    characterId: located.character.chaId,
    conversationId: located.chat.id,
    isStreaming: located.chat.isStreaming === true,
    messageIndex: located.messageIndex,
    messageId: located.message.chatId,
    message: {
        ...messageRevisionValue(located.message as MessageQueryHostMessage),
        time: located.message.time ?? null,
        pluginMessageUpdatedAt: located.message.pluginMessageUpdatedAt ?? null,
    },
    receipts: located.root.pluginAtomicAttachReceipts ?? [],
})

const captureBaseline = (located: LocatedMessage): SourceBaseline => ({
    ...located,
    signature: sourceSignature(located),
})

const sameCurrent = (dependencies: RisuInlayAtomicAttachDependencies, target: MessageRef) => {
    const character = dependencies.getCurrentCharacter()
    const chat = dependencies.getCurrentChat()
    return character?.chaId === target.characterId && chat?.id === target.conversationId
}

const sameHydrationEpoch = (
    dependencies: RisuInlayAtomicAttachDependencies,
    baseline: LocatedConversation,
) => {
    const root = dependencies.getDatabase()
    const current = findConversation(root, {
        characterId: baseline.character.chaId,
        conversationId: baseline.chat.id,
    })
    return root === baseline.root && current?.character === baseline.character && current.chat === baseline.chat
}

const sameSource = (dependencies: RisuInlayAtomicAttachDependencies, baseline: SourceBaseline) => {
    try {
        const root = dependencies.getDatabase()
        const current = findMessage(root, {
            characterId: baseline.character.chaId,
            conversationId: baseline.chat.id,
            messageId: baseline.message.chatId,
        })
        return root === baseline.root
            && current.character === baseline.character
            && current.chat === baseline.chat
            && current.messages === baseline.messages
            && current.message === baseline.message
            && current.messageIndex === baseline.messageIndex
            && sourceSignature(current) === baseline.signature
    } catch {
        return false
    }
}

const classifyBoundaryError = (
    dependencies: RisuInlayAtomicAttachDependencies,
    request: PreparedInlayAtomicAttach,
    error: unknown,
    label: string,
    baseline?: SourceBaseline,
) => {
    if (request.signal.aborted) return new PluginApiError('ABORTED', 'Operation aborted')
    if (!sameCurrent(dependencies, request.input.target)) {
        return new PluginApiError('PERMISSION_DENIED', 'Message target is not current')
    }
    if (baseline && !sameSource(dependencies, baseline)) return conflict()
    if (error instanceof PluginApiError) return error
    return internal(`${label} dependency failed`)
}

const ensureBoundary = (
    dependencies: RisuInlayAtomicAttachDependencies,
    request: PreparedInlayAtomicAttach,
    baseline?: SourceBaseline,
) => {
    if (request.signal.aborted) throw new PluginApiError('ABORTED', 'Operation aborted')
    if (!sameCurrent(dependencies, request.input.target)) {
        throw new PluginApiError('PERMISSION_DENIED', 'Message target is not current')
    }
    if (baseline && !sameSource(dependencies, baseline)) throw conflict()
}

const validReceipt = (value: unknown): value is PersistedAtomicReceipt => plainRecord(value)
    && value.version === 1
    && nonEmpty(value.principalId)
    && value.operation === OPERATION
    && nonEmpty(value.idempotencyKey)
    && typeof value.digest === 'string' && /^[0-9a-f]{64}$/u.test(value.digest)
    && plainRecord(value.target)
    && nonEmpty(value.target.characterId)
    && nonEmpty(value.target.conversationId)
    && nonEmpty(value.target.messageId)
    && plainRecord(value.result)
    && plainRecord(value.result.inlay)
    && nonEmpty(value.result.inlay.id)
    && nonEmpty(value.result.inlay.revision)
    && nonEmpty(value.result.inlay.name)
    && plainRecord(value.result.message)
    && nonEmpty(value.result.commitId)
    && typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)

const readReceipts = (root: DatabaseRoot): PersistedAtomicReceipt[] => {
    const value = root.pluginAtomicAttachReceipts
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((entry) => !validReceipt(entry))) {
        throw internal('Atomic Inlay receipts are invalid')
    }
    return value.map((entry) => cloneJson(entry))
}

const receiptReplay = (records: PersistedAtomicReceipt[], request: PreparedInlayAtomicAttach) => {
    const matches = records.filter((record) => record.principalId === request.principalId
        && record.operation === OPERATION && record.idempotencyKey === request.input.idempotencyKey)
    if (matches.length > 1) throw internal('Duplicate atomic Inlay receipt')
    if (matches.length === 0) return undefined
    if (matches[0].digest !== request.argumentDigest) {
        throw new PluginApiError('CONFLICT', 'Idempotency key arguments conflict')
    }
    return cloneJson(matches[0].result)
}

const appendReceipt = (records: PersistedAtomicReceipt[], receipt: PersistedAtomicReceipt) => {
    if (records.filter((record) => record.principalId === receipt.principalId).length
        >= MAX_RECEIPTS_PER_PRINCIPAL) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Atomic Inlay receipt capacity is full', { retryable: true })
    }
    if (encoder.encode(canonicalJson(receipt)).byteLength > MAX_RECEIPT_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Atomic Inlay receipt exceeds storage limit')
    }
    const result = [...records, receipt]
    if (encoder.encode(canonicalJson(result)).byteLength > MAX_RECEIPT_STORE_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Atomic Inlay receipt storage is full', { retryable: true })
    }
    return result
}

const callerState = (message: UnknownRecord, principalId: string) => {
    const root = message.pluginMessageState === undefined ? {} : cloneJson(message.pluginMessageState)
    if (!plainRecord(root)) throw internal('Plugin message state is invalid')
    const descriptor = Object.getOwnPropertyDescriptor(root, principalId)
    const existing = descriptor?.value
    if (existing === undefined) return { root, state: { metadata: {}, attachments: [] as unknown[] } }
    if (!plainRecord(existing) || !plainRecord(existing.metadata) || !Array.isArray(existing.attachments)) {
        throw internal('Caller message state is invalid')
    }
    return {
        root,
        state: cloneJson(existing) as {
            metadata: Record<string, PluginJsonValue>
            attachments: unknown[]
            updatedAt?: number
        },
    }
}

const validateCallerState = (state: { metadata: Record<string, PluginJsonValue>; attachments: unknown[] }) => {
    if (Object.keys(state.metadata).length > MAX_METADATA_KEYS) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Caller message metadata key limit exceeded')
    }
    if (state.attachments.length > MAX_CALLER_ATTACHMENTS) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Caller message attachment limit exceeded')
    }
    validateJsonLimits({ metadata: state.metadata, attachments: state.attachments }, {
        maxDepth: 32,
        maxBytes: MAX_METADATA_BYTES,
    })
}

const speakerFor = (character: UnknownRecord, message: UnknownRecord) => {
    if (message.role !== 'char') return undefined
    if (character.type !== 'group') return nonEmpty(character.chaId) ? character.chaId : undefined
    return Array.isArray(character.characters) && nonEmpty(message.saying)
        && character.characters.includes(message.saying) ? message.saying : undefined
}

const snapshotFor = (
    located: LocatedMessage,
    message: UnknownRecord,
    principalId: string,
    revision: string,
    recognized: ReadonlySet<string>,
): MessageSnapshot => {
    const own = plainRecord(message.pluginMessageState)
        ? Object.getOwnPropertyDescriptor(message.pluginMessageState, principalId)?.value
        : undefined
    const updatedAt = Math.max(
        typeof message.time === 'number' ? message.time : 0,
        typeof message.pluginMessageUpdatedAt === 'number' ? message.pluginMessageUpdatedAt : 0,
        plainRecord(own) && typeof own.updatedAt === 'number' ? own.updatedAt : 0,
    )
    const result: MessageSnapshot = {
        characterId: located.character.chaId,
        conversationId: located.chat.id,
        messageId: message.chatId,
        role: message.role,
        content: projectMessageContent(message.data, recognized),
        revision,
        updatedAt,
        callerPluginState: {
            metadata: cloneCallerMessageMetadata(message as MessageQueryHostMessage, principalId),
            attachments: projectCallerAttachments(
                message.data,
                recognized,
                plainRecord(own) ? own.attachments : undefined,
            ),
        },
    }
    const speaker = speakerFor(located.character, message)
    if (speaker) result.speakerCharacterId = speaker
    if (nonEmpty(message.generationInfo?.generationId)) result.generationId = message.generationInfo.generationId
    if (typeof message.time === 'number') result.createdAt = message.time
    if (result.content.length > MAX_SNAPSHOT_UTF16) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Message content exceeds snapshot limit')
    }
    if (encoder.encode(JSON.stringify(result)).byteLength > MAX_SNAPSHOT_JSON_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Message snapshot exceeds serialized limit')
    }
    return result
}

const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest(
    'SHA-256', encoder.encode(value),
))].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const atomicLifecycleKey = async (request: PreparedInlayAtomicAttach) => {
    const keyDigest = await sha256(request.input.idempotencyKey)
    return `atomic-${keyDigest}-${request.argumentDigest}`
}

const deterministicInlayId = async (principalId: string, idempotencyKey: string) =>
    `inlay_${await sha256(JSON.stringify([principalId, CREATE_OPERATION, idempotencyKey]))}`

const lifecycleKeyConflict = (
    assets: Array<[string, unknown]>,
    request: PreparedInlayAtomicAttach,
    expectedKey: string,
) => {
    const prefix = expectedKey.slice(0, expectedKey.lastIndexOf('-') + 1)
    const matches = assets.filter((entry) => {
        const lifecycle = plainRecord(entry[1]) && plainRecord(entry[1].lifecycle)
            ? entry[1].lifecycle : undefined
        return lifecycle?.ownerPrincipalId === request.principalId
            && lifecycle.operation === CREATE_OPERATION
            && typeof lifecycle.idempotencyKey === 'string'
            && lifecycle.idempotencyKey.startsWith(prefix)
    })
    if (matches.length > 1 || (matches.length === 1
        && (matches[0][1] as UnknownRecord).lifecycle.idempotencyKey !== expectedKey)) {
        throw new PluginApiError('CONFLICT', 'Idempotency key arguments conflict')
    }
}

const restoreAfterFailure = (
    dependencies: RisuInlayAtomicAttachDependencies,
    target: MessageRef,
    stagedBaseline: SourceBaseline,
    previous: {
        data: string
        hadState: boolean
        state: unknown
        updatedAt: unknown
        receiptsUndefined: boolean
        receipts: PersistedAtomicReceipt[]
    },
) => {
    if (!sameSource(dependencies, stagedBaseline)) return
    try {
        const root = dependencies.getDatabase()
        const located = findMessage(root, target)
        located.message.data = previous.data
        if (previous.hadState) located.message.pluginMessageState = previous.state
        else delete located.message.pluginMessageState
        if (previous.updatedAt === undefined) delete located.message.pluginMessageUpdatedAt
        else located.message.pluginMessageUpdatedAt = previous.updatedAt
        if (previous.receiptsUndefined) delete root.pluginAtomicAttachReceipts
        else root.pluginAtomicAttachReceipts = previous.receipts
        dependencies.requestDatabaseSaveNow?.()
    } catch {
        dependencies.requestDatabaseSaveNow?.()
    }
}

export function createRisuInlayAtomicAttachAdapter(
    dependencies: RisuInlayAtomicAttachDependencies,
): InlayAtomicAttachHostAdapter {
    const revision = dependencies.createRevision ?? createCanonicalRevision
    const createId = dependencies.createId ?? (() => crypto.randomUUID())
    const now = dependencies.now ?? Date.now
    return {
        current: () => {
            const character = dependencies.getCurrentCharacter()
            const chat = dependencies.getCurrentChat()
            if (!nonEmpty(character?.chaId) || !nonEmpty(chat?.id)) return null
            return { characterId: character.chaId, conversationId: chat.id }
        },

        attachCurrentMessage: (request) => withMessageMutationLock(async () => {
            let staged: InlayDescriptor | undefined
            let persistenceRequested = false
            try {
                ensureBoundary(dependencies, request)
                const initialRoot = dependencies.getDatabase()
                const initialConversation = findConversation(initialRoot, request.input.target)
                if (!initialConversation) throw notFound()
                if (isColdPointer(initialConversation.messages, dependencies.coldStorageHeader)) {
                    try {
                        await dependencies.preLoadChat(
                            initialConversation.characterIndex,
                            initialConversation.chatIndex,
                        )
                    } catch (error) {
                        if (request.signal.aborted) throw new PluginApiError('ABORTED', 'Operation aborted')
                        if (!sameCurrent(dependencies, request.input.target)) {
                            throw new PluginApiError('PERMISSION_DENIED', 'Message target is not current')
                        }
                        if (!sameHydrationEpoch(dependencies, initialConversation)) throw conflict()
                        if (error instanceof PluginApiError) throw error
                        throw internal('Message hydration dependency failed')
                    }
                    if (request.signal.aborted) throw new PluginApiError('ABORTED', 'Operation aborted')
                    if (!sameCurrent(dependencies, request.input.target)) {
                        throw new PluginApiError('PERMISSION_DENIED', 'Message target is not current')
                    }
                    if (!sameHydrationEpoch(dependencies, initialConversation)) throw conflict()
                    const hydrated = findConversation(dependencies.getDatabase(), request.input.target)
                    if (!hydrated || isColdPointer(hydrated.messages, dependencies.coldStorageHeader)
                        || isSyntheticColdFailure(hydrated.messages)) throw conflict()
                }
                ensureBoundary(dependencies, request)

                const root = dependencies.getDatabase()
                const conversation = findConversation(root, request.input.target)
                if (!conversation) throw notFound()
                const activeReceipts = readReceipts(root)
                const replay = receiptReplay(activeReceipts, request)
                if (replay) return replay

                const located = findMessage(root, request.input.target)
                const baseline = captureBaseline(located)
                let actualRevision: string
                try {
                    actualRevision = await revision(messageRevisionValue(
                        located.message as MessageQueryHostMessage,
                    ))
                } catch (error) {
                    throw classifyBoundaryError(dependencies, request, error, 'Message revision', baseline)
                }
                ensureBoundary(dependencies, request, baseline)
                if (actualRevision !== request.input.expectedMessageRevision) {
                    throw conflict('Message revision is stale')
                }

                let assets: Array<[string, unknown]>
                try {
                    assets = await dependencies.listInlayAssets()
                } catch (error) {
                    throw classifyBoundaryError(dependencies, request, error, 'Message Inlay projection', baseline)
                }
                ensureBoundary(dependencies, request, baseline)
                const recognized = new Set(assets.flatMap((entry) => Array.isArray(entry) && nonEmpty(entry[0])
                    ? [entry[0]] : []))

                const insertionOffset = resolveLogicalInsertionOffset(
                    located.message.data,
                    recognized,
                    request.input.placement,
                )
                if (insertionOffset === null) {
                    throw new PluginApiError('INVALID_ARGUMENT', 'Invalid logical UTF-16 placement')
                }
                const prepared = callerState(located.message, request.principalId)
                const metadata = cloneJson(prepared.state.metadata)
                const attachmentMetadata = cloneJson(request.input.attachmentMetadata)
                const messageMetadata = request.input.messageMetadata[0]
                Object.defineProperty(metadata, messageMetadata.key, {
                    value: cloneJson(messageMetadata.value),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                })

                let lifecycleKey: string
                let anticipatedId: string
                try {
                    lifecycleKey = await atomicLifecycleKey(request)
                    ensureBoundary(dependencies, request, baseline)
                    anticipatedId = await deterministicInlayId(request.principalId, lifecycleKey)
                } catch (error) {
                    throw classifyBoundaryError(dependencies, request, error, 'Atomic Inlay identity', baseline)
                }
                ensureBoundary(dependencies, request, baseline)
                lifecycleKeyConflict(assets, request, lifecycleKey)
                if (prepared.state.attachments.some((attachment) => plainRecord(attachment)
                    && attachment.inlayId === anticipatedId)) {
                    throw new PluginApiError('CONFLICT', 'Inlay is already attached to this message')
                }
                const nextState = {
                    ...prepared.state,
                    metadata,
                    attachments: [
                        ...cloneJson(prepared.state.attachments),
                        { inlayId: anticipatedId, presentation: 'inline', metadata: attachmentMetadata },
                    ],
                    updatedAt: now(),
                }
                validateCallerState(nextState)

                try {
                    staged = await dependencies.createInlay(request.input.data.slice(), {
                        name: request.input.inlay.name,
                        idempotencyKey: lifecycleKey,
                        context: { kind: 'character', characterId: request.input.target.characterId },
                        return: 'descriptor',
                    })
                } catch (error) {
                    throw classifyBoundaryError(dependencies, request, error, 'Atomic Inlay staging', baseline)
                }
                ensureBoundary(dependencies, request, baseline)
                if (staged.id !== anticipatedId || staged.name !== request.input.inlay.name) {
                    throw internal('Atomic Inlay lifecycle identity is invalid')
                }
                Object.defineProperty(prepared.root, request.principalId, {
                    value: nextState,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                })
                const token = `{{inlay::${staged.id}}}`
                const completedAt = now()
                const stagedMessage = {
                    ...located.message,
                    data: located.message.data.slice(0, insertionOffset)
                        + token + located.message.data.slice(insertionOffset),
                    pluginMessageState: prepared.root,
                    pluginMessageUpdatedAt: completedAt,
                }
                let nextRevision: string
                try {
                    nextRevision = await revision(messageRevisionValue(stagedMessage as MessageQueryHostMessage))
                } catch (error) {
                    throw classifyBoundaryError(dependencies, request, error, 'Message revision', baseline)
                }
                ensureBoundary(dependencies, request, baseline)
                const withStaged = new Set([...recognized, staged.id])
                const result: InlayAtomicAttachResult = {
                    inlay: cloneJson(staged),
                    message: snapshotFor(located, stagedMessage, request.principalId, nextRevision, withStaged),
                    commitId: createId(),
                }
                const receipt: PersistedAtomicReceipt = {
                    version: 1,
                    principalId: request.principalId,
                    operation: OPERATION,
                    idempotencyKey: request.input.idempotencyKey,
                    digest: request.argumentDigest,
                    target: cloneJson(request.input.target),
                    result: cloneJson(result),
                    completedAt,
                }
                const nextReceipts = appendReceipt(activeReceipts, receipt)
                ensureBoundary(dependencies, request, baseline)

                const previous = {
                    data: located.message.data,
                    hadState: located.message.pluginMessageState !== undefined,
                    state: located.message.pluginMessageState === undefined
                        ? undefined : cloneJson(located.message.pluginMessageState),
                    updatedAt: located.message.pluginMessageUpdatedAt,
                    receiptsUndefined: root.pluginAtomicAttachReceipts === undefined,
                    receipts: activeReceipts,
                }
                located.message.data = stagedMessage.data
                located.message.pluginMessageState = stagedMessage.pluginMessageState
                located.message.pluginMessageUpdatedAt = stagedMessage.pluginMessageUpdatedAt
                root.pluginAtomicAttachReceipts = nextReceipts
                const stagedBaseline = captureBaseline(findMessage(root, request.input.target))
                persistenceRequested = true

                try {
                    await dependencies.waitForMessagePersistence(request.input.target, nextRevision)
                } catch (error) {
                    const classified = classifyBoundaryError(
                        dependencies,
                        request,
                        error,
                        'Atomic Inlay persistence',
                        stagedBaseline,
                    )
                    restoreAfterFailure(dependencies, request.input.target, stagedBaseline, previous)
                    throw classified
                }
                try {
                    ensureBoundary(dependencies, request, stagedBaseline)
                } catch (error) {
                    restoreAfterFailure(dependencies, request.input.target, stagedBaseline, previous)
                    throw error
                }
                return result
            } catch (error) {
                if (staged && !persistenceRequested) {
                    try {
                        await dependencies.deleteInlay(staged.id, { expectedRevision: staged.revision })
                    } catch {
                        // Cleanup is best effort and must never hide the primary typed failure.
                    }
                }
                throw error
            }
        }),
    }
}
