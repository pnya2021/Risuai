import { PluginApiError } from './errors'
import type {
    MessagePatchHostAdapter,
    MessagePatchResult,
    PreparedMessagePatch,
    RestrictedMessagePatch,
} from './messagePatch'
import {
    MAX_CALLER_ATTACHMENTS,
    cloneCallerMessageMetadata,
    messageRevisionValue,
    projectCallerAttachments,
    projectLogicalContent,
    projectMessageContent,
    resolveLogicalInsertionOffset,
    type MessageQueryHostMessage,
    type MessageRef,
    type MessageSnapshot,
    type PluginJsonValue,
} from './messageQuery'
import { canonicalJson, createRevision as createCanonicalRevision, validateJsonLimits } from './revision'

type UnknownRecord = Record<string, any>
type DatabaseRoot = { characters?: UnknownRecord[]; pluginMessagePatchReceipts?: unknown }

const OPERATION = 'chat.message-patch.v1'
const RECEIPT_VERSION = 1
const RECEIPT_RETENTION_MS = 86_400_000
const MAX_RECEIPTS_PER_PRINCIPAL = 4_096
const MAX_METADATA_KEYS = 16
const MAX_CALLER_METADATA_BYTES = 65_536
const MAX_SNAPSHOT_UTF16 = 262_144
const MAX_SNAPSHOT_JSON_BYTES = 2_097_152
const encoder = new TextEncoder()

interface PersistedMessagePatchReceipt {
    version: 1
    principalId: string
    operation: typeof OPERATION
    idempotencyKey: string
    digest: string
    target: MessageRef
    result: MessagePatchResult
    completedAt: number
    expiresAt: number
}

export interface RisuMessagePatchAdapterDependencies {
    getDatabase(): DatabaseRoot
    getCurrentCharacter(): UnknownRecord | undefined
    getCurrentChat(): UnknownRecord | undefined
    preLoadChat(characterIndex: number, chatIndex: number): Promise<void>
    coldStorageHeader: string
    listInlayAssets(): Promise<Array<[string, unknown]>>
    getInlayAssetRecord(id: string): Promise<unknown | null>
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

const conflict = (message = 'Message changed; retry the request') => new PluginApiError('CONFLICT', message, {
    retryable: true,
})

const notFound = () => new PluginApiError('NOT_FOUND', 'Committed message was not found')

const internal = (message: string) => new PluginApiError('INTERNAL', message, { retryable: true })

const plainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const cloneJson = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T

const findConversation = (
    root: DatabaseRoot,
    target: Pick<MessageRef, 'characterId' | 'conversationId'>,
): LocatedConversation | undefined => {
    const characters = Array.isArray(root.characters) ? root.characters : []
    const charactersFound = characters.flatMap((character, characterIndex) =>
        character?.chaId === target.characterId ? [{ character, characterIndex }] : [])
    if (charactersFound.length !== 1) return undefined
    const { character, characterIndex } = charactersFound[0]
    const chats = Array.isArray(character.chats) ? character.chats : []
    const chatsFound = chats.flatMap((chat: UnknownRecord, chatIndex: number) =>
        chat?.id === target.conversationId ? [{ chat, chatIndex }] : [])
    if (chatsFound.length !== 1 || !Array.isArray(chatsFound[0].chat.message)) return undefined
    return {
        root,
        character,
        characterIndex,
        chat: chatsFound[0].chat,
        chatIndex: chatsFound[0].chatIndex,
        messages: chatsFound[0].chat.message,
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
    if (located.message.role !== 'user' && located.message.role !== 'char') throw conflict()
    if (typeof located.message.data !== 'string') throw conflict()
    return located
}

const isColdPointer = (messages: unknown, header: string) => Array.isArray(messages)
    && typeof messages[0]?.data === 'string'
    && messages[0].data.startsWith(header)

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
    receipts: located.root.pluginMessagePatchReceipts ?? [],
})

const captureBaseline = (located: LocatedMessage): SourceBaseline => ({
    ...located,
    signature: sourceSignature(located),
})

const sameCurrent = (dependencies: RisuMessagePatchAdapterDependencies, target: MessageRef) => {
    const character = dependencies.getCurrentCharacter()
    const chat = dependencies.getCurrentChat()
    return character?.chaId === target.characterId && chat?.id === target.conversationId
}

const sameHydrationEpoch = (dependencies: RisuMessagePatchAdapterDependencies, baseline: LocatedConversation) => {
    const root = dependencies.getDatabase()
    const current = findConversation(root, {
        characterId: baseline.character.chaId,
        conversationId: baseline.chat.id,
    })
    return root === baseline.root
        && current?.character === baseline.character
        && current.chat === baseline.chat
}

const sameSource = (dependencies: RisuMessagePatchAdapterDependencies, baseline: SourceBaseline) => {
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
    dependencies: RisuMessagePatchAdapterDependencies,
    request: PreparedMessagePatch,
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
    dependencies: RisuMessagePatchAdapterDependencies,
    request: PreparedMessagePatch,
    baseline?: SourceBaseline,
) => {
    const failure = classifyBoundaryError(dependencies, request, undefined, 'Message patch', baseline)
    if (failure.code === 'INTERNAL') return
    throw failure
}

const ownedInlayFailure = () => new PluginApiError(
    'PERMISSION_DENIED',
    'Inlay is not owned by the current plugin',
)

const deterministicInlayId = async (principalId: string, idempotencyKey: string) => {
    const bytes = encoder.encode(JSON.stringify([principalId, 'inlay.create.v1', idempotencyKey]))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return `inlay_${[...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const assertOwnedInlay = async (
    dependencies: RisuMessagePatchAdapterDependencies,
    request: PreparedMessagePatch,
    baseline: SourceBaseline,
    inlayId: string,
) => {
    let record: unknown
    try {
        record = await dependencies.getInlayAssetRecord(inlayId)
    } catch (error) {
        throw classifyBoundaryError(dependencies, request, error, 'Inlay ownership', baseline)
    }
    ensureBoundary(dependencies, request, baseline)
    if (record === null) throw new PluginApiError('NOT_FOUND', 'Owned Inlay was not found')
    const lifecycle = plainRecord(record) && plainRecord(record.lifecycle)
        ? record.lifecycle
        : undefined
    const context = lifecycle && plainRecord(lifecycle.context) ? lifecycle.context : undefined
    if (!lifecycle
        || lifecycle.version !== 1
        || lifecycle.ownerPrincipalId !== request.principalId
        || lifecycle.operation !== 'inlay.create.v1'
        || !nonEmpty(lifecycle.idempotencyKey)
        || encoder.encode(lifecycle.idempotencyKey).byteLength > 256
        || typeof lifecycle.argumentDigest !== 'string'
        || !/^[0-9a-f]{64}$/.test(lifecycle.argumentDigest)
        || typeof lifecycle.revision !== 'string'
        || !/^sha256:[0-9a-f]{64}$/.test(lifecycle.revision)
        || !context
        || context.kind !== 'character'
        || context.characterId !== request.input.target.characterId) throw ownedInlayFailure()
    let expectedId: string
    try {
        expectedId = await deterministicInlayId(request.principalId, lifecycle.idempotencyKey)
    } catch (error) {
        throw classifyBoundaryError(dependencies, request, error, 'Inlay ownership', baseline)
    }
    ensureBoundary(dependencies, request, baseline)
    if (expectedId !== inlayId) throw ownedInlayFailure()
    let confirmed: unknown
    try {
        confirmed = await dependencies.getInlayAssetRecord(inlayId)
    } catch (error) {
        throw classifyBoundaryError(dependencies, request, error, 'Inlay ownership', baseline)
    }
    ensureBoundary(dependencies, request, baseline)
    const confirmedLifecycle = plainRecord(confirmed) && plainRecord(confirmed.lifecycle)
        ? confirmed.lifecycle
        : undefined
    if (!confirmedLifecycle || canonicalJson(confirmedLifecycle) !== canonicalJson(lifecycle)) {
        throw conflict('Owned Inlay changed before message staging')
    }
}

const storedAttachmentIndexes = (attachments: unknown[], inlayId: string) => attachments
    .flatMap((attachment, index) => plainRecord(attachment) && attachment.inlayId === inlayId
        ? [{ attachment, index }] : [])

const managedAttachment = (
    data: string,
    recognized: ReadonlySet<string>,
    attachments: unknown[],
    inlayId: string,
) => {
    const matches = storedAttachmentIndexes(attachments, inlayId)
    if (matches.length === 0) {
        throw new PluginApiError('NOT_FOUND', 'Caller-owned Inlay attachment was not found')
    }
    if (matches.length !== 1 || matches[0].attachment.presentation !== 'inline') {
        throw conflict('Caller-owned Inlay attachment is ambiguous')
    }
    const marker = projectLogicalContent(data, recognized).markers.find((candidate) => candidate.id === inlayId)
    if (!marker) throw conflict('Caller-owned Inlay marker is missing')
    return { ...matches[0], marker }
}

const attachedDescriptor = (patch: Extract<RestrictedMessagePatch, { op: 'attachInlay' }>) => ({
    inlayId: patch.inlayId,
    presentation: 'inline' as const,
    ...(patch.metadata === undefined ? {} : { metadata: cloneJson(patch.metadata) }),
})

const restoredReceiptResult = (value: unknown, target: MessageRef): MessagePatchResult => {
    let cloned: unknown
    try {
        cloned = cloneJson(value)
    } catch {
        throw internal('Message patch receipt is invalid')
    }
    if (!plainRecord(cloned)
        || typeof cloned.changed !== 'boolean'
        || !nonEmpty(cloned.commitId)
        || !plainRecord(cloned.message)
        || cloned.message.characterId !== target.characterId
        || cloned.message.conversationId !== target.conversationId
        || cloned.message.messageId !== target.messageId
        || !nonEmpty(cloned.message.revision)) throw internal('Message patch receipt is invalid')
    return cloned as unknown as MessagePatchResult
}

const readReceipts = (root: DatabaseRoot): PersistedMessagePatchReceipt[] => {
    const raw = root.pluginMessagePatchReceipts
    if (raw === undefined) return []
    if (!Array.isArray(raw)) throw internal('Message patch receipt store is invalid')
    return raw.map((value) => {
        if (!plainRecord(value)
            || value.version !== RECEIPT_VERSION
            || !nonEmpty(value.principalId)
            || value.operation !== OPERATION
            || !nonEmpty(value.idempotencyKey)
            || !nonEmpty(value.digest)
            || !plainRecord(value.target)
            || !nonEmpty(value.target.characterId)
            || !nonEmpty(value.target.conversationId)
            || !nonEmpty(value.target.messageId)
            || typeof value.completedAt !== 'number'
            || !Number.isFinite(value.completedAt)
            || typeof value.expiresAt !== 'number'
            || !Number.isFinite(value.expiresAt)) throw internal('Message patch receipt store is invalid')
        const target = value.target as unknown as MessageRef
        return {
            version: RECEIPT_VERSION,
            principalId: value.principalId,
            operation: OPERATION,
            idempotencyKey: value.idempotencyKey,
            digest: value.digest,
            target: cloneJson(target),
            result: restoredReceiptResult(value.result, target),
            completedAt: value.completedAt,
            expiresAt: value.expiresAt,
        }
    })
}

const existingReplay = (
    receipts: PersistedMessagePatchReceipt[],
    request: PreparedMessagePatch,
    now: number,
) => {
    const matches = receipts.filter((receipt) => receipt.principalId === request.principalId
        && receipt.operation === OPERATION
        && receipt.idempotencyKey === request.input.idempotencyKey
        && now <= receipt.expiresAt)
    if (matches.length > 1) throw internal('Message patch receipt store is invalid')
    if (matches.length === 0) return undefined
    if (matches[0].digest !== request.argumentDigest) {
        throw new PluginApiError('CONFLICT', 'Idempotency key arguments conflict')
    }
    return cloneJson(matches[0].result)
}

const callerState = (message: UnknownRecord, principalId: string) => {
    const rootValue = message.pluginMessageState
    const root = rootValue === undefined ? {} : cloneJson(rootValue)
    if (!plainRecord(root)) throw internal('Plugin message state is invalid')
    const stateValue = Object.getOwnPropertyDescriptor(root, principalId)?.value
    if (stateValue === undefined) return { root, state: { metadata: {}, attachments: [] as unknown[] } }
    if (!plainRecord(stateValue) || !plainRecord(stateValue.metadata) || !Array.isArray(stateValue.attachments)) {
        throw internal('Caller message state is invalid')
    }
    return { root, state: cloneJson(stateValue) as {
        metadata: Record<string, PluginJsonValue>
        attachments: unknown[]
        updatedAt?: number
    } }
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
        maxBytes: MAX_CALLER_METADATA_BYTES,
    })
}

const speakerFor = (character: UnknownRecord, message: UnknownRecord) => {
    if (message.role !== 'char') return undefined
    if (character.type !== 'group') return nonEmpty(character.chaId) ? character.chaId : undefined
    return Array.isArray(character.characters)
        && nonEmpty(message.saying)
        && character.characters.includes(message.saying)
        ? message.saying
        : undefined
}

const snapshotFor = (
    located: LocatedMessage,
    principalId: string,
    revision: string,
    recognized: ReadonlySet<string>,
): MessageSnapshot => {
    const message = located.message as MessageQueryHostMessage
    const stateRoot = plainRecord(message.pluginMessageState) ? message.pluginMessageState : undefined
    const own = stateRoot && plainRecord(Object.getOwnPropertyDescriptor(stateRoot, principalId)?.value)
        ? Object.getOwnPropertyDescriptor(stateRoot, principalId)!.value as Record<string, unknown>
        : undefined
    const updatedAt = Math.max(
        typeof message.time === 'number' ? message.time : 0,
        typeof message.pluginMessageUpdatedAt === 'number' ? message.pluginMessageUpdatedAt : 0,
        typeof own?.updatedAt === 'number' ? own.updatedAt : 0,
    )
    const result: MessageSnapshot = {
        characterId: located.character.chaId,
        conversationId: located.chat.id,
        messageId: message.chatId!,
        role: message.role,
        content: projectMessageContent(message.data, recognized),
        revision,
        updatedAt,
        callerPluginState: {
            metadata: cloneCallerMessageMetadata(message, principalId),
            attachments: projectCallerAttachments(message.data, recognized, own?.attachments),
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

let mutationTail: Promise<void> = Promise.resolve()

export const withMessageMutationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationTail
    let release!: () => void
    mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
        return await operation()
    } finally {
        release()
    }
}

const restoreAfterFailure = (
    dependencies: RisuMessagePatchAdapterDependencies,
    request: PreparedMessagePatch,
    stagedBaseline: SourceBaseline,
    previous: {
        data: string
        hadMessageState: boolean
        hadOwnState: boolean
        ownState: unknown
        updatedAt: unknown
        receiptsWereUndefined: boolean
        replacedReceipt?: PersistedMessagePatchReceipt
    },
    receipt: PersistedMessagePatchReceipt,
) => {
    if (!sameSource(dependencies, stagedBaseline)) return
    try {
        const root = dependencies.getDatabase()
        const located = findMessage(root, request.input.target)
        located.message.data = previous.data
        const currentState = located.message.pluginMessageState === undefined
            ? {}
            : cloneJson(located.message.pluginMessageState)
        if (!plainRecord(currentState)) throw new Error('Invalid live plugin state')
        if (previous.hadOwnState) {
            Object.defineProperty(currentState, request.principalId, {
                value: previous.ownState,
                enumerable: true,
                configurable: true,
                writable: true,
            })
        } else {
            delete currentState[request.principalId]
        }
        if (!previous.hadMessageState && Object.keys(currentState).length === 0) {
            delete located.message.pluginMessageState
        } else {
            located.message.pluginMessageState = currentState
        }
        if (previous.updatedAt === undefined) delete located.message.pluginMessageUpdatedAt
        else located.message.pluginMessageUpdatedAt = previous.updatedAt
        const current = readReceipts(root).filter((candidate) => !(candidate.principalId === receipt.principalId
            && candidate.operation === receipt.operation
            && candidate.idempotencyKey === receipt.idempotencyKey
            && candidate.digest === receipt.digest
            && candidate.completedAt === receipt.completedAt))
        if (previous.replacedReceipt && !current.some((candidate) => candidate.principalId === receipt.principalId
            && candidate.operation === receipt.operation
            && candidate.idempotencyKey === receipt.idempotencyKey)) current.push(previous.replacedReceipt)
        if (previous.receiptsWereUndefined && current.length === 0) delete root.pluginMessagePatchReceipts
        else root.pluginMessagePatchReceipts = current
        dependencies.requestDatabaseSaveNow?.()
    } catch {
        dependencies.requestDatabaseSaveNow?.()
    }
}

export function createRisuMessagePatchAdapter(
    dependencies: RisuMessagePatchAdapterDependencies,
): MessagePatchHostAdapter {
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

        patchCurrentMessage: (request) => withMessageMutationLock(async () => {
            ensureBoundary(dependencies, request)
            const initialRoot = dependencies.getDatabase()
            const initialConversation = findConversation(initialRoot, request.input.target)
            if (!initialConversation) throw notFound()
            if (isColdPointer(initialConversation.messages, dependencies.coldStorageHeader)) {
                try {
                    await dependencies.preLoadChat(initialConversation.characterIndex, initialConversation.chatIndex)
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
                if (!hydrated
                    || isColdPointer(hydrated.messages, dependencies.coldStorageHeader)
                    || isSyntheticColdFailure(hydrated.messages)) throw conflict()
            }
            if (request.signal.aborted) throw new PluginApiError('ABORTED', 'Operation aborted')
            if (!sameCurrent(dependencies, request.input.target)) {
                throw new PluginApiError('PERMISSION_DENIED', 'Message target is not current')
            }

            const root = dependencies.getDatabase()
            const hydratedConversation = findConversation(root, request.input.target)
            if (!hydratedConversation) throw notFound()
            const receipts = readReceipts(root)
            const replay = existingReplay(receipts, request, now())
            if (replay) return replay

            const located = findMessage(root, request.input.target)
            const baseline = captureBaseline(located)
            let originalRevision: string
            try {
                originalRevision = await revision(messageRevisionValue(located.message as MessageQueryHostMessage))
            } catch (error) {
                throw classifyBoundaryError(dependencies, request, error, 'Message revision', baseline)
            }
            ensureBoundary(dependencies, request, baseline)
            if (originalRevision !== request.input.expectedRevision) throw conflict('Message revision is stale')

            let recognized: ReadonlySet<string>
            try {
                const assets = await dependencies.listInlayAssets()
                recognized = new Set(assets.flatMap((entry) => Array.isArray(entry) && nonEmpty(entry[0])
                    ? [entry[0]] : []))
            } catch (error) {
                throw classifyBoundaryError(dependencies, request, error, 'Message Inlay projection', baseline)
            }
            ensureBoundary(dependencies, request, baseline)

            const patch = request.input.patch
            const mutationInlayIds = patch.op === 'detachOwnInlay'
                ? [patch.inlayId]
                : patch.op === 'attachInlay'
                    ? [
                        patch.inlayId,
                        ...(patch.placement.kind === 'replace-own-inlay'
                            ? [patch.placement.inlayId] : []),
                    ]
                    : []
            if (patch.op === 'attachInlay'
                && patch.placement.kind === 'replace-own-inlay'
                && patch.inlayId === patch.placement.inlayId) {
                throw conflict('Replacement Inlay must be different')
            }
            recognized = new Set([...recognized, ...mutationInlayIds])

            const ownDescriptor = plainRecord(located.message.pluginMessageState)
                ? Object.getOwnPropertyDescriptor(located.message.pluginMessageState, request.principalId)
                : undefined
            const previous = {
                data: located.message.data,
                hadMessageState: located.message.pluginMessageState !== undefined,
                hadOwnState: !!ownDescriptor,
                ownState: ownDescriptor && Object.hasOwn(ownDescriptor, 'value')
                    ? cloneJson(ownDescriptor.value)
                    : undefined,
                updatedAt: located.message.pluginMessageUpdatedAt,
                receiptsWereUndefined: root.pluginMessagePatchReceipts === undefined,
                replacedReceipt: receipts.find((candidate) => candidate.principalId === request.principalId
                    && candidate.operation === OPERATION
                    && candidate.idempotencyKey === request.input.idempotencyKey),
            }
            const prepared = callerState(located.message, request.principalId)
            const metadata = cloneJson(prepared.state.metadata)
            const attachments = cloneJson(prepared.state.attachments)
            let nextData = located.message.data
            let changed = false
            if (patch.op === 'setPluginMetadata') {
                const previousValue = Object.getOwnPropertyDescriptor(metadata, patch.key)?.value
                changed = !Object.hasOwn(metadata, patch.key)
                    || canonicalJson(previousValue) !== canonicalJson(patch.value)
                Object.defineProperty(metadata, patch.key, {
                    value: cloneJson(patch.value),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                })
            } else if (patch.op === 'attachInlay') {
                const projection = projectLogicalContent(nextData, recognized)
                if (storedAttachmentIndexes(attachments, patch.inlayId).length > 0
                    || projection.markers.some((marker) => marker.id === patch.inlayId)) {
                    throw conflict('Inlay is already attached to this message')
                }
                const descriptor = attachedDescriptor(patch)
                if (patch.placement.kind === 'replace-own-inlay') {
                    const existing = managedAttachment(
                        nextData,
                        recognized,
                        attachments,
                        patch.placement.inlayId,
                    )
                    attachments.splice(existing.index, 1, descriptor)
                    nextData = nextData.slice(0, existing.marker.rawStart)
                        + `{{inlay::${patch.inlayId}}}`
                        + nextData.slice(existing.marker.rawEnd)
                } else {
                    const insertionOffset = resolveLogicalInsertionOffset(
                        nextData,
                        recognized,
                        patch.placement,
                    )
                    if (insertionOffset === null) {
                        throw new PluginApiError('INVALID_ARGUMENT', 'Invalid logical UTF-16 placement')
                    }
                    attachments.push(descriptor)
                    nextData = nextData.slice(0, insertionOffset)
                        + `{{inlay::${patch.inlayId}}}`
                        + nextData.slice(insertionOffset)
                }
                changed = true
            } else {
                const existing = managedAttachment(
                    nextData,
                    recognized,
                    attachments,
                    patch.inlayId,
                )
                attachments.splice(existing.index, 1)
                nextData = nextData.slice(0, existing.marker.rawStart)
                    + nextData.slice(existing.marker.rawEnd)
                changed = true
            }
            const timestamp = now()
            const nextState = {
                ...prepared.state,
                metadata,
                attachments,
                ...(changed ? { updatedAt: timestamp } : {}),
            }
            validateCallerState(nextState)
            if (changed) {
                Object.defineProperty(prepared.root, request.principalId, {
                    value: nextState,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                })
            }
            const stagedMessage = {
                ...located.message,
                ...(changed ? {
                    data: nextData,
                    pluginMessageState: prepared.root,
                    pluginMessageUpdatedAt: timestamp,
                } : {}),
            }
            let nextRevision: string
            try {
                nextRevision = await revision(messageRevisionValue(stagedMessage as MessageQueryHostMessage))
            } catch (error) {
                throw classifyBoundaryError(dependencies, request, error, 'Message revision', baseline)
            }
            ensureBoundary(dependencies, request, baseline)
            for (const id of new Set(mutationInlayIds)) {
                await assertOwnedInlay(dependencies, request, baseline, id)
            }
            ensureBoundary(dependencies, request, baseline)

            const stagedLocated: LocatedMessage = { ...located, message: stagedMessage }
            const result: MessagePatchResult = {
                changed,
                message: snapshotFor(stagedLocated, request.principalId, nextRevision, recognized),
                commitId: createId(),
            }
            const completedAt = now()
            const receipt: PersistedMessagePatchReceipt = {
                version: RECEIPT_VERSION,
                principalId: request.principalId,
                operation: OPERATION,
                idempotencyKey: request.input.idempotencyKey,
                digest: request.argumentDigest,
                target: cloneJson(request.input.target),
                result: cloneJson(result),
                completedAt,
                expiresAt: completedAt + RECEIPT_RETENTION_MS,
            }
            const retained = receipts.filter((candidate) => now() <= candidate.expiresAt
                && !(candidate.principalId === request.principalId
                    && candidate.operation === OPERATION
                    && candidate.idempotencyKey === request.input.idempotencyKey))
            if (retained.filter((candidate) => candidate.principalId === request.principalId).length
                >= MAX_RECEIPTS_PER_PRINCIPAL) {
                throw new PluginApiError('RESOURCE_LIMIT', 'Message patch receipt capacity is full', {
                    retryable: true,
                })
            }
            ensureBoundary(dependencies, request, baseline)
            if (changed) {
                located.message.data = stagedMessage.data
                located.message.pluginMessageState = prepared.root
                located.message.pluginMessageUpdatedAt = timestamp
            }
            root.pluginMessagePatchReceipts = [...retained, receipt]
            const stagedBaseline = captureBaseline(findMessage(root, request.input.target))

            try {
                await dependencies.waitForMessagePersistence(request.input.target, nextRevision)
            } catch (error) {
                const classified = classifyBoundaryError(
                    dependencies,
                    request,
                    error,
                    'Message persistence',
                    stagedBaseline,
                )
                restoreAfterFailure(dependencies, request, stagedBaseline, previous, receipt)
                throw classified
            }
            try {
                ensureBoundary(dependencies, request, stagedBaseline)
            } catch (error) {
                restoreAfterFailure(dependencies, request, stagedBaseline, previous, receipt)
                throw error
            }
            return result
        }),
    }
}

interface PersistenceWaiterRecord {
    target: MessageRef
    revision: string
    resolve(): void
    reject(error: unknown): void
}

export interface MessagePersistenceBatch {
    readonly records: PersistenceWaiterRecord[]
}

export class MessagePersistenceWaiter {
    private readonly pending = new Set<PersistenceWaiterRecord>()

    constructor(
        private readonly revision: (value: unknown) => Promise<string> = createCanonicalRevision,
    ) {}

    hasPending() {
        return this.pending.size > 0
    }

    wait(target: MessageRef, revision: string) {
        return new Promise<void>((resolve, reject) => {
            this.pending.add({ target: { ...target }, revision, resolve, reject })
        })
    }

    async capture(database: DatabaseRoot): Promise<MessagePersistenceBatch> {
        const records: PersistenceWaiterRecord[] = []
        for (const record of [...this.pending]) {
            let located: LocatedMessage
            try {
                located = findMessage(database, record.target)
            } catch {
                this.pending.delete(record)
                record.reject(conflict('Persistence candidate is stale'))
                continue
            }
            let revision: string
            try {
                revision = await this.revision(messageRevisionValue(located.message as MessageQueryHostMessage))
            } catch (error) {
                this.pending.delete(record)
                record.reject(error instanceof PluginApiError ? error : internal('Persistence candidate revision failed'))
                continue
            }
            if (revision !== record.revision) {
                this.pending.delete(record)
                record.reject(conflict('Persistence candidate is stale'))
                continue
            }
            this.pending.delete(record)
            records.push(record)
        }
        return { records }
    }

    acknowledge(batch: MessagePersistenceBatch) {
        for (const record of batch.records) record.resolve()
    }

    release(batch: MessagePersistenceBatch) {
        for (const record of batch.records) this.pending.add(record)
    }

    fail(batch: MessagePersistenceBatch, error: unknown) {
        for (const record of batch.records) record.reject(error)
    }
}

export const messagePersistenceWaiter = new MessagePersistenceWaiter()
