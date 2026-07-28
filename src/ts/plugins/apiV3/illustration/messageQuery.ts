import { PluginApiError } from './errors'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'
import { canonicalJson, createRevision as createCanonicalRevision, validateJsonLimits } from './revision'

export const MESSAGE_QUERY_CAPABILITY_IDS = ['chat.message-query.v1'] as const

const DEFAULT_RECENT_LIMIT = 8
const MAX_RECENT_LIMIT = 32
const DEFAULT_RECENT_UTF16 = 12_000
const MAX_RECENT_UTF16 = 65_536
const MAX_SNAPSHOT_UTF16 = 262_144
const MAX_SNAPSHOT_JSON_BYTES = 2_097_152
const MAX_CALLER_METADATA_JSON_BYTES = 65_536

export interface MessageRef {
    characterId: string
    conversationId: string
    messageId: string
}

export type PluginJsonValue = null | boolean | number | string | PluginJsonValue[] | {
    [key: string]: PluginJsonValue
}

export interface MessageQueryHostMessage {
    role: 'user' | 'char'
    data: string
    saying?: string
    chatId?: string
    time?: number
    generationInfo?: { generationId?: string }
    pluginMessageState?: unknown
    pluginMessageUpdatedAt?: number
}

export interface MessageQueryConversationLocation {
    rootEpoch: object
    characterEpoch: object
    conversationEpoch: object
    messages: MessageQueryHostMessage[]
    characterId: string
    conversationId: string
    currentCharacterId: string
    memberCharacterIds?: string[]
    memberCharacterEpochs?: object[]
    isStreaming?: boolean
}

export interface MessageQueryHostAdapter {
    current(): { characterId: string; conversationId: string } | null
    prepareConversation(target: { characterId: string; conversationId: string }): Promise<void>
    resolveConversation(target: {
        characterId: string
        conversationId: string
    }): MessageQueryConversationLocation | undefined
    recognizedInlayIds(): Promise<ReadonlySet<string>>
}

export interface MessageSnapshot extends MessageRef {
    role: 'user' | 'char'
    speakerCharacterId?: string
    content: string
    revision: string
    generationId?: string
    createdAt?: number
    updatedAt: number
    callerPluginState: { metadata: Record<string, PluginJsonValue>; attachments: never[] }
}

type QueryKind =
    | { kind: 'exact'; messageId: string }
    | { kind: 'latest'; role: 'user' | 'char' }
    | { kind: 'recent'; beforeId: string; roles: Array<'user' | 'char'> }

type SelectedMessage = { message: MessageQueryHostMessage; index: number }

interface QueryBaseline {
    target: { characterId: string; conversationId: string }
    query: QueryKind
    location: MessageQueryConversationLocation
    sourceSignature: string
    selection: SelectedMessage[]
}

type PermissionScope = { value: 'current' | 'all' }

const encoder = new TextEncoder()

const conflict = () => new PluginApiError('CONFLICT', 'Message query state changed; retry the request', {
    retryable: true,
    details: { reason: 'message-query-changed' },
})

const notFound = () => new PluginApiError('NOT_FOUND', 'Committed message was not found')

const requireNonEmpty = (value: unknown, name: string) => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new PluginApiError('INVALID_ARGUMENT', `${name} must be a non-empty string`)
    }
    return value
}

const isStableMessageId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && !value.startsWith('legacy-message:')

export const messageRevisionValue = (message: MessageQueryHostMessage) => ({
    role: message.role,
    data: message.data,
    saying: message.saying ?? null,
    generationId: message.generationInfo?.generationId ?? null,
    pluginMessageState: message.pluginMessageState ?? {},
})

const canonicalMessageSource = (message: MessageQueryHostMessage) => canonicalJson([
    message.chatId ?? null,
    messageRevisionValue(message),
    message.time ?? null,
    message.pluginMessageUpdatedAt ?? null,
])

const sourceSignature = (location: MessageQueryConversationLocation) => JSON.stringify({
    currentCharacterId: location.currentCharacterId,
    memberCharacterIds: location.memberCharacterIds ?? null,
    isStreaming: location.isStreaming === true,
    messages: location.messages.map(canonicalMessageSource),
})

export const projectMessageContent = (raw: string, recognized: ReadonlySet<string>) =>
    raw.replace(/\{\{(?:inlay|inlayed|inlayeddata)::([^{}]+)\}\}/gu, (token, id: string) =>
        recognized.has(id) ? '' : token)

const plainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const descriptorValue = (record: Record<string, unknown>, key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor) return undefined
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new PluginApiError('INTERNAL', 'Plugin message state is invalid', { retryable: true })
    }
    return descriptor.value
}

export const cloneCallerMessageMetadata = (
    message: MessageQueryHostMessage,
    principalId: string,
): Record<string, PluginJsonValue> => {
    const root = message.pluginMessageState
    if (root === undefined) return {}
    if (!plainRecord(root)) {
        throw new PluginApiError('INTERNAL', 'Plugin message state is invalid', { retryable: true })
    }
    const state = descriptorValue(root, principalId)
    if (state === undefined) return {}
    if (!plainRecord(state)) {
        throw new PluginApiError('INTERNAL', 'Caller message state is invalid', { retryable: true })
    }
    const metadata = descriptorValue(state, 'metadata')
    if (!plainRecord(metadata)) {
        throw new PluginApiError('INTERNAL', 'Caller message state is invalid', { retryable: true })
    }
    try {
        return JSON.parse(validateJsonLimits(metadata, {
            maxDepth: 32,
            maxBytes: MAX_CALLER_METADATA_JSON_BYTES,
        })) as Record<string, PluginJsonValue>
    } catch (error) {
        if (error instanceof PluginApiError && error.code === 'RESOURCE_LIMIT') throw error
        throw new PluginApiError('INTERNAL', 'Caller message state is invalid', { retryable: true })
    }
}

function normalizeRoles(value: Array<'user' | 'char'> | undefined) {
    if (value === undefined) return ['user', 'char'] as Array<'user' | 'char'>
    if (!Array.isArray(value) || value.length === 0
        || value.some((role) => role !== 'user' && role !== 'char')) {
        throw new PluginApiError('INVALID_ARGUMENT', 'roles must contain user and/or char')
    }
    return [...new Set(value)]
}

function assertSnapshotLimits(snapshot: MessageSnapshot) {
    if (snapshot.content.length > MAX_SNAPSHOT_UTF16) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Message content exceeds snapshot limit', {
            details: { contentUtf16: snapshot.content.length },
        })
    }
    if (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_JSON_BYTES) {
        throw new PluginApiError('RESOURCE_LIMIT', 'Message snapshot exceeds serialized limit')
    }
}

export class MessageQueryService {
    private readonly requirePermission: (
        context: PluginExecutionContext,
        permission: PluginPermissionId,
    ) => Promise<void>
    private readonly createRevision: (value: unknown) => Promise<string>

    constructor(
        private readonly context: PluginExecutionContext,
        private readonly adapter: MessageQueryHostAdapter,
        options: {
            requirePermission: (
                context: PluginExecutionContext,
                permission: PluginPermissionId,
            ) => Promise<void>
            createRevision?: (value: unknown) => Promise<string>
        },
    ) {
        this.requirePermission = options.requirePermission
        this.createRevision = options.createRevision ?? createCanonicalRevision
    }

    private ensureActive() {
        if (this.context.signal.aborted) {
            throw new PluginApiError('ABORTED', 'Plugin instance is unloaded')
        }
    }

    private isCurrent(target: { characterId: string; conversationId: string }) {
        const current = this.adapter.current()
        return current?.characterId === target.characterId
            && current.conversationId === target.conversationId
    }

    private async authorize(target: { characterId: string; conversationId: string }): Promise<PermissionScope> {
        this.ensureActive()
        if (!this.isCurrent(target)) {
            await this.requirePermission(this.context, 'chatObserveAll')
            this.ensureActive()
            return { value: 'all' }
        }
        await this.requirePermission(this.context, 'chatObserve')
        this.ensureActive()
        if (this.isCurrent(target)) return { value: 'current' }
        await this.requirePermission(this.context, 'chatObserveAll')
        this.ensureActive()
        return { value: 'all' }
    }

    private resolve(target: { characterId: string; conversationId: string }) {
        const location = this.adapter.resolveConversation(target)
        if (!location) throw notFound()
        if (location.characterId !== target.characterId
            || location.conversationId !== target.conversationId
            || !Array.isArray(location.messages)
            || (location.memberCharacterIds === undefined) !== (location.memberCharacterEpochs === undefined)
            || location.memberCharacterIds?.length !== location.memberCharacterEpochs?.length) throw conflict()
        return location
    }

    private select(location: MessageQueryConversationLocation, query: QueryKind): SelectedMessage[] {
        if (query.kind === 'exact') {
            if (!isStableMessageId(query.messageId)) throw notFound()
            const matches = location.messages.flatMap((message, index) =>
                message.chatId === query.messageId ? [{ message, index }] : [])
            if (matches.length !== 1) throw notFound()
            if (location.isStreaming
                && matches[0].index === location.messages.length - 1
                && matches[0].message.role === 'char') throw conflict()
            return matches
        }

        if (query.kind === 'latest') {
            for (let index = location.messages.length - 1; index >= 0; index--) {
                const message = location.messages[index]
                if (message.role !== query.role) continue
                if (location.isStreaming && index === location.messages.length - 1 && message.role === 'char') continue
                if (!isStableMessageId(message.chatId)) throw notFound()
                if (location.messages.filter((candidate) => candidate.chatId === message.chatId).length !== 1) throw notFound()
                return [{ message, index }]
            }
            return []
        }

        if (!isStableMessageId(query.beforeId)) throw notFound()
        const beforeMatches = location.messages.flatMap((message, index) =>
            message.chatId === query.beforeId ? [{ message, index }] : [])
        if (beforeMatches.length !== 1) throw notFound()
        if (location.isStreaming
            && beforeMatches[0].index === location.messages.length - 1
            && beforeMatches[0].message.role === 'char') throw conflict()
        const selected: SelectedMessage[] = []
        for (let index = 0; index < beforeMatches[0].index; index++) {
            const message = location.messages[index]
            if (!query.roles.includes(message.role)) continue
            if (location.isStreaming && index === location.messages.length - 1 && message.role === 'char') continue
            if (!isStableMessageId(message.chatId)) throw notFound()
            if (location.messages.filter((candidate) => candidate.chatId === message.chatId).length !== 1) throw notFound()
            selected.push({ message, index })
        }
        return selected
    }

    private capture(
        target: { characterId: string; conversationId: string },
        query: QueryKind,
    ): QueryBaseline {
        const location = this.resolve(target)
        return {
            target,
            query,
            location,
            sourceSignature: sourceSignature(location),
            selection: this.select(location, query),
        }
    }

    private revalidate(baseline: QueryBaseline) {
        const location = this.adapter.resolveConversation(baseline.target)
        if (!location
            || location.rootEpoch !== baseline.location.rootEpoch
            || location.characterEpoch !== baseline.location.characterEpoch
            || location.conversationEpoch !== baseline.location.conversationEpoch
            || location.messages !== baseline.location.messages
            || location.characterId !== baseline.location.characterId
            || location.conversationId !== baseline.location.conversationId
            || sourceSignature(location) !== baseline.sourceSignature) throw conflict()
        const baselineMemberEpochs = baseline.location.memberCharacterEpochs ?? []
        const currentMemberEpochs = location.memberCharacterEpochs ?? []
        if (currentMemberEpochs.length !== baselineMemberEpochs.length
            || currentMemberEpochs.some((epoch, index) => epoch !== baselineMemberEpochs[index])) throw conflict()
        let selection: SelectedMessage[]
        try {
            selection = this.select(location, baseline.query)
        } catch {
            throw conflict()
        }
        if (selection.length !== baseline.selection.length
            || selection.some((entry, index) => entry.index !== baseline.selection[index].index
                || entry.message !== baseline.selection[index].message)) throw conflict()
    }

    private async stabilizeScope(
        scope: PermissionScope,
        target: { characterId: string; conversationId: string },
        baseline?: QueryBaseline,
    ) {
        if (scope.value === 'all' || this.isCurrent(target)) return
        await this.requirePermission(this.context, 'chatObserveAll')
        if (baseline) this.revalidate(baseline)
        this.ensureActive()
        scope.value = 'all'
    }

    private async awaitBoundary<T>(
        operation: Promise<T>,
        baseline: QueryBaseline,
        scope: PermissionScope,
    ) {
        try {
            const result = await operation
            this.revalidate(baseline)
            this.ensureActive()
            await this.stabilizeScope(scope, baseline.target, baseline)
            this.revalidate(baseline)
            this.ensureActive()
            return result
        } catch (error) {
            this.revalidate(baseline)
            this.ensureActive()
            throw error
        }
    }

    private async prepare(
        target: { characterId: string; conversationId: string },
        query: QueryKind,
    ) {
        const scope = await this.authorize(target)
        try {
            await this.adapter.prepareConversation(target)
        } catch (error) {
            this.ensureActive()
            if (error instanceof PluginApiError) throw error
            throw conflict()
        }
        this.ensureActive()
        await this.stabilizeScope(scope, target)
        this.ensureActive()
        return { baseline: this.capture(target, query), scope }
    }

    private async snapshot(
        baseline: QueryBaseline,
        scope: PermissionScope,
        selected: SelectedMessage,
        recognizedInlayIds: ReadonlySet<string>,
    ): Promise<MessageSnapshot> {
        const message = selected.message
        const messageId = message.chatId
        if (!isStableMessageId(messageId)) throw notFound()
        const revision = await this.awaitBoundary(this.createRevision(messageRevisionValue(message)), baseline, scope)
        const stateRoot = plainRecord(message.pluginMessageState) ? message.pluginMessageState : undefined
        const callerState = stateRoot && plainRecord(descriptorValue(stateRoot, this.context.principalId))
            ? descriptorValue(stateRoot, this.context.principalId) as Record<string, unknown>
            : undefined
        const callerUpdatedAt = callerState && typeof descriptorValue(callerState, 'updatedAt') === 'number'
            ? descriptorValue(callerState, 'updatedAt') as number
            : 0
        const result: MessageSnapshot = {
            characterId: baseline.location.characterId,
            conversationId: baseline.location.conversationId,
            messageId,
            role: message.role,
            content: projectMessageContent(message.data, recognizedInlayIds),
            revision,
            updatedAt: Math.max(
                typeof message.time === 'number' ? message.time : 0,
                typeof message.pluginMessageUpdatedAt === 'number' ? message.pluginMessageUpdatedAt : 0,
                callerUpdatedAt,
            ),
            callerPluginState: {
                metadata: cloneCallerMessageMetadata(message, this.context.principalId),
                attachments: [],
            },
        }
        if (message.role === 'char') {
            if (baseline.location.memberCharacterIds === undefined) {
                result.speakerCharacterId = baseline.location.currentCharacterId
            } else if (typeof message.saying === 'string'
                && baseline.location.memberCharacterIds.includes(message.saying)) {
                result.speakerCharacterId = message.saying
            }
        }
        if (typeof message.generationInfo?.generationId === 'string') {
            result.generationId = message.generationInfo.generationId
        }
        if (typeof message.time === 'number') result.createdAt = message.time
        assertSnapshotLimits(result)
        return result
    }

    async getMessageSnapshot(target: MessageRef): Promise<MessageSnapshot> {
        if (!target) throw new PluginApiError('INVALID_ARGUMENT', 'target is required')
        const normalized = {
            characterId: requireNonEmpty(target.characterId, 'characterId'),
            conversationId: requireNonEmpty(target.conversationId, 'conversationId'),
        }
        const { baseline, scope } = await this.prepare(normalized, {
            kind: 'exact', messageId: requireNonEmpty(target.messageId, 'messageId'),
        })
        const recognized = await this.awaitBoundary(this.adapter.recognizedInlayIds(), baseline, scope)
        return this.snapshot(baseline, scope, baseline.selection[0], recognized)
    }

    async getLatestCommittedMessage(options: {
        characterId?: string
        conversationId?: string
        role?: 'user' | 'char'
    } = {}): Promise<MessageSnapshot | null> {
        const current = this.adapter.current()
        const target = {
            characterId: options.characterId ?? current?.characterId,
            conversationId: options.conversationId ?? current?.conversationId,
        }
        if (!target.characterId || !target.conversationId) throw notFound()
        const role = options.role ?? 'char'
        if (role !== 'user' && role !== 'char') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid message role')
        }
        const { baseline, scope } = await this.prepare({
            characterId: target.characterId,
            conversationId: target.conversationId,
        }, { kind: 'latest', role })
        if (baseline.selection.length === 0) return null
        const recognized = await this.awaitBoundary(this.adapter.recognizedInlayIds(), baseline, scope)
        return this.snapshot(baseline, scope, baseline.selection[0], recognized)
    }

    async getRecentCommittedMessages(options: {
        before: MessageRef
        roles?: Array<'user' | 'char'>
        limit?: number
        maxTotalUtf16?: number
    }): Promise<{ items: MessageSnapshot[]; truncatedBefore: boolean }> {
        if (!options?.before) throw new PluginApiError('INVALID_ARGUMENT', 'before is required')
        const limit = options.limit ?? DEFAULT_RECENT_LIMIT
        const maxTotalUtf16 = options.maxTotalUtf16 ?? DEFAULT_RECENT_UTF16
        if (!Number.isInteger(limit) || limit < 1) {
            throw new PluginApiError('INVALID_ARGUMENT', 'limit must be positive')
        }
        if (limit > MAX_RECENT_LIMIT) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Recent message limit exceeds capability')
        }
        if (!Number.isInteger(maxTotalUtf16) || maxTotalUtf16 < 1) {
            throw new PluginApiError('INVALID_ARGUMENT', 'maxTotalUtf16 must be positive')
        }
        if (maxTotalUtf16 > MAX_RECENT_UTF16) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Recent UTF-16 budget exceeds capability')
        }
        const target = {
            characterId: requireNonEmpty(options.before.characterId, 'characterId'),
            conversationId: requireNonEmpty(options.before.conversationId, 'conversationId'),
        }
        const { baseline, scope } = await this.prepare(target, {
            kind: 'recent',
            beforeId: requireNonEmpty(options.before.messageId, 'messageId'),
            roles: normalizeRoles(options.roles),
        })
        const recognized = await this.awaitBoundary(this.adapter.recognizedInlayIds(), baseline, scope)
        const selected: SelectedMessage[] = []
        let totalUtf16 = 0
        let truncatedBefore = false
        for (let index = baseline.selection.length - 1; index >= 0; index--) {
            if (selected.length >= limit) {
                truncatedBefore = true
                break
            }
            const candidate = baseline.selection[index]
            const contentUtf16 = projectMessageContent(candidate.message.data, recognized).length
            if (contentUtf16 > maxTotalUtf16 - totalUtf16) {
                truncatedBefore = true
                break
            }
            selected.push(candidate)
            totalUtf16 += contentUtf16
        }
        selected.reverse()
        const items: MessageSnapshot[] = []
        for (const candidate of selected) {
            items.push(await this.snapshot(baseline, scope, candidate, recognized))
        }
        return { items, truncatedBefore }
    }
}
