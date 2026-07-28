import { PluginApiError } from './errors'
import { canonicalArgumentsDigest, IdempotencyLedger } from './idempotency'
import { assertLimit, assertUtf8Limit } from './limits'
import { MessageMutationRateLimiter } from './messagePatch'
import type { MessageRef, MessageSnapshot, PluginJsonValue } from './messageQuery'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'
import { validateJsonLimits } from './revision'

export const INLAY_ATOMIC_ATTACH_CAPABILITY_IDS = ['inlay.atomic-attach.v1'] as const

const OPERATION = INLAY_ATOMIC_ATTACH_CAPABILITY_IDS[0]
const MAX_INPUT_BYTES = 33_554_432
const MAX_NAME_BYTES = 255
const MAX_METADATA_BYTES = 65_536

export type InlayAtomicPlacement =
    | { kind: 'end' }
    | { kind: 'utf16-offset'; offset: number }

export interface InlayAtomicAttachInput {
    target: MessageRef
    expectedMessageRevision: string
    data: Uint8Array
    inlay: { name: string }
    presentation: 'inline'
    placement: InlayAtomicPlacement
    attachmentMetadata: PluginJsonValue
    messageMetadata: [{ key: string; value: PluginJsonValue }]
    idempotencyKey: string
    persist: 'immediate'
}

export interface InlayAtomicAttachResult {
    inlay: { id: string; revision: string; name: string }
    message: MessageSnapshot
    commitId: string
}

export interface PreparedInlayAtomicAttach {
    principalId: string
    input: InlayAtomicAttachInput
    argumentDigest: string
    signal: AbortSignal
}

export interface InlayAtomicAttachHostAdapter {
    current(): Pick<MessageRef, 'characterId' | 'conversationId'> | null
    attachCurrentMessage(request: PreparedInlayAtomicAttach): Promise<InlayAtomicAttachResult>
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

const singleEntry = (value: unknown) => {
    if (!Array.isArray(value)) invalid('messageMetadata must contain exactly one entry')
    const entries = value as unknown[]
    if (Object.getPrototypeOf(entries) !== Array.prototype || entries.length !== 1) {
        invalid('messageMetadata must contain exactly one entry')
    }
    const keys = Reflect.ownKeys(entries)
    const item = Object.getOwnPropertyDescriptor(entries, '0')
    if (keys.length !== 2 || !keys.includes('length') || !item?.enumerable || !Object.hasOwn(item, 'value')) {
        invalid('Invalid messageMetadata')
    }
    return item.value
}

const cloneJson = (value: unknown) => JSON.parse(validateJsonLimits(value, {
    maxDepth: 32, maxBytes: MAX_METADATA_BYTES,
})) as PluginJsonValue

const normalize = (raw: unknown): InlayAtomicAttachInput => {
    const input = ownObject(raw, [
        'target', 'expectedMessageRevision', 'data', 'inlay', 'presentation', 'placement',
        'attachmentMetadata', 'messageMetadata', 'idempotencyKey', 'persist',
    ], 'atomic Inlay attachment')
    const targetValue = ownObject(input.target, ['characterId', 'conversationId', 'messageId'], 'message target')
    const target = {
        characterId: requiredString(targetValue.characterId, 'characterId'),
        conversationId: requiredString(targetValue.conversationId, 'conversationId'),
        messageId: requiredString(targetValue.messageId, 'messageId'),
    }
    if (target.messageId.startsWith('legacy-message:')) {
        throw new PluginApiError('CONFLICT', 'Stable messageId is required', { retryable: true })
    }
    const sourceData = input.data
    if (!(sourceData instanceof Uint8Array)) invalid('data must be an exact Uint8Array')
    if (Object.getPrototypeOf(sourceData) !== Uint8Array.prototype) {
        invalid('data must be an exact Uint8Array')
    }
    const data = Uint8Array.from(sourceData as Uint8Array)
    assertLimit(data.byteLength, MAX_INPUT_BYTES, 'data')
    const inlayValue = ownObject(input.inlay, ['name'], 'Inlay options')
    const name = requiredString(inlayValue.name, 'Inlay name')
    assertUtf8Limit(name, MAX_NAME_BYTES, 'Inlay name')
    if (input.presentation !== 'inline') invalid('Only inline presentation is supported')
    const placementValue = ownObject(input.placement, ['kind', 'offset'], 'Inlay placement')
    let placement: InlayAtomicPlacement
    if (placementValue.kind === 'end') {
        if (Object.hasOwn(placementValue, 'offset')) invalid('Invalid end placement')
        placement = { kind: 'end' }
    } else if (placementValue.kind === 'utf16-offset') {
        if (!Number.isSafeInteger(placementValue.offset) || (placementValue.offset as number) < 0) {
            invalid('Invalid UTF-16 offset')
        }
        placement = { kind: 'utf16-offset', offset: placementValue.offset as number }
    } else invalid('Unsupported Inlay placement')
    const metadataValue = ownObject(singleEntry(input.messageMetadata), ['key', 'value'], 'message metadata entry')
    const key = requiredString(metadataValue.key, 'metadata key')
    const attachmentMetadata = cloneJson(input.attachmentMetadata)
    const messageValue = cloneJson(metadataValue.value)
    const expectedMessageRevision = requiredString(input.expectedMessageRevision, 'expectedMessageRevision')
    const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey')
    assertUtf8Limit(idempotencyKey, 256, 'idempotencyKey')
    if (input.persist !== 'immediate') invalid('Only immediate persistence is supported')
    return {
        target,
        expectedMessageRevision,
        data,
        inlay: { name },
        presentation: 'inline',
        placement,
        attachmentMetadata,
        messageMetadata: [{ key, value: messageValue }],
        idempotencyKey,
        persist: 'immediate',
    }
}

const sameCurrent = (adapter: InlayAtomicAttachHostAdapter, target: MessageRef) => {
    const current = adapter.current()
    return current?.characterId === target.characterId && current.conversationId === target.conversationId
}

const sharedLedger = new IdempotencyLedger()
const sharedRateLimiter = new MessageMutationRateLimiter()

export class InlayAtomicAttachService {
    private readonly ledger: IdempotencyLedger
    private readonly rateLimiter: MessageMutationRateLimiter

    constructor(
        private readonly context: PluginExecutionContext,
        private readonly adapter: InlayAtomicAttachHostAdapter,
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

    async attachGeneratedInlayToMessage(rawInput: InlayAtomicAttachInput): Promise<InlayAtomicAttachResult> {
        this.ensureActive()
        const input = normalize(rawInput)
        this.ensureCurrent(input.target)
        for (const permission of ['chatWrite', 'inlayWrite'] as const) {
            try {
                await this.options.requirePermission(this.context, permission)
            } catch (error) {
                this.rejectAfterBoundary(error, input.target, 'Atomic Inlay permission check')
            }
            this.ensureActive()
            this.ensureCurrent(input.target)
        }
        let argumentDigest: string
        try {
            argumentDigest = await (this.options.digest ?? canonicalArgumentsDigest)(input)
        } catch (error) {
            this.rejectAfterBoundary(error, input.target, 'Atomic Inlay digest')
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
                        const attached = await this.adapter.attachCurrentMessage({
                            principalId: this.context.principalId,
                            input,
                            argumentDigest,
                            signal: this.context.signal,
                        })
                        this.ensureActive()
                        this.ensureCurrent(input.target)
                        return attached
                    } catch (error) {
                        this.rejectAfterBoundary(error, input.target, 'Atomic Inlay dependency')
                    }
                },
            )
        } catch (error) {
            this.rejectAfterBoundary(error, input.target, 'Atomic Inlay idempotency')
        }
    }
}
