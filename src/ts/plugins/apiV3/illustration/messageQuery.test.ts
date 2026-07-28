import { describe, expect, it, vi } from 'vitest'
import {
    MessageQueryService,
    type MessageQueryConversationLocation,
    type MessageQueryHostAdapter,
    type MessageQueryHostMessage,
} from './messageQuery'

const context = (signal = new AbortController().signal) => ({
    principalId: '11111111-1111-4111-8111-111111111111',
    instanceId: 'instance',
    displayName: 'Illustrator',
    signal,
})

const message = (
    chatId: string | undefined,
    role: 'user' | 'char',
    data: string,
    overrides: Partial<MessageQueryHostMessage> = {},
): MessageQueryHostMessage => ({ chatId, role, data, ...overrides })

function harness(initialMessages: MessageQueryHostMessage[] = [
    message('m1', 'user', 'hello'),
    message('m2', 'char', 'welcome'),
]) {
    const state = {
        rootEpoch: {},
        characterEpoch: {},
        conversationEpoch: {},
        messages: initialMessages,
        current: { characterId: 'character-1', conversationId: 'conversation-1' } as {
            characterId: string
            conversationId: string
        } | null,
        isStreaming: false,
        recognized: new Set<string>(),
        memberCharacterIds: undefined as string[] | undefined,
        memberCharacterEpochs: undefined as object[] | undefined,
        currentCharacterId: 'character-1',
    }
    const location = (): MessageQueryConversationLocation => ({
        rootEpoch: state.rootEpoch,
        characterEpoch: state.characterEpoch,
        conversationEpoch: state.conversationEpoch,
        messages: state.messages,
        characterId: 'character-1',
        conversationId: 'conversation-1',
        currentCharacterId: state.currentCharacterId,
        memberCharacterIds: state.memberCharacterIds,
        memberCharacterEpochs: state.memberCharacterEpochs,
        isStreaming: state.isStreaming,
    })
    const adapter: MessageQueryHostAdapter = {
        current: () => state.current,
        prepareConversation: vi.fn(async () => undefined),
        resolveConversation: (target) => target.characterId === 'character-1'
            && target.conversationId === 'conversation-1' ? location() : undefined,
        recognizedInlayIds: vi.fn(async () => state.recognized),
    }
    const permissions: string[] = []
    const service = new MessageQueryService(context(), adapter, {
        requirePermission: async (_execution, permission) => { permissions.push(permission) },
    })
    return { state, adapter, permissions, service }
}

const target = { characterId: 'character-1', conversationId: 'conversation-1', messageId: 'm2' }

describe('message query core', () => {
    it('returns an exact stable snapshot with recognized Inlay markers removed', async () => {
        const h = harness([
            message('m2', 'char', 'A{{inlay::known}}B{{inlayed::unknown}}C', {
                saying: 'member-1', time: 42, generationInfo: { generationId: 'generation-1' },
            }),
        ])
        h.state.recognized.add('known')
        h.state.memberCharacterIds = ['member-1']
        h.state.memberCharacterEpochs = [{}]

        await expect(h.service.getMessageSnapshot(target)).resolves.toMatchObject({
            ...target,
            role: 'char',
            speakerCharacterId: 'member-1',
            content: 'AB{{inlayed::unknown}}C',
            generationId: 'generation-1',
            createdAt: 42,
            updatedAt: 42,
            callerPluginState: { metadata: {}, attachments: [] },
            revision: expect.stringMatching(/^sha256:/),
        })
        expect(h.permissions).toEqual(['chatObserve'])
    })

    it('keeps revisions stable across timestamps and changes them for canonical message inputs', async () => {
        const h = harness([message('m2', 'char', 'same', { time: 1 })])
        const first = await h.service.getMessageSnapshot(target)
        h.state.messages[0].time = 999
        const timestampOnly = await h.service.getMessageSnapshot(target)
        h.state.messages[0].saying = 'different-speaker'
        const changed = await h.service.getMessageSnapshot(target)
        expect(timestampOnly.revision).toBe(first.revision)
        expect(changed.revision).not.toBe(first.revision)
    })

    it('projects only cloned caller metadata and revisions all principals and future attachment state', async () => {
        const h = harness([message('m2', 'char', 'same', {
            pluginMessageState: {
                [context().principalId]: {
                    metadata: { ledger: { prefix: 1 } },
                    attachments: [{ inlayId: 'future-own' }],
                },
                foreign: { metadata: { secret: true }, attachments: [{ inlayId: 'future-foreign' }] },
            },
            pluginMessageUpdatedAt: 9,
        })])
        const first = await h.service.getMessageSnapshot(target)
        expect(first).toMatchObject({
            updatedAt: 9,
            callerPluginState: { metadata: { ledger: { prefix: 1 } }, attachments: [] },
        })
        expect(JSON.stringify(first)).not.toContain('secret')
        ;(first.callerPluginState.metadata.ledger as { prefix: number }).prefix = 99
        expect((await h.service.getMessageSnapshot(target)).callerPluginState.metadata)
            .toEqual({ ledger: { prefix: 1 } })

        ;(h.state.messages[0].pluginMessageState as any).foreign.metadata.secret = false
        const foreignChanged = await h.service.getMessageSnapshot(target)
        expect(foreignChanged.revision).not.toBe(first.revision)
        ;(h.state.messages[0].pluginMessageState as any).foreign.attachments.push({ inlayId: 'later' })
        expect((await h.service.getMessageSnapshot(target)).revision).not.toBe(foreignChanged.revision)
    })

    it('conflicts when plugin message state changes across an async query boundary', async () => {
        const h = harness([message('m2', 'char', 'same', {
            pluginMessageState: { foreign: { metadata: { version: 1 }, attachments: [] } },
        })])
        h.adapter.recognizedInlayIds = async () => {
            ;(h.state.messages[0].pluginMessageState as any).foreign.metadata.version = 2
            return new Set()
        }
        await expect(h.service.getMessageSnapshot(target)).rejects.toMatchObject({
            code: 'CONFLICT', retryable: true,
        })
    })

    it('fails closed for missing, legacy, and duplicate message identities', async () => {
        for (const [messages, messageId] of [
            [[message(undefined, 'char', 'legacy')], 'm2'],
            [[message('legacy-message:0', 'char', 'legacy')], 'legacy-message:0'],
            [[message('m2', 'char', 'one'), message('m2', 'char', 'two')], 'm2'],
        ] as const) {
            const h = harness([...messages])
            await expect(h.service.getMessageSnapshot({ ...target, messageId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
        }
    })

    it('defaults latest to the current char message and skips a streaming final char', async () => {
        const h = harness([
            message('m1', 'char', 'committed'),
            message('m2', 'user', 'user'),
            message('m3', 'char', 'streaming'),
        ])
        h.state.isStreaming = true
        await expect(h.service.getLatestCommittedMessage()).resolves.toMatchObject({ messageId: 'm1' })
        await expect(h.service.getLatestCommittedMessage({ role: 'user' })).resolves.toMatchObject({ messageId: 'm2' })
    })

    it('rejects an exact target or recent boundary that is the final streaming char', async () => {
        const h = harness([message('m1', 'user', 'committed'), message('m2', 'char', 'streaming')])
        h.state.isStreaming = true
        await expect(h.service.getMessageSnapshot(target)).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        await expect(h.service.getRecentCommittedMessages({ before: target })).rejects.toMatchObject({
            code: 'CONFLICT', retryable: true,
        })
    })

    it('attributes a non-group char to the current character and omits unknown group speakers', async () => {
        const h = harness([message('m2', 'char', 'single')])
        await expect(h.service.getMessageSnapshot(target)).resolves.toMatchObject({ speakerCharacterId: 'character-1' })
        h.state.memberCharacterIds = ['member-1']
        h.state.memberCharacterEpochs = [{}]
        h.state.messages[0].saying = 'unknown-member'
        expect((await h.service.getMessageSnapshot(target)).speakerCharacterId).toBeUndefined()
    })

    it('returns nearest recent messages exclusively before the target in chronological order', async () => {
        const h = harness([
            message('m1', 'user', '1111'),
            message('m2', 'char', '22'),
            message('m3', 'user', '333'),
            message('m4', 'char', 'target'),
        ])
        await expect(h.service.getRecentCommittedMessages({ before: { ...target, messageId: 'm4' }, maxTotalUtf16: 5 }))
            .resolves.toMatchObject({
                items: [{ messageId: 'm2' }, { messageId: 'm3' }],
                truncatedBefore: true,
            })
    })

    it('uses exact recent defaults and maximums while rejecting invalid or over-limit inputs', async () => {
        const messages = Array.from({ length: 34 }, (_, index) => message(`m${index}`, 'user', 'x'))
        const h = harness(messages)
        const before = { ...target, messageId: 'm33' }
        await expect(h.service.getRecentCommittedMessages({ before })).resolves.toMatchObject({ items: expect.any(Array) })
        expect((await h.service.getRecentCommittedMessages({ before })).items).toHaveLength(8)
        expect((await h.service.getRecentCommittedMessages({ before, limit: 32, maxTotalUtf16: 65_536 })).items).toHaveLength(32)
        await expect(h.service.getRecentCommittedMessages({ before, limit: 33 })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(h.service.getRecentCommittedMessages({ before, maxTotalUtf16: 65_537 })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(h.service.getRecentCommittedMessages({ before, roles: [] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })

    it('upgrades to chatObserveAll if current scope changes during permission await', async () => {
        const h = harness()
        const permissions: string[] = []
        const service = new MessageQueryService(context(), h.adapter, {
            requirePermission: async (_execution, permission) => {
                permissions.push(permission)
                if (permission === 'chatObserve') h.state.current = null
            },
        })
        await expect(service.getMessageSnapshot(target)).resolves.toMatchObject({ messageId: 'm2' })
        expect(permissions).toEqual(['chatObserve', 'chatObserveAll'])
    })

    it('requires chatObserveAll for a non-current conversation', async () => {
        const h = harness()
        h.state.current = null
        await expect(h.service.getMessageSnapshot(target)).resolves.toMatchObject({ messageId: 'm2' })
        expect(h.permissions).toEqual(['chatObserveAll'])
    })

    it('rejects an aborted plugin before reading Host state', async () => {
        const controller = new AbortController()
        controller.abort()
        const h = harness()
        const service = new MessageQueryService(context(controller.signal), h.adapter, {
            requirePermission: vi.fn(async () => undefined),
        })
        await expect(service.getMessageSnapshot(target)).rejects.toMatchObject({ code: 'ABORTED' })
        expect(h.adapter.prepareConversation).not.toHaveBeenCalled()
    })

    it('rejects root, character, conversation, and message-array replacement across Inlay enumeration', async () => {
        for (const field of ['rootEpoch', 'characterEpoch', 'conversationEpoch', 'messages'] as const) {
            const h = harness()
            h.adapter.recognizedInlayIds = async () => {
                if (field === 'messages') h.state.messages = [...h.state.messages]
                else h.state[field] = {}
                return new Set()
            }
            await expect(h.service.getMessageSnapshot(target)).rejects.toMatchObject({
                code: 'CONFLICT', retryable: true,
            })
        }
    })

    it('rejects canonical source and latest selection changes across any async boundary', async () => {
        const h = harness()
        h.adapter.recognizedInlayIds = async () => {
            h.state.messages[1].data = 'changed'
            h.state.messages.push(message('m3', 'char', 'new latest'))
            return new Set()
        }
        await expect(h.service.getLatestCommittedMessage()).rejects.toMatchObject({
            code: 'CONFLICT', retryable: true,
        })
    })

    it('rejects current-character or ordered group-member attribution changes across an async boundary', async () => {
        for (const mutate of [
            (h: ReturnType<typeof harness>) => { h.state.currentCharacterId = 'character-2' },
            (h: ReturnType<typeof harness>) => { h.state.memberCharacterIds = ['member-2', 'member-1'] },
        ]) {
            const h = harness([message('m2', 'char', 'group', { saying: 'member-1' })])
            h.state.memberCharacterIds = ['member-1', 'member-2']
            h.state.memberCharacterEpochs = [{}, {}]
            h.adapter.recognizedInlayIds = async () => { mutate(h); return new Set() }
            await expect(h.service.getMessageSnapshot(target)).rejects.toMatchObject({
                code: 'CONFLICT', retryable: true,
            })
        }
    })

    it('rejects resolved group-member card deletion or identity replacement across an async boundary', async () => {
        for (const mutate of [
            (h: ReturnType<typeof harness>) => {
                h.state.memberCharacterIds = ['member-1']
                h.state.memberCharacterEpochs = [h.state.memberCharacterEpochs![0]]
            },
            (h: ReturnType<typeof harness>) => {
                h.state.memberCharacterEpochs = [{}, h.state.memberCharacterEpochs![1]]
            },
        ]) {
            const h = harness([message('m2', 'char', 'group', { saying: 'member-1' })])
            h.state.memberCharacterIds = ['member-1', 'member-2']
            h.state.memberCharacterEpochs = [{}, {}]
            h.adapter.recognizedInlayIds = async () => { mutate(h); return new Set() }
            await expect(h.service.getMessageSnapshot(target)).rejects.toMatchObject({
                code: 'CONFLICT', retryable: true,
            })
        }
    })

    it('rejects abort and source changes that occur during revision hashing', async () => {
        const h = harness()
        const controller = new AbortController()
        const service = new MessageQueryService(context(controller.signal), h.adapter, {
            requirePermission: async () => undefined,
            createRevision: async () => {
                controller.abort()
                h.state.messages[1].data = 'changed during hash'
                return 'sha256:test'
            },
        })
        await expect(service.getMessageSnapshot(target)).rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
    })

    it('enforces complete snapshot limits without truncating content', async () => {
        const h = harness([message('m2', 'char', 'x'.repeat(262_145))])
        await expect(h.service.getMessageSnapshot(target)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })
})
