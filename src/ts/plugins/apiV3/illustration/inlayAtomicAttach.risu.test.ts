import { describe, expect, it, vi } from 'vitest'
import { PluginApiError } from './errors'
import { createRisuInlayAtomicAttachAdapter } from './inlayAtomicAttach.risu'
import { withMessageMutationLock } from './messagePatch.risu'

const principalId = 'plugin-a'
const baseRequest = {
    principalId,
    argumentDigest: 'a'.repeat(64),
    signal: new AbortController().signal,
    input: {
        target: { characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1' },
        expectedMessageRevision: 'sha256:before',
        data: new Uint8Array([1, 2, 3]),
        inlay: { name: 'base.png' },
        presentation: 'inline' as const,
        placement: { kind: 'end' as const },
        attachmentMetadata: { outfit: 'default' },
        messageMetadata: [{ key: 'illustration-ledger', value: { version: 1 } }] as [{ key: string; value: { version: number } }],
        idempotencyKey: 'attach-1',
        persist: 'immediate' as const,
    },
}

const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(value),
))].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const deterministicId = async (key: string) => `inlay_${await digest(JSON.stringify([
    principalId, 'inlay.create.v1', key,
]))}`

const harness = (raw = 'hello') => {
    const chat: any = {
        id: 'conversation-1', name: 'Chat', note: '', localLore: [],
        message: [{ role: 'char', data: raw, chatId: 'message-1', time: 1 }],
    }
    const character: any = { chaId: 'character-1', type: 'character', chatPage: 0, chats: [chat] }
    const database: any = { characters: [character] }
    let activeDatabase = database
    let activeCharacter = character
    let activeChat = chat
    const assets = new Map<string, any>()
    const persisted: any[] = []
    let physicalCreates = 0
    const createInlay = vi.fn(async (data: Uint8Array, options: any) => {
        const id = await deterministicId(options.idempotencyKey)
        const revision = `sha256:${await digest([...data].join(','))}`
        if (!assets.has(id)) {
            physicalCreates += 1
            assets.set(id, {
                name: options.name,
                lifecycle: {
                    version: 1,
                    ownerPrincipalId: principalId,
                    operation: 'inlay.create.v1',
                    idempotencyKey: options.idempotencyKey,
                    argumentDigest: 'lifecycle-digest',
                    revision,
                    context: { ...options.context },
                },
            })
        }
        return { id, revision, name: options.name }
    })
    const deleteInlay = vi.fn(async (id: string) => {
        assets.delete(id)
        return { deleted: true as const }
    })
    const dependencies = {
        getDatabase: vi.fn(() => activeDatabase),
        getCurrentCharacter: vi.fn(() => activeCharacter),
        getCurrentChat: vi.fn(() => activeChat),
        preLoadChat: vi.fn(async () => undefined),
        coldStorageHeader: '__cold__',
        listInlayAssets: vi.fn(async () => [...assets.entries()] as Array<[string, unknown]>),
        createInlay,
        deleteInlay,
        waitForMessagePersistence: vi.fn(async () => { persisted.push(structuredClone(activeDatabase)) }),
        requestDatabaseSaveNow: vi.fn(),
        createRevision: vi.fn(async (value: any) => value.data.includes('{{inlay::')
            ? 'sha256:after' : 'sha256:before'),
        createId: vi.fn(() => 'commit-1'),
        now: vi.fn(() => 2),
    }
    return {
        adapter: createRisuInlayAtomicAttachAdapter(dependencies),
        chat, character, database, assets, dependencies, persisted,
        physicalCreates: () => physicalCreates,
        replaceDatabase(next: any) {
            activeDatabase = next
            activeCharacter = next.characters[0]
            activeChat = activeCharacter.chats[0]
        },
    }
}

describe('RisuAI generated Inlay atomic message attachment', () => {
    it('persists marker, caller attachment, metadata and receipt in one acknowledged candidate', async () => {
        const state = harness()

        const result = await state.adapter.attachCurrentMessage(baseRequest)

        expect(result).toMatchObject({
            commitId: 'commit-1',
            message: {
                content: 'hello', revision: 'sha256:after',
                callerPluginState: {
                    metadata: { 'illustration-ledger': { version: 1 } },
                    attachments: [{ presentation: 'inline', utf16Offset: 5, metadata: { outfit: 'default' } }],
                },
            },
        })
        expect(state.persisted).toHaveLength(1)
        const candidate = state.persisted[0]
        const message = candidate.characters[0].chats[0].message[0]
        expect(message.data).toBe(`hello{{inlay::${result.inlay.id}}}`)
        expect(message.pluginMessageState[principalId].attachments).toEqual([{
            inlayId: result.inlay.id, presentation: 'inline', metadata: { outfit: 'default' },
        }])
        expect(candidate.pluginAtomicAttachReceipts).toMatchObject([{
            version: 1, principalId, operation: 'inlay.atomic-attach.v1',
            idempotencyKey: 'attach-1', digest: 'a'.repeat(64),
        }])
    })

    it('inserts after a recognized marker cluster at the same logical offset', async () => {
        const state = harness('a')
        const first = await state.adapter.attachCurrentMessage({
            ...baseRequest,
            input: { ...baseRequest.input, placement: { kind: 'utf16-offset', offset: 1 } },
        })
        const second = await state.adapter.attachCurrentMessage({
            ...baseRequest,
            argumentDigest: 'b'.repeat(64),
            input: { ...baseRequest.input, expectedMessageRevision: 'sha256:after', idempotencyKey: 'attach-2', placement: { kind: 'utf16-offset', offset: 1 } },
        })
        expect(state.chat.message[0].data).toBe(`a{{inlay::${first.inlay.id}}}{{inlay::${second.inlay.id}}}`)
    })

    it('rejects stale revisions and surrogate splits before creating an Inlay', async () => {
        const stale = harness()
        await expect(stale.adapter.attachCurrentMessage({
            ...baseRequest, input: { ...baseRequest.input, expectedMessageRevision: 'sha256:stale' },
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(stale.dependencies.createInlay).not.toHaveBeenCalled()

        const surrogate = harness('😀')
        await expect(surrogate.adapter.attachCurrentMessage({
            ...baseRequest, input: { ...baseRequest.input, placement: { kind: 'utf16-offset', offset: 1 } },
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        expect(surrogate.dependencies.createInlay).not.toHaveBeenCalled()
    })

    it('deletes a newly staged Inlay on a known pre-persistence source conflict', async () => {
        const state = harness()
        const original = state.dependencies.createInlay.getMockImplementation()!
        state.dependencies.createInlay.mockImplementationOnce(async (data, options) => {
            const result = await original(data, options)
            state.chat.message[0].time = 9
            return result
        })

        await expect(state.adapter.attachCurrentMessage(baseRequest)).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(state.dependencies.deleteInlay).toHaveBeenCalledTimes(1)
        expect(state.dependencies.waitForMessagePersistence).not.toHaveBeenCalled()
    })

    it('retains the staged Inlay and restores the exact candidate when persistence is unknown', async () => {
        const state = harness()
        state.dependencies.waitForMessagePersistence.mockRejectedValueOnce(new Error('offline'))

        await expect(state.adapter.attachCurrentMessage(baseRequest)).rejects.toMatchObject({
            code: 'INTERNAL', message: 'Atomic Inlay persistence dependency failed',
        })
        expect(state.chat.message[0].data).toBe('hello')
        expect(state.chat.message[0].pluginMessageState).toBeUndefined()
        expect(state.database.pluginAtomicAttachReceipts).toBeUndefined()
        expect(state.dependencies.deleteInlay).not.toHaveBeenCalled()
        expect(state.assets.size).toBe(1)
    })

    it('replays a committed receipt after restart before message validation', async () => {
        const state = harness()
        const first = await state.adapter.attachCurrentMessage(baseRequest)
        state.chat.message = []

        await expect(createRisuInlayAtomicAttachAdapter(state.dependencies)
            .attachCurrentMessage(baseRequest)).resolves.toEqual(first)
        expect(state.dependencies.waitForMessagePersistence).toHaveBeenCalledTimes(1)
        expect(state.physicalCreates()).toBe(1)
    })

    it('reuses the deterministic uncommitted stage after restart', async () => {
        const state = harness()
        state.dependencies.waitForMessagePersistence.mockRejectedValueOnce(new Error('offline'))
        await expect(state.adapter.attachCurrentMessage(baseRequest)).rejects.toMatchObject({ code: 'INTERNAL' })

        await expect(createRisuInlayAtomicAttachAdapter(state.dependencies)
            .attachCurrentMessage(baseRequest)).resolves.toMatchObject({ commitId: 'commit-1' })
        expect(state.physicalCreates()).toBe(1)
        expect(state.dependencies.waitForMessagePersistence).toHaveBeenCalledTimes(2)
    })

    it('does not roll back a replacement root after persistence fails', async () => {
        const state = harness()
        let replacement: any
        state.dependencies.waitForMessagePersistence.mockImplementationOnce(async () => {
            replacement = structuredClone(state.database)
            replacement.characters[0].chats[0].message[0] = {
                role: 'char', data: 'newer', chatId: 'message-1', time: 99,
            }
            state.replaceDatabase(replacement)
            throw new PluginApiError('NETWORK', 'unknown save', { retryable: true })
        })

        await expect(state.adapter.attachCurrentMessage(baseRequest)).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(replacement.characters[0].chats[0].message[0].data).toBe('newer')
    })

    it('uses the same mutation serialization boundary as message patch', async () => {
        const state = harness()
        let release!: () => void
        const held = withMessageMutationLock(() => new Promise<void>((resolve) => { release = resolve }))
        const pending = state.adapter.attachCurrentMessage(baseRequest)
        await Promise.resolve()
        expect(state.dependencies.createInlay).not.toHaveBeenCalled()
        release()
        await held
        await pending
        expect(state.dependencies.createInlay).toHaveBeenCalledTimes(1)
    })
})
