import { describe, expect, it, vi } from 'vitest'

import {
    MessageEventService,
    type CapturedMessageCommit,
    type MessageCommittedEvent,
} from './messageEvents'
import type { MessageSnapshot } from './messageQuery'

const context = (instanceId = 'instance', principalId = 'principal') => ({
    instanceId,
    principalId,
    displayName: 'Illustrator',
    signal: new AbortController().signal,
})

const snapshot = (commit: CapturedMessageCommit, principalId: string): MessageSnapshot => ({
    ...commit.target,
    role: commit.role,
    content: `${commit.target.messageId}:${principalId}`,
    revision: commit.revision,
    updatedAt: 1,
    callerPluginState: { metadata: {}, attachments: [] },
})

const commit = (
    messageId: string,
    overrides: Partial<CapturedMessageCommit> = {},
): CapturedMessageCommit => ({
    eventId: `event:${messageId}`,
    target: {
        characterId: 'character',
        conversationId: 'conversation',
        messageId,
    },
    revision: `revision:${messageId}`,
    role: 'char',
    change: 'created',
    cause: 'model',
    durability: 'persisted',
    source: { messageId },
    ...overrides,
})

describe('MessageEventService', () => {
    it('pins the default subscription to the current conversation and persisted character events', async () => {
        const listener = vi.fn<(event: MessageCommittedEvent) => void>()
        const service = new MessageEventService({
            current: () => ({ characterId: 'character', conversationId: 'conversation' }),
            requirePermission: vi.fn(async () => undefined),
            snapshot: async (execution, queued) => snapshot(queued, execution.principalId),
        })
        await service.onMessageCommitted(context(), listener)

        service.publish(commit('state', { durability: 'state' }))
        service.publish(commit('user', { role: 'user' }))
        service.publish(commit('other', {
            target: { characterId: 'character', conversationId: 'other', messageId: 'other' },
        }))
        service.publish(commit('accepted'))

        await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
        expect(listener.mock.calls[0][0]).toMatchObject({
            eventId: 'event:accepted',
            cause: 'model',
            durability: 'persisted',
            message: {
                characterId: 'character',
                conversationId: 'conversation',
                messageId: 'accepted',
                content: 'accepted:principal',
            },
        })
    })

    it('serializes callbacks in conversation order and drops only the oldest pending item above 32', async () => {
        let releaseFirst!: () => void
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
        const delivered: string[] = []
        let concurrent = 0
        let maxConcurrent = 0
        const diagnostic = vi.fn()
        const service = new MessageEventService({
            current: () => ({ characterId: 'character', conversationId: 'conversation' }),
            requirePermission: async () => undefined,
            snapshot: async (execution, queued) => snapshot(queued, execution.principalId),
            diagnostic,
        })
        await service.onMessageCommitted(context(), async (event) => {
            if (!event.message) return
            delivered.push(event.message.messageId)
            concurrent += 1
            maxConcurrent = Math.max(maxConcurrent, concurrent)
            if (event.message.messageId === 'm0') await firstGate
            concurrent -= 1
        })

        service.publish(commit('m0'))
        await vi.waitFor(() => expect(delivered).toEqual(['m0']))
        for (let index = 1; index <= 34; index += 1) service.publish(commit(`m${index}`))
        releaseFirst()

        await vi.waitFor(() => expect(delivered.at(-1)).toBe('m34'))
        expect(delivered).toEqual(['m0', ...Array.from({ length: 32 }, (_, index) => `m${index + 3}`)])
        expect(maxConcurrent).toBe(1)
        expect(diagnostic).toHaveBeenCalledTimes(2)
    })

    it('retires and cancels a timed-out callback without starting queued work', async () => {
        const never = new Promise<void>(() => undefined)
        const cancel = vi.fn(() => true)
        const release = vi.fn()
        const listener = Object.assign(vi.fn(() => never), { release })
        const service = new MessageEventService({
            current: () => ({ characterId: 'character', conversationId: 'conversation' }),
            requirePermission: async () => undefined,
            snapshot: async (execution, queued) => snapshot(queued, execution.principalId),
            callbackTimeoutMs: 10,
            cancelCallbackInvocation: cancel,
        })
        await service.onMessageCommitted(context(), listener)

        service.publish(commit('first'))
        service.publish(commit('queued'))

        await vi.waitFor(() => expect(cancel).toHaveBeenCalledExactlyOnceWith(never))
        expect(listener).toHaveBeenCalledOnce()
        expect(release).toHaveBeenCalledOnce()
        expect(service.activeSubscriptionCount('instance')).toBe(0)
    })

    it('authorizes all scope, validates filters and enforces the per-instance subscription cap', async () => {
        const permissions: string[] = []
        const service = new MessageEventService({
            current: () => ({ characterId: 'character', conversationId: 'conversation' }),
            requirePermission: async (_execution, permission) => { permissions.push(permission) },
            snapshot: async (execution, queued) => snapshot(queued, execution.principalId),
        })
        await service.onMessageCommitted(context(), () => undefined, {
            scope: 'all', roles: ['char'], causes: ['reroll'], durability: 'state',
        })
        expect(permissions).toEqual(['chatObserveAll'])
        await expect(service.onMessageCommitted(context(), () => undefined, { roles: [] }))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(service.onMessageCommitted(context(), () => undefined, {
            causes: ['plugin' as never],
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        for (let index = 1; index < 16; index += 1) {
            await service.onMessageCommitted(context(), () => undefined)
        }
        await expect(service.onMessageCommitted(context(), () => undefined))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })

    it('off and unload stop future delivery, release ownership and never replay queued events', async () => {
        const firstRelease = vi.fn()
        const secondRelease = vi.fn()
        const first = Object.assign(vi.fn(), { release: firstRelease })
        const second = Object.assign(vi.fn(), { release: secondRelease })
        const service = new MessageEventService({
            current: () => ({ characterId: 'character', conversationId: 'conversation' }),
            requirePermission: async () => undefined,
            snapshot: async (execution, queued) => snapshot(queued, execution.principalId),
        })
        const registered = await service.onMessageCommitted(context('one'), first)
        await service.onMessageCommitted(context('two'), second)

        await service.offMessageCommitted(context('one'), registered.subscriptionId)
        service.cleanupInstance('two')
        service.publish(commit('late'))
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(first).not.toHaveBeenCalled()
        expect(second).not.toHaveBeenCalled()
        expect(firstRelease).toHaveBeenCalledOnce()
        expect(secondRelease).toHaveBeenCalledOnce()
    })

    it('uses one event id for state and persisted delivery while materializing caller-private snapshots', async () => {
        const events: Record<string, MessageCommittedEvent[]> = { first: [], second: [] }
        const service = new MessageEventService({
            current: () => ({ characterId: 'character', conversationId: 'conversation' }),
            requirePermission: async () => undefined,
            snapshot: async (execution, queued) => snapshot(queued, execution.principalId),
        })
        await service.onMessageCommitted(context('state-first', 'first'), (event) => { events.first.push(event) }, {
            durability: 'state',
        })
        await service.onMessageCommitted(context('persisted-first', 'first'), (event) => { events.first.push(event) })
        await service.onMessageCommitted(context('persisted-second', 'second'), (event) => { events.second.push(event) })

        service.publish(commit('same', { durability: 'state' }))
        service.publish(commit('same'))

        await vi.waitFor(() => expect(events.first).toHaveLength(2))
        await vi.waitFor(() => expect(events.second).toHaveLength(1))
        expect(events.first.map((event) => event.eventId)).toEqual(['event:same', 'event:same'])
        expect(events.first.map((event) => event.message?.content)).toEqual(['same:first', 'same:first'])
        expect(events.second[0].message?.content).toBe('same:second')
    })

    it('returns a bounded unavailable branch when caller projection exceeds snapshot limits', async () => {
        const received: MessageCommittedEvent[] = []
        const service = new MessageEventService({
            current: () => ({ characterId: 'character', conversationId: 'conversation' }),
            requirePermission: async () => undefined,
            snapshot: async (_execution, queued) => ({
                ...snapshot(queued, 'principal'),
                content: 'x'.repeat(262_145),
            }),
        })
        await service.onMessageCommitted(context(), (event) => { received.push(event) })
        service.publish(commit('large'))

        await vi.waitFor(() => expect(received).toHaveLength(1))
        expect(received[0]).toEqual({
            eventId: 'event:large',
            change: 'created',
            cause: 'model',
            durability: 'persisted',
            unavailable: {
                characterId: 'character',
                conversationId: 'conversation',
                messageId: 'large',
                reason: 'resource-limit',
                contentUtf16: 262_145,
                callerAttachmentCount: 0,
            },
        })
    })
})
