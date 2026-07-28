import { PluginApiError } from './errors'
import type { MessageRef, MessageSnapshot } from './messageQuery'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'

export const MESSAGE_EVENT_CAPABILITY_IDS = ['chat.message-events.v1'] as const

export type MessageCommitCause = 'model' | 'continue' | 'reroll' | 'trigger'
export type MessageCommitDurability = 'state' | 'persisted'

export interface MessageCommittedEventBase {
    eventId: string
    change: 'created' | 'updated'
    cause: MessageCommitCause
    durability: MessageCommitDurability
}

export type MessageCommittedEvent = MessageCommittedEventBase & (
    | { message: MessageSnapshot; unavailable?: never }
    | {
        message?: never
        unavailable: MessageRef & {
            reason: 'resource-limit'
            contentUtf16: number
            callerAttachmentCount: number
        }
    }
)

export interface CapturedMessageCommit {
    eventId: string
    target: MessageRef
    revision: string
    role: 'user' | 'char'
    change: 'created' | 'updated'
    cause: MessageCommitCause
    durability: MessageCommitDurability
    source: unknown
}

export interface MessageEventOptions {
    scope?: 'current' | 'all'
    roles?: Array<'user' | 'char'>
    causes?: MessageCommitCause[]
    durability?: MessageCommitDurability
}

interface Subscription {
    id: string
    context: PluginExecutionContext
    listener: (event: MessageCommittedEvent) => void | Promise<void>
    pinned?: { characterId: string; conversationId: string }
    roles: Set<'user' | 'char'>
    causes: Set<MessageCommitCause>
    durability: MessageCommitDurability
    queue: CapturedMessageCommit[]
    draining: boolean
    removed: boolean
    released: boolean
    active?: Promise<void>
    activeListener?: Promise<unknown>
}

const ALL_CAUSES: MessageCommitCause[] = ['model', 'continue', 'reroll', 'trigger']
const MAX_QUEUED_EVENTS = 32
const MAX_SUBSCRIPTIONS = 16
const MAX_SNAPSHOT_UTF16 = 262_144
const MAX_SNAPSHOT_JSON_BYTES = 2_097_152
const MAX_CALLER_ATTACHMENTS = 256
const encoder = new TextEncoder()

const normalizeList = <T extends string>(
    value: T[] | undefined,
    fallback: readonly T[],
    allowed: readonly T[],
    name: string,
) => {
    if (value === undefined) return [...fallback]
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => !allowed.includes(item))) {
        throw new PluginApiError('INVALID_ARGUMENT', `${name} contains an unsupported value`)
    }
    return [...new Set(value)]
}

type ReleasableListener = ((event: MessageCommittedEvent) => void | Promise<void>) & {
    release?: () => void
}

export class MessageEventService {
    private readonly subscriptions = new Map<string, Subscription>()
    private readonly callbackTimeoutMs: number
    private readonly maxQueued: number
    private readonly maxSubscriptions: number
    private readonly diagnostic: (message: string, details?: Record<string, string | number>) => void

    constructor(private readonly dependencies: {
        current(): { characterId: string; conversationId: string } | null
        snapshot(context: PluginExecutionContext, commit: CapturedMessageCommit): Promise<MessageSnapshot>
        requirePermission(context: PluginExecutionContext, permission: PluginPermissionId): Promise<void>
        createId?: () => string
        callbackTimeoutMs?: number
        maxQueuedEventsPerSubscription?: number
        maxSubscriptionsPerInstance?: number
        diagnostic?: (message: string, details?: Record<string, string | number>) => void
        cancelCallbackInvocation?: (invocation: Promise<unknown>) => boolean
    }) {
        this.callbackTimeoutMs = dependencies.callbackTimeoutMs ?? 30_000
        this.maxQueued = dependencies.maxQueuedEventsPerSubscription ?? MAX_QUEUED_EVENTS
        this.maxSubscriptions = dependencies.maxSubscriptionsPerInstance ?? MAX_SUBSCRIPTIONS
        this.diagnostic = dependencies.diagnostic ?? ((message, details) => console.warn(message, details ?? {}))
    }

    activeSubscriptionCount(instanceId: string) {
        return [...this.subscriptions.values()].filter((subscription) =>
            subscription.context.instanceId === instanceId).length
    }

    async onMessageCommitted(
        context: PluginExecutionContext,
        listener: (event: MessageCommittedEvent) => void | Promise<void>,
        options: MessageEventOptions = {},
    ) {
        if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance is unloaded')
        if (typeof listener !== 'function') throw new PluginApiError('INVALID_ARGUMENT', 'Listener must be a function')
        const scope = options.scope ?? 'current'
        if (scope !== 'current' && scope !== 'all') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid event scope')
        }
        const durability = options.durability ?? 'persisted'
        if (durability !== 'state' && durability !== 'persisted') {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid event durability')
        }
        const roles = normalizeList(options.roles, ['char'], ['user', 'char'], 'roles')
        const causes = normalizeList(options.causes, ALL_CAUSES, ALL_CAUSES, 'causes')
        let pinned = scope === 'current' ? this.dependencies.current() : undefined
        if (scope === 'current' && !pinned) throw new PluginApiError('NOT_FOUND', 'No current conversation')
        await this.dependencies.requirePermission(context, scope === 'current' ? 'chatObserve' : 'chatObserveAll')
        if (context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance is unloaded')
        if (scope === 'current') {
            pinned = this.dependencies.current()
            if (!pinned) throw new PluginApiError('NOT_FOUND', 'No current conversation')
        }
        if (this.activeSubscriptionCount(context.instanceId) >= this.maxSubscriptions) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Event subscription limit exceeded')
        }
        const id = this.dependencies.createId?.() ?? crypto.randomUUID()
        this.subscriptions.set(id, {
            id,
            context,
            listener,
            pinned: pinned ?? undefined,
            roles: new Set(roles),
            causes: new Set(causes),
            durability,
            queue: [],
            draining: false,
            removed: false,
            released: false,
        })
        return { subscriptionId: id }
    }

    private releaseListener(subscription: Subscription) {
        if (subscription.released) return
        subscription.released = true
        try { (subscription.listener as ReleasableListener).release?.() } catch { /* best effort */ }
    }

    private cancelActive(subscription: Subscription) {
        if (!subscription.activeListener) return false
        try {
            return this.dependencies.cancelCallbackInvocation?.(subscription.activeListener) === true
        } catch {
            return false
        }
    }

    private retire(subscription: Subscription) {
        if (subscription.removed) return
        subscription.removed = true
        subscription.queue.length = 0
        this.cancelActive(subscription)
        this.subscriptions.delete(subscription.id)
        this.releaseListener(subscription)
    }

    async offMessageCommitted(context: PluginExecutionContext, subscriptionId: string) {
        const subscription = this.subscriptions.get(subscriptionId)
        if (!subscription || subscription.context.instanceId !== context.instanceId) return
        this.retire(subscription)
        if (subscription.active) await this.withTimeout(subscription.active).catch(() => undefined)
    }

    cleanupInstance(instanceId: string) {
        for (const subscription of [...this.subscriptions.values()]) {
            if (subscription.context.instanceId === instanceId) this.retire(subscription)
        }
    }

    publish(commit: CapturedMessageCommit) {
        for (const subscription of this.subscriptions.values()) {
            if (subscription.removed || subscription.context.signal.aborted
                || subscription.durability !== commit.durability
                || !subscription.roles.has(commit.role)
                || !subscription.causes.has(commit.cause)
                || (subscription.pinned
                    && (subscription.pinned.characterId !== commit.target.characterId
                        || subscription.pinned.conversationId !== commit.target.conversationId))) continue
            if (subscription.queue.length >= this.maxQueued) {
                subscription.queue.shift()
                this.diagnostic('Plugin message event queue overflow', { subscriptionId: subscription.id })
            }
            subscription.queue.push(commit)
            void this.drain(subscription)
        }
    }

    private async withTimeout(promise: Promise<unknown>) {
        let timeout: ReturnType<typeof setTimeout> | undefined
        let timedOut = false
        try {
            await Promise.race([
                promise,
                new Promise<void>((resolve) => {
                    timeout = setTimeout(() => {
                        timedOut = true
                        resolve()
                    }, this.callbackTimeoutMs)
                }),
            ])
            return !timedOut
        } finally {
            if (timeout) clearTimeout(timeout)
        }
    }

    private overLimit(message: MessageSnapshot) {
        return message.content.length > MAX_SNAPSHOT_UTF16
            || message.callerPluginState.attachments.length > MAX_CALLER_ATTACHMENTS
            || encoder.encode(JSON.stringify(message)).byteLength > MAX_SNAPSHOT_JSON_BYTES
    }

    private async deliver(subscription: Subscription, commit: CapturedMessageCommit) {
        let message: MessageSnapshot
        try {
            message = await this.dependencies.snapshot(subscription.context, commit)
        } catch (error) {
            if (!subscription.removed && !subscription.context.signal.aborted) {
                this.diagnostic('Plugin message event snapshot unavailable', { subscriptionId: subscription.id })
            }
            return
        }
        if (subscription.removed || subscription.context.signal.aborted) return
        const base: MessageCommittedEventBase = {
            eventId: commit.eventId,
            change: commit.change,
            cause: commit.cause,
            durability: commit.durability,
        }
        const event: MessageCommittedEvent = this.overLimit(message)
            ? {
                ...base,
                unavailable: {
                    ...commit.target,
                    reason: 'resource-limit',
                    contentUtf16: message.content.length,
                    callerAttachmentCount: message.callerPluginState.attachments.length,
                },
            }
            : { ...base, message }
        const listenerResult = Promise.resolve(subscription.listener(event))
        subscription.activeListener = listenerResult
        try {
            await listenerResult
        } finally {
            if (subscription.activeListener === listenerResult) subscription.activeListener = undefined
        }
    }

    private async drain(subscription: Subscription) {
        if (subscription.draining || subscription.removed) return
        subscription.draining = true
        try {
            while (!subscription.removed && !subscription.context.signal.aborted && subscription.queue.length > 0) {
                const active = this.deliver(subscription, subscription.queue.shift()!)
                subscription.active = active
                let timedOut = false
                try {
                    if (!await this.withTimeout(active)) {
                        timedOut = true
                        this.diagnostic('Plugin message event delivery timed out', { subscriptionId: subscription.id })
                        this.retire(subscription)
                        void active.catch(() => undefined)
                        return
                    }
                } catch {
                    this.diagnostic('Plugin message event callback failed', { subscriptionId: subscription.id })
                } finally {
                    if (!timedOut && subscription.active === active) subscription.active = undefined
                }
            }
        } finally {
            subscription.draining = false
            if (subscription.context.signal.aborted) this.retire(subscription)
            if (!subscription.removed && subscription.queue.length > 0) void this.drain(subscription)
        }
    }
}
