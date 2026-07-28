import { describe, expect, it, vi } from 'vitest'

import type { CapturedMessageCommit } from './messageEvents'
import {
    applyContinueMessageIdentity,
    applyRerollMessageIdentity,
    createRisuMessageCommitRuntime,
} from './messageEvents.risu'
import { projectCapturedMessageSnapshot, type MessageQueryHostMessage } from './messageQuery'

const previous = (): MessageQueryHostMessage => ({
    role: 'char',
    data: 'old{{inlay::owned}}',
    saying: 'member-old',
    chatId: 'message-stable',
    time: 100,
    generationInfo: { generationId: 'generation-old' },
    pluginMessageUpdatedAt: 110,
    pluginMessageState: {
        first: {
            metadata: { private: 'first' },
            attachments: [{ inlayId: 'owned', presentation: 'inline' }],
            updatedAt: 110,
        },
        second: {
            metadata: { private: 'second' },
            attachments: [],
            updatedAt: 109,
        },
    },
})

describe('Risu message event adapter', () => {
    it('preserves stable identity and caller state across Continue while accepting new content', () => {
        const before = previous()
        const continued = applyContinueMessageIdentity(before, {
            role: 'char',
            data: 'old plus',
            saying: 'member-new',
            chatId: 'replacement-id',
            time: 200,
            generationInfo: { generationId: 'generation-new', model: 'new-model' },
            pluginMessageState: {},
        }, 300)

        expect(continued).toMatchObject({
            role: 'char',
            data: 'old{{inlay::owned}} plus',
            saying: 'member-old',
            chatId: 'message-stable',
            time: 100,
            generationInfo: { generationId: 'generation-old', model: 'new-model' },
            pluginMessageUpdatedAt: 300,
            pluginMessageState: before.pluginMessageState,
        })
    })

    it('preserves message identity on reroll, assigns the new generation and clamps owned markers', () => {
        const before = previous()
        const rerolled = applyRerollMessageIdentity(before, {
            role: 'char',
            data: 'new',
            saying: 'member-new',
            chatId: 'replacement-id',
            time: 200,
            generationInfo: { generationId: 'generation-new' },
        }, 300)

        expect(rerolled).toMatchObject({
            data: 'new{{inlay::owned}}',
            saying: 'member-new',
            chatId: 'message-stable',
            time: 100,
            generationInfo: { generationId: 'generation-new' },
            pluginMessageUpdatedAt: 300,
            pluginMessageState: before.pluginMessageState,
        })
    })

    it('captures once, publishes state and exact persisted events in order, and omits failed saves', async () => {
        const published: CapturedMessageCommit[] = []
        const persistence = new Map<string, { resolve(): void; reject(error: unknown): void }>()
        const waitForMessagePersistence = vi.fn((target: { messageId: string }) => new Promise<void>((resolve, reject) => {
            persistence.set(target.messageId, { resolve, reject })
        }))
        let event = 0
        const runtime = createRisuMessageCommitRuntime({
            recognizedInlayIds: async () => new Set(['owned']),
            waitForMessagePersistence,
            requestDatabaseSaveNow: vi.fn(),
            publish: (commit) => { published.push(commit) },
            createId: () => `event-${++event}`,
        })
        const first = previous()
        const second = { ...previous(), chatId: 'message-second', data: 'second' }

        await runtime.commit([
            {
                characterId: 'group', conversationId: 'chat', currentCharacterId: 'group',
                memberCharacterIds: ['member-old', 'member-new'], message: first,
                change: 'updated', cause: 'continue',
            },
            {
                characterId: 'group', conversationId: 'chat', currentCharacterId: 'group',
                memberCharacterIds: ['member-old', 'member-new'], message: second,
                change: 'updated', cause: 'reroll',
            },
        ])

        expect(published.map((item) => [item.eventId, item.durability])).toEqual([
            ['event-1', 'state'], ['event-2', 'state'],
        ])
        persistence.get('message-second')!.reject(new Error('save failed'))
        persistence.get('message-stable')!.resolve()
        await vi.waitFor(() => expect(published).toHaveLength(3))
        expect(published.map((item) => [item.eventId, item.durability])).toEqual([
            ['event-1', 'state'], ['event-2', 'state'], ['event-1', 'persisted'],
        ])
        expect(waitForMessagePersistence).toHaveBeenCalledTimes(2)

        const source = published[0].source
        first.data = 'mutated after capture'
        const firstSnapshot = await projectCapturedMessageSnapshot(source, 'first', { enforceLimits: false })
        const secondSnapshot = await projectCapturedMessageSnapshot(source, 'second', { enforceLimits: false })
        expect(firstSnapshot.content).toBe('old')
        expect(firstSnapshot.speakerCharacterId).toBe('member-old')
        expect(firstSnapshot.callerPluginState).toEqual({
            metadata: { private: 'first' },
            attachments: [{ inlayId: 'owned', presentation: 'inline', utf16Offset: 3 }],
        })
        expect(secondSnapshot.callerPluginState).toEqual({
            metadata: { private: 'second' }, attachments: [],
        })
    })
})
