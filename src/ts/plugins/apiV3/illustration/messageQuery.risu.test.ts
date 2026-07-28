import { describe, expect, it, vi } from 'vitest'
import { createRisuMessageQueryAdapter, type RisuMessageQueryAdapterDependencies } from './messageQuery.risu'

const COLD = '\uEF01COLDSTORAGE\uEF01'

function host(overrides: Partial<RisuMessageQueryAdapterDependencies> = {}) {
    let root: any = {
        characters: [{
            type: 'group',
            chaId: 'group-1',
            characters: [
                'member-1', 'member-2', 'nested-group', 'missing-member',
                'repeated-member', 'repeated-member', 'ambiguous-member',
            ],
            chatPage: 0,
            chats: [{
                id: 'conversation-1',
                isStreaming: false,
                message: [{ role: 'char', data: 'hello', chatId: 'm1', saying: 'member-1' }],
            }],
        },
        { type: 'character', chaId: 'member-1', chats: [] },
        { type: 'character', chaId: 'member-2', chats: [] },
        { type: 'group', chaId: 'nested-group', chats: [], characters: ['member-1'] },
        { type: 'character', chaId: 'repeated-member', chats: [] },
        { type: 'character', chaId: 'ambiguous-member', chats: [] },
        { type: 'character', chaId: 'ambiguous-member', chats: [] },
        ],
    }
    const dependencies: RisuMessageQueryAdapterDependencies = {
        getDatabase: () => root,
        getCurrentCharacter: () => root.characters[0],
        getCurrentChat: () => root.characters[0].chats[0],
        preLoadChat: vi.fn(async () => undefined),
        coldStorageHeader: COLD,
        listInlayAssets: vi.fn(async () => [['known', { data: 'not-read-by-adapter' }] as [string, unknown]]),
        ...overrides,
    }
    return {
        dependencies,
        adapter: createRisuMessageQueryAdapter(dependencies),
        get root() { return root },
        set root(value) { root = value },
    }
}

describe('Risu message query adapter', () => {
    it('resolves stable live identities, group speakers, current IDs, and recognized Inlay keys', async () => {
        const h = host()
        expect(h.adapter.current()).toEqual({ characterId: 'group-1', conversationId: 'conversation-1' })
        expect(h.adapter.resolveConversation({ characterId: 'group-1', conversationId: 'conversation-1' }))
            .toMatchObject({
                rootEpoch: h.root,
                characterEpoch: h.root.characters[0],
                conversationEpoch: h.root.characters[0].chats[0],
                messages: h.root.characters[0].chats[0].message,
                currentCharacterId: 'group-1',
                memberCharacterIds: ['member-1', 'member-2'],
                memberCharacterEpochs: [h.root.characters[1], h.root.characters[2]],
            })
        await expect(h.adapter.recognizedInlayIds()).resolves.toEqual(new Set(['known']))
    })

    it('redacts Inlay enumeration storage failures as retryable Host errors', async () => {
        const h = host({ listInlayAssets: async () => { throw new Error('private storage path') } })
        const error = await h.adapter.recognizedInlayIds().catch((value) => value)
        expect(error).toMatchObject({ code: 'INTERNAL', retryable: true })
        expect(String(error.message)).not.toContain('private storage path')
    })

    it('hydrates a cold pointer by exact indices and retains the same root, character, and chat objects', async () => {
        const h = host()
        const chat = h.root.characters[0].chats[0]
        chat.message = [{ role: 'char', data: `${COLD}cold-key` }]
        h.dependencies.preLoadChat = vi.fn(async (characterIndex, chatIndex) => {
            expect([characterIndex, chatIndex]).toEqual([0, 0])
            chat.message = [{ role: 'char', data: 'hydrated', chatId: 'hydrated-message' }]
        })
        h.adapter = createRisuMessageQueryAdapter(h.dependencies)

        await expect(h.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-1' }))
            .resolves.toBeUndefined()
        expect(h.dependencies.preLoadChat).toHaveBeenCalledOnce()
        expect(h.adapter.resolveConversation({ characterId: 'group-1', conversationId: 'conversation-1' })?.messages[0].chatId)
            .toBe('hydrated-message')
    })

    it('retains persisted principal message state supplied by cold hydration', async () => {
        const h = host()
        const chat = h.root.characters[0].chats[0]
        chat.message = [{ role: 'char', data: `${COLD}cold-key` }]
        h.dependencies.preLoadChat = async () => {
            chat.message = [{
                role: 'char', data: 'hydrated', chatId: 'hydrated-message',
                pluginMessageState: {
                    'plugin-a': { metadata: { ledger: 1 }, attachments: [] },
                },
            }]
        }
        h.adapter = createRisuMessageQueryAdapter(h.dependencies)

        await h.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-1' })
        expect(h.adapter.resolveConversation({
            characterId: 'group-1', conversationId: 'conversation-1',
        })?.messages[0].pluginMessageState).toEqual({
            'plugin-a': { metadata: { ledger: 1 }, attachments: [] },
        })
    })

    it('fails closed when cold hydration remains a pointer, produces a synthetic failure, or corrupts messages', async () => {
        for (const replacement of [
            [{ role: 'char', data: `${COLD}cold-key` }],
            [{ role: 'char', data: '[Cold storage data could not be loaded. Key: cold-key]' }],
            null,
        ]) {
            const h = host()
            const chat = h.root.characters[0].chats[0]
            chat.message = [{ role: 'char', data: `${COLD}cold-key` }]
            h.dependencies.preLoadChat = async () => { chat.message = replacement as any }
            h.adapter = createRisuMessageQueryAdapter(h.dependencies)
            await expect(h.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-1' }))
                .rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        }
    })

    it('fails closed when hydration replaces the database root or target chat identity', async () => {
        for (const replace of ['root', 'chat'] as const) {
            const h = host()
            const chat = h.root.characters[0].chats[0]
            chat.message = [{ role: 'char', data: `${COLD}cold-key` }]
            h.dependencies.preLoadChat = async () => {
                if (replace === 'root') h.root = structuredClone(h.root)
                else h.root.characters[0].chats[0] = { ...chat, message: [{ role: 'char', data: 'loaded', chatId: 'm2' }] }
            }
            h.adapter = createRisuMessageQueryAdapter(h.dependencies)
            await expect(h.adapter.prepareConversation({ characterId: 'group-1', conversationId: 'conversation-1' }))
                .rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        }
    })
})
