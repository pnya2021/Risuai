import { describe, expect, it, vi } from 'vitest'
import { PluginApiError } from './errors'
import {
    MessagePersistenceWaiter,
    createRisuMessagePatchAdapter,
    withMessageMutationLock,
} from './messagePatch.risu'

const request = {
    principalId: 'plugin-a',
    argumentDigest: 'a'.repeat(64),
    signal: new AbortController().signal,
    input: {
        target: { characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1' },
        expectedRevision: 'sha256:before',
        patch: { op: 'setPluginMetadata' as const, key: 'ledger', value: { prefix: 1 } },
        idempotencyKey: 'ledger-1',
        persist: 'immediate' as const,
    },
}

const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((settle) => { resolve = settle })
    return { promise, resolve }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0')).join('')

const ownedAsset = async (
    idempotencyKey: string,
    ownerPrincipalId = 'plugin-a',
    characterId = 'character-1',
) => {
    const encoded = new TextEncoder().encode(JSON.stringify([
        ownerPrincipalId, 'inlay.create.v1', idempotencyKey,
    ]))
    const id = `inlay_${hex(await crypto.subtle.digest('SHA-256', encoded))}`
    return [id, {
        name: `${id}.png`,
        type: 'image',
        data: new Blob([Uint8Array.of(1)], { type: 'image/png' }),
        ext: 'png',
        lifecycle: {
            version: 1,
            ownerPrincipalId,
            operation: 'inlay.create.v1',
            idempotencyKey,
            argumentDigest: 'a'.repeat(64),
            revision: `sha256:${'b'.repeat(64)}`,
            context: { kind: 'character', characterId },
        },
    }] as const
}

const harness = (options: { chat?: any; character?: any } = {}) => {
    const chat: any = options.chat ?? {
        id: 'conversation-1', name: 'Chat', note: '', localLore: [],
        message: [{ role: 'char', data: 'hello', chatId: 'message-1', time: 1 }],
    }
    const character: any = options.character ?? {
        chaId: 'character-1', type: 'character', chatPage: 0, chats: [chat],
    }
    const database: any = { characters: [character] }
    const inlayAssets = new Map<string, any>()
    const persistedSnapshots: any[] = []
    const dependencies = {
        getDatabase: vi.fn(() => database),
        getCurrentCharacter: vi.fn(() => character),
        getCurrentChat: vi.fn(() => character.chats[0]),
        preLoadChat: vi.fn(async () => undefined),
        coldStorageHeader: '__cold__',
        listInlayAssets: vi.fn(async () => [...inlayAssets.entries()] as Array<[string, unknown]>),
        getInlayAssetRecord: vi.fn(async (id: string) => inlayAssets.get(id) ?? null),
        waitForMessagePersistence: vi.fn(async () => {
            persistedSnapshots.push(JSON.parse(JSON.stringify(database)))
        }),
        requestDatabaseSaveNow: vi.fn(),
        createRevision: vi.fn(async (value: any): Promise<string> => Object.keys(value.pluginMessageState ?? {}).length === 0
            ? 'sha256:before'
            : 'sha256:after'),
        createId: vi.fn(() => 'commit-1'),
        now: vi.fn(() => 2),
    }
    return {
        adapter: createRisuMessagePatchAdapter(dependencies),
        chat,
        character,
        database,
        inlayAssets,
        dependencies,
        persistedSnapshots,
    }
}

describe('RisuAI current-message metadata persistence', () => {
    it('stages caller metadata and its replay receipt in the acknowledged database candidate', async () => {
        const state = harness()

        const result = await state.adapter.patchCurrentMessage(request)

        expect(result).toMatchObject({
            changed: true,
            commitId: 'commit-1',
            message: {
                revision: 'sha256:after',
                callerPluginState: { metadata: { ledger: { prefix: 1 } }, attachments: [] },
            },
        })
        expect(state.persistedSnapshots).toHaveLength(1)
        expect(state.persistedSnapshots[0].characters[0].chats[0].message[0]).toMatchObject({
            pluginMessageState: { 'plugin-a': { metadata: { ledger: { prefix: 1 } }, attachments: [] } },
        })
        expect(state.persistedSnapshots[0].pluginMessagePatchReceipts).toMatchObject([{
            version: 1,
            principalId: 'plugin-a',
            operation: 'chat.message-patch.v1',
            idempotencyKey: 'ledger-1',
            digest: 'a'.repeat(64),
        }])
    })

    it.each([
        ['message deletion', (state: ReturnType<typeof harness>) => { state.chat.message = [] }],
        ['streaming transition', (state: ReturnType<typeof harness>) => { state.chat.isStreaming = true }],
    ])('replays a persisted receipt before exact message validation after %s', async (_label, mutate) => {
        const state = harness()
        const first = await state.adapter.patchCurrentMessage(request)
        mutate(state)
        const restarted = createRisuMessagePatchAdapter(state.dependencies)

        await expect(restarted.patchCurrentMessage(request)).resolves.toEqual(first)
        await expect(restarted.patchCurrentMessage({
            ...request,
            argumentDigest: 'f'.repeat(64),
        })).rejects.toMatchObject({ code: 'CONFLICT', message: 'Idempotency key arguments conflict' })
        expect(state.dependencies.waitForMessagePersistence).toHaveBeenCalledTimes(1)
    })

    it('rolls back metadata and the receipt when persistence rejects', async () => {
        const state = harness()
        state.dependencies.waitForMessagePersistence.mockRejectedValueOnce(new Error('offline'))

        await expect(state.adapter.patchCurrentMessage(request)).rejects.toMatchObject({
            code: 'INTERNAL', message: 'Message persistence dependency failed', retryable: true,
        })
        expect(state.chat.message[0].pluginMessageState).toBeUndefined()
        expect(state.database.pluginMessagePatchReceipts).toBeUndefined()
    })

    it('persists a no-op receipt without changing revision or update time', async () => {
        const state = harness()
        await state.adapter.patchCurrentMessage(request)
        const updatedAt = state.chat.message[0].pluginMessageUpdatedAt

        await expect(state.adapter.patchCurrentMessage({
            ...request,
            argumentDigest: 'b'.repeat(64),
            input: { ...request.input, expectedRevision: 'sha256:after', idempotencyKey: 'ledger-2' },
        })).resolves.toMatchObject({ changed: false, message: { revision: 'sha256:after' } })
        expect(state.chat.message[0].pluginMessageUpdatedAt).toBe(updatedAt)
        expect(state.database.pluginMessagePatchReceipts).toHaveLength(2)
        expect(state.dependencies.waitForMessagePersistence).toHaveBeenCalledTimes(2)
    })

    it('attaches an existing owned Inlay at a logical UTF-16 offset', async () => {
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: 'A😀B', chatId: 'message-1', time: 1,
            }],
        } })
        const [inlayId, record] = await ownedAsset('staged-attach')
        state.inlayAssets.set(inlayId, record)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(inlayId) ? 'sha256:attached' : 'sha256:before')

        const result = await state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: {
                    op: 'attachInlay',
                    inlayId,
                    presentation: 'inline',
                    placement: { kind: 'utf16-offset', offset: 3 },
                    metadata: { slot: 2 },
                },
                idempotencyKey: 'attach-existing-1',
            },
        } as never)

        expect(result).toMatchObject({
            changed: true,
            message: {
                content: 'A😀B',
                revision: 'sha256:attached',
                callerPluginState: { attachments: [{
                    inlayId, presentation: 'inline', utf16Offset: 3, metadata: { slot: 2 },
                }] },
            },
        })
        expect(state.chat.message[0].data).toBe(`A😀{{inlay::${inlayId}}}B`)
        expect(state.persistedSnapshots).toHaveLength(1)
    })

    it('atomically replaces one managed own marker without copying old metadata', async () => {
        const [oldId, oldRecord] = await ownedAsset('old-slot')
        const [newId, newRecord] = await ownedAsset('new-slot')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: `A{{inlay::${oldId}}}B`, chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': {
                    metadata: { ledger: 1 },
                    attachments: [{ inlayId: oldId, presentation: 'inline', metadata: { old: true } }],
                } },
            }],
        } })
        state.inlayAssets.set(oldId, oldRecord)
        state.inlayAssets.set(newId, newRecord)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(newId) ? 'sha256:new' : 'sha256:old')

        const result = await state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:old',
                patch: {
                    op: 'attachInlay',
                    inlayId: newId,
                    presentation: 'inline',
                    placement: { kind: 'replace-own-inlay', inlayId: oldId },
                },
                idempotencyKey: 'replace-existing-1',
            },
        } as never)

        expect(state.chat.message[0].data).toBe(`A{{inlay::${newId}}}B`)
        expect(state.chat.message[0].pluginMessageState['plugin-a'].attachments)
            .toEqual([{ inlayId: newId, presentation: 'inline' }])
        expect(result.message.callerPluginState.attachments).toEqual([{
            inlayId: newId, presentation: 'inline', utf16Offset: 1,
        }])
        expect(state.inlayAssets.has(oldId)).toBe(true)
    })

    it('detaches exactly one managed owned marker and keeps the asset', async () => {
        const [oldId, oldRecord] = await ownedAsset('detach-slot')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: `A{{inlay::${oldId}}}B`, chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': {
                    metadata: {},
                    attachments: [{ inlayId: oldId, presentation: 'inline', metadata: { keep: false } }],
                } },
            }],
        } })
        state.inlayAssets.set(oldId, oldRecord)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(oldId) ? 'sha256:old' : 'sha256:detached')

        const result = await state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:old',
                patch: { op: 'detachOwnInlay', inlayId: oldId },
                idempotencyKey: 'detach-existing-1',
            },
        } as never)

        expect(state.chat.message[0].data).toBe('AB')
        expect(result.message.callerPluginState.attachments).toEqual([])
        expect(state.inlayAssets.has(oldId)).toBe(true)
    })

    it('restores raw marker, caller state, and receipt when replacement persistence fails', async () => {
        const [oldId, oldRecord] = await ownedAsset('rollback-old')
        const [newId, newRecord] = await ownedAsset('rollback-new')
        const state = harness({ chat: {
            id: 'conversation-1', message: [{
                role: 'char', data: `A{{inlay::${oldId}}}B`, chatId: 'message-1', time: 1,
                pluginMessageState: { 'plugin-a': {
                    metadata: {},
                    attachments: [{ inlayId: oldId, presentation: 'inline', metadata: { old: true } }],
                } },
            }],
        } })
        state.inlayAssets.set(oldId, oldRecord)
        state.inlayAssets.set(newId, newRecord)
        state.dependencies.createRevision.mockImplementation(async (value: any) =>
            value.data.includes(newId) ? 'sha256:new' : 'sha256:old')
        state.dependencies.waitForMessagePersistence.mockRejectedValueOnce(new Error('offline'))

        await expect(state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:old',
                patch: {
                    op: 'attachInlay',
                    inlayId: newId,
                    presentation: 'inline',
                    placement: { kind: 'replace-own-inlay', inlayId: oldId },
                },
                idempotencyKey: 'replace-rollback-1',
            },
        } as never)).rejects.toMatchObject({ code: 'INTERNAL' })

        expect(state.chat.message[0].data).toBe(`A{{inlay::${oldId}}}B`)
        expect(state.chat.message[0].pluginMessageState['plugin-a'].attachments)
            .toEqual([{ inlayId: oldId, presentation: 'inline', metadata: { old: true } }])
        expect(state.database.pluginMessagePatchReceipts).toBeUndefined()
    })

    it('rejects a foreign staged Inlay before changing the message', async () => {
        const [foreignId, foreignRecord] = await ownedAsset('foreign-slot', 'plugin-b')
        const state = harness()
        state.inlayAssets.set(foreignId, foreignRecord)

        await expect(state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: {
                    op: 'attachInlay', inlayId: foreignId, presentation: 'inline',
                    placement: { kind: 'end' },
                },
                idempotencyKey: 'foreign-attach-1',
            },
        } as never)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(state.chat.message[0].data).toBe('hello')
        expect(state.database.pluginMessagePatchReceipts).toBeUndefined()
    })

    it('holds the shared mutation lock from final ownership validation through persistence', async () => {
        const [inlayId, record] = await ownedAsset('locked-staged-attach')
        const state = harness()
        state.inlayAssets.set(inlayId, record)
        state.dependencies.createRevision.mockImplementation(async (value: any): Promise<string> =>
            value.data.includes(inlayId) ? 'sha256:attached' : 'sha256:before')
        const persistenceStarted = deferred<void>()
        const releasePersistence = deferred<void>()
        state.dependencies.waitForMessagePersistence.mockImplementationOnce(async () => {
            persistenceStarted.resolve()
            await releasePersistence.promise
        })

        const attaching = state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: {
                    op: 'attachInlay', inlayId, presentation: 'inline',
                    placement: { kind: 'end' },
                },
                idempotencyKey: 'locked-attach-1',
            },
        } as never)
        await persistenceStarted.promise

        let deletionSettled = false
        const deletion = withMessageMutationLock(async () => {
            const referenced = state.chat.message[0].data.includes(inlayId)
            if (!referenced) state.inlayAssets.delete(inlayId)
            return referenced
        }).finally(() => { deletionSettled = true })
        await Promise.resolve()
        expect(deletionSettled).toBe(false)
        expect(state.inlayAssets.has(inlayId)).toBe(true)

        releasePersistence.resolve()
        await expect(attaching).resolves.toMatchObject({ changed: true })
        await expect(deletion).resolves.toBe(true)
        expect(state.inlayAssets.has(inlayId)).toBe(true)
    })

    it('preserves foreign and future attachment state while projecting no attachments', async () => {
        const state = harness()
        state.chat.message[0].pluginMessageState = {
            'foreign-plugin': { metadata: { private: true }, attachments: [{ inlayId: 'foreign' }] },
            'plugin-a': { metadata: {}, attachments: [{ inlayId: 'future-own', metadata: { hidden: true } }] },
        }

        const result = await state.adapter.patchCurrentMessage({
            ...request,
            input: { ...request.input, expectedRevision: 'sha256:after' },
        })

        expect(result.message.callerPluginState).toEqual({
            metadata: { ledger: { prefix: 1 } }, attachments: [],
        })
        expect(state.chat.message[0].pluginMessageState['foreign-plugin'])
            .toEqual({ metadata: { private: true }, attachments: [{ inlayId: 'foreign' }] })
        expect(state.chat.message[0].pluginMessageState['plugin-a'].attachments)
            .toEqual([{ inlayId: 'future-own', metadata: { hidden: true } }])
    })

    it('enforces stale, missing, duplicate, and streaming message conflicts', async () => {
        await expect(harness().adapter.patchCurrentMessage({
            ...request,
            input: { ...request.input, expectedRevision: 'sha256:stale' },
        })).rejects.toMatchObject({ code: 'CONFLICT' })

        for (const chat of [
            { id: 'conversation-1', message: [] },
            { id: 'conversation-1', message: [
                { role: 'char', data: 'a', chatId: 'message-1' },
                { role: 'char', data: 'b', chatId: 'message-1' },
            ] },
            { id: 'conversation-1', isStreaming: true, message: [
                { role: 'char', data: 'a', chatId: 'message-1' },
            ] },
        ]) {
            await expect(harness({ chat }).adapter.patchCurrentMessage(request)).rejects.toMatchObject({
                code: chat.message.length === 0 ? 'NOT_FOUND' : 'CONFLICT',
            })
        }
    })

    it('accepts the sixteenth caller key and rejects the seventeenth', async () => {
        const state = harness()
        state.chat.message[0].pluginMessageState = {
            'plugin-a': {
                metadata: Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`key-${index}`, index])),
                attachments: [],
            },
        }
        await expect(state.adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                expectedRevision: 'sha256:after',
                patch: { op: 'setPluginMetadata', key: 'key-15', value: 15 },
            },
        })).resolves.toMatchObject({ changed: true })
        await expect(state.adapter.patchCurrentMessage({
            ...request,
            argumentDigest: 'c'.repeat(64),
            input: {
                ...request.input,
                expectedRevision: 'sha256:after',
                idempotencyKey: 'key-17',
                patch: { op: 'setPluginMetadata', key: 'key-16', value: 16 },
            },
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })

    it('accepts 65,536 combined caller metadata bytes and rejects one byte over', async () => {
        await expect(harness().adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: { op: 'setPluginMetadata', key: 'ledger', value: 'x'.repeat(65_493) },
            },
        })).resolves.toMatchObject({ changed: true })
        await expect(harness().adapter.patchCurrentMessage({
            ...request,
            input: {
                ...request.input,
                patch: { op: 'setPluginMetadata', key: 'ledger', value: 'x'.repeat(65_494) },
            },
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })

    it('prioritizes abort, current scope, and changed source across rejecting awaits', async () => {
        const aborted = harness()
        const controller = new AbortController()
        aborted.dependencies.createRevision.mockImplementationOnce(async () => {
            controller.abort()
            throw new PluginApiError('NETWORK', 'private revision failure')
        })
        await expect(aborted.adapter.patchCurrentMessage({ ...request, signal: controller.signal }))
            .rejects.toMatchObject({ code: 'ABORTED' })

        const switched = harness()
        switched.dependencies.listInlayAssets.mockImplementationOnce(async () => {
            switched.character.chats[0] = { ...switched.chat, id: 'other' }
            throw new PluginApiError('NETWORK', 'private inlay failure')
        })
        await expect(switched.adapter.patchCurrentMessage(request))
            .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

        const changed = harness()
        changed.dependencies.waitForMessagePersistence.mockImplementationOnce(async () => {
            changed.chat.message[0].time = 99
            throw new PluginApiError('NETWORK', 'private persistence failure')
        })
        await expect(changed.adapter.patchCurrentMessage(request))
            .rejects.toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(changed.chat.message[0].time).toBe(99)
        expect(changed.chat.message[0].pluginMessageState).toMatchObject({
            'plugin-a': { metadata: { ledger: { prefix: 1 } }, attachments: [] },
        })
        expect(changed.database.pluginMessagePatchReceipts).toHaveLength(1)
        expect(changed.dependencies.requestDatabaseSaveNow).not.toHaveBeenCalled()
    })

    it('preserves typed stable dependency errors and wraps raw failures', async () => {
        const typed = harness()
        typed.dependencies.waitForMessagePersistence.mockRejectedValueOnce(
            new PluginApiError('NETWORK', 'stable persistence failure', { retryable: true }),
        )
        await expect(typed.adapter.patchCurrentMessage(request)).rejects.toMatchObject({
            code: 'NETWORK', message: 'stable persistence failure', retryable: true,
        })

        const raw = harness()
        raw.dependencies.waitForMessagePersistence.mockRejectedValueOnce(new Error('private raw error'))
        await expect(raw.adapter.patchCurrentMessage(request)).rejects.toMatchObject({
            code: 'INTERNAL', message: 'Message persistence dependency failed', retryable: true,
        })
    })

    it('does not roll back a replacement root that has newer caller state', async () => {
        const state = harness()
        let replacementRoot: any
        let replacementBeforeRollback: any
        state.dependencies.waitForMessagePersistence.mockImplementationOnce(async () => {
            replacementRoot = structuredClone(state.database)
            replacementRoot.characters[0].chats[0].message[0].pluginMessageState['plugin-a'] = {
                metadata: { ledger: { prefix: 99 }, newer: true },
                attachments: [],
                updatedAt: 99,
            }
            replacementRoot.characters[0].chats[0].message[0].pluginMessageUpdatedAt = 99
            replacementBeforeRollback = structuredClone(replacementRoot)
            state.dependencies.getDatabase.mockReturnValue(replacementRoot)
            state.dependencies.getCurrentCharacter.mockReturnValue(replacementRoot.characters[0])
            state.dependencies.getCurrentChat.mockReturnValue(replacementRoot.characters[0].chats[0])
            throw new PluginApiError('NETWORK', 'old candidate save failed', { retryable: true })
        })

        await expect(state.adapter.patchCurrentMessage(request)).rejects.toMatchObject({
            code: 'CONFLICT', retryable: true,
        })
        expect(replacementRoot).toEqual(replacementBeforeRollback)
        expect(state.dependencies.requestDatabaseSaveNow).not.toHaveBeenCalled()
    })
})

describe('RisuAI narrow save waiter', () => {
    const database = (withState = true) => ({
        characters: [{ chaId: 'character-1', chats: [{
            id: 'conversation-1',
            message: [{
                role: 'char', data: 'hello', chatId: 'message-1',
                ...(withState ? { pluginMessageState: { 'plugin-a': { metadata: { ledger: 1 }, attachments: [] } } } : {}),
            }],
        }] }],
    })
    const target = { characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1' }
    const revision = async (value: any) => Object.keys(value.pluginMessageState ?? {}).length > 0
        ? 'sha256:after'
        : 'sha256:before'

    it('acknowledges only a successfully encoded matching candidate', async () => {
        const waiter = new MessagePersistenceWaiter(revision)
        const pending = waiter.wait(target, 'sha256:after')
        const batch = await waiter.capture(database())
        expect(waiter.hasPending()).toBe(false)
        waiter.acknowledge(batch)
        await expect(pending).resolves.toBeUndefined()
    })

    it('requeues skipped candidates, rejects failed writes, and conflicts stale candidates', async () => {
        const skippedWaiter = new MessagePersistenceWaiter(revision)
        const skipped = skippedWaiter.wait(target, 'sha256:after')
        const skippedBatch = await skippedWaiter.capture(database())
        skippedWaiter.release(skippedBatch)
        expect(skippedWaiter.hasPending()).toBe(true)
        const retryBatch = await skippedWaiter.capture(database())
        skippedWaiter.acknowledge(retryBatch)
        await expect(skipped).resolves.toBeUndefined()

        const failedWaiter = new MessagePersistenceWaiter(revision)
        const failed = failedWaiter.wait(target, 'sha256:after')
        const failedBatch = await failedWaiter.capture(database())
        failedWaiter.fail(failedBatch, new Error('disk full'))
        await expect(failed).rejects.toThrow('disk full')

        const staleWaiter = new MessagePersistenceWaiter(revision)
        const stale = staleWaiter.wait(target, 'sha256:after')
        await staleWaiter.capture(database(false))
        await expect(stale).rejects.toMatchObject({ code: 'CONFLICT' })
    })
})
