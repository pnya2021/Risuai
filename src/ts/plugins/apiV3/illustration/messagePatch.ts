import { PluginApiError } from './errors'
import { canonicalArgumentsDigest, IdempotencyLedger } from './idempotency'
import { assertUtf8Limit } from './limits'
import type { MessageRef, MessageSnapshot, PluginJsonValue } from './messageQuery'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'
import { validateJsonLimits } from './revision'

export const MESSAGE_PATCH_CAPABILITY_IDS = ['chat.message-patch.v1'] as const

const OPERATION = MESSAGE_PATCH_CAPABILITY_IDS[0]
const MAX_METADATA_BYTES = 65_536
const MAX_MUTATIONS_PER_MINUTE = 30

export interface MessagePatchInput {
    target: MessageRef
    expectedRevision: string
    patch: { op: 'setPluginMetadata'; key: string; value: PluginJsonValue }
    idempotencyKey: string
    persist: 'immediate'
}

export interface MessagePatchResult {
    changed: boolean
    message: MessageSnapshot
    commitId: string
}

export interface PreparedMessagePatch {
    principalId: string
    input: MessagePatchInput
    argumentDigest: string
    signal: AbortSignal
}

export interface MessagePatchHostAdapter {
    current(): Pick<MessageRef, 'characterId' | 'conversationId'> | null
    patchCurrentMessage(request: PreparedMessagePatch): Promise<MessagePatchResult>
}

const invalid = (message: string): never => {
    throw new PluginApiError('INVALID_ARGUMENT', message)
}

const ownObject = (value: unknown, allowed: readonly string[], label: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${label}`)
    const object = value as object
    const prototype = Object.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) invalid(`Invalid ${label}`)
    const keys = Reflect.ownKeys(object)
    if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) invalid(`Invalid ${label}`)
    const result: Record<string, unknown> = {}
    for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(`Invalid ${label}`)
        Object.defineProperty(result, key, {
            value: descriptor.value, enumerable: true, configurable: true, writable: true,
        })
    }
    return result
}

const requiredString = (value: unknown, label: string) => {
    if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a non-empty string`)
    return value as string
}

const normalize = (raw: unknown): MessagePatchInput => {
    const input = ownObject(raw, ['target', 'expectedRevision', 'patch', 'idempotencyKey', 'persist'], 'message patch')
    const targetValue = ownObject(input.target, ['characterId', 'conversationId', 'messageId'], 'message target')
    const target = {
        characterId: requiredString(targetValue.characterId, 'characterId'),
        conversationId: requiredString(targetValue.conversationId, 'conversationId'),
        messageId: requiredString(targetValue.messageId, 'messageId'),
    }
    if (target.messageId.startsWith('legacy-message:')) {
        throw new PluginApiError('CONFLICT', 'Stable messageId is required', { retryable: true })
    }
    const patchValue = ownObject(input.patch, ['op', 'key', 'value'], 'message patch operation')
    if (patchValue.op !== 'setPluginMetadata') invalid('Unsupported restricted patch')
    const key = requiredString(patchValue.key, 'metadata key')
    const value = JSON.parse(validateJsonLimits(patchValue.value, {
        maxDepth: 32, maxBytes: MAX_METADATA_BYTES,
    })) as PluginJsonValue
    const expectedRevision = requiredString(input.expectedRevision, 'expectedRevision')
    const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey')
    assertUtf8Limit(idempotencyKey, 256, 'idempotencyKey')
    if (input.persist !== 'immediate') invalid('Only immediate persistence is supported')
    return {
        target,
        expectedRevision,
        patch: { op: 'setPluginMetadata', key, value },
        idempotencyKey,
        persist: 'immediate',
    }
}

const sameCurrent = (adapter: MessagePatchHostAdapter, target: MessageRef) => {
    const current = adapter.current()
    return current?.characterId === target.characterId && current.conversationId === target.conversationId
}

export class MessageMutationRateLimiter {
    private readonly attempts = new Map<string, number[]>()

    constructor(private readonly now: () => number = Date.now) {}

    consume(principalId: string) {
        const now = this.now()
        const recent = (this.attempts.get(principalId) ?? []).filter((time) => time > now - 60_000)
        if (recent.length >= MAX_MUTATIONS_PER_MINUTE) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Message mutation rate limit exceeded', {
                retryable: true,
                retryAfterMs: recent[0] + 60_000 - now,
            })
        }
        recent.push(now)
        this.attempts.set(principalId, recent)
    }
}

const sharedLedger = new IdempotencyLedger()
const sharedRateLimiter = new MessageMutationRateLimiter()

export class MessagePatchService {
    private readonly ledger: IdempotencyLedger
    private readonly rateLimiter: MessageMutationRateLimiter

    constructor(
        private readonly context: PluginExecutionContext,
        private readonly adapter: MessagePatchHostAdapter,
        private readonly options: {
            requirePermission: (context: PluginExecutionContext, permission: PluginPermissionId) => Promise<void>
            ledger?: IdempotencyLedger
            rateLimiter?: MessageMutationRateLimiter
            digest?: (value: unknown) => Promise<string>
        },
    ) {
        this.ledger = options.ledger ?? sharedLedger
        this.rateLimiter = options.rateLimiter ?? sharedRateLimiter
    }

    private ensureActive() {
        if (this.context.signal.aborted) throw new PluginApiError('ABORTED', 'Operation aborted')
    }

    private ensureCurrent(target: MessageRef) {
        if (!sameCurrent(this.adapter, target)) {
            throw new PluginApiError('PERMISSION_DENIED', 'Message target is not current')
        }
    }

    private rejectAfterBoundary(error: unknown, target: MessageRef, label: string): never {
        this.ensureActive()
        this.ensureCurrent(target)
        if (error instanceof PluginApiError) throw error
        throw new PluginApiError('INTERNAL', `${label} failed`, { retryable: true })
    }

    async patchMessage(rawInput: MessagePatchInput): Promise<MessagePatchResult> {
        this.ensureActive()
        const input = normalize(rawInput)
        this.ensureCurrent(input.target)
        try {
            await this.options.requirePermission(this.context, 'chatWrite')
        } catch (error) {
            this.rejectAfterBoundary(error, input.target, 'Message patch permission check')
        }
        this.ensureActive()
        this.ensureCurrent(input.target)
        let argumentDigest: string
        try {
            argumentDigest = await (this.options.digest ?? canonicalArgumentsDigest)(input)
        } catch (error) {
            this.rejectAfterBoundary(error, input.target, 'Message patch digest')
        }
        this.ensureActive()
        this.ensureCurrent(input.target)

        try {
            return await this.ledger.run(
                this.context.principalId,
                OPERATION,
                input.idempotencyKey,
                input,
                async () => {
                    this.ensureActive()
                    this.ensureCurrent(input.target)
                    this.rateLimiter.consume(this.context.principalId)
                    try {
                        const result = await this.adapter.patchCurrentMessage({
                            principalId: this.context.principalId,
                            input,
                            argumentDigest,
                            signal: this.context.signal,
                        })
                        this.ensureActive()
                        this.ensureCurrent(input.target)
                        return result
                    } catch (error) {
                        this.rejectAfterBoundary(error, input.target, 'Message patch dependency')
                    }
                },
            )
        } catch (error) {
            this.rejectAfterBoundary(error, input.target, 'Message patch idempotency')
        }
    }
}
