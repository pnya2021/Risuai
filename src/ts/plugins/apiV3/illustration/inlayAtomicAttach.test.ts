import { describe, expect, it, vi } from 'vitest'
import { IdempotencyLedger } from './idempotency'
import { PluginApiError } from './errors'
import { MessageMutationRateLimiter } from './messagePatch'
import {
    InlayAtomicAttachService,
    type InlayAtomicAttachHostAdapter,
    type InlayAtomicAttachInput,
    type InlayAtomicAttachResult,
} from './inlayAtomicAttach'

const target = {
    characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1',
}

const input = (overrides: Partial<InlayAtomicAttachInput> = {}): InlayAtomicAttachInput => ({
    target,
    expectedMessageRevision: 'sha256:before',
    data: Uint8Array.of(1, 2, 3),
    inlay: { name: 'slot-1.png' },
    presentation: 'inline',
    placement: { kind: 'end' },
    attachmentMetadata: { slotId: 'slot-1' },
    messageMetadata: [{ key: 'ledger', value: { status: 'running' } }],
    idempotencyKey: 'attach-1',
    persist: 'immediate',
    ...overrides,
})

const result: InlayAtomicAttachResult = {
    inlay: { id: 'inlay-1', revision: 'sha256:image', name: 'slot-1.png' },
    message: {
        ...target, role: 'char', content: 'hello', revision: 'sha256:after', updatedAt: 2,
        callerPluginState: {
            metadata: { ledger: { status: 'running' } },
            attachments: [{
                inlayId: 'inlay-1', presentation: 'inline', utf16Offset: 5,
                metadata: { slotId: 'slot-1' },
            }],
        },
    },
    commitId: 'commit-1',
}

const context = (signal = new AbortController().signal) => ({
    principalId: 'plugin-a', instanceId: 'instance-a', displayName: 'Illustration Agent', signal,
})

const harness = (options: {
    adapter?: Partial<InlayAtomicAttachHostAdapter>
    requirePermission?: (permission: string) => Promise<void>
    digest?: (value: unknown) => Promise<string>
    now?: () => number
    signal?: AbortSignal
} = {}) => {
    const adapter: InlayAtomicAttachHostAdapter = {
        current: () => ({ characterId: target.characterId, conversationId: target.conversationId }),
        attachCurrentMessage: vi.fn(async () => result),
        ...options.adapter,
    }
    const requirePermission = vi.fn(async (_context, permission) =>
        options.requirePermission?.(permission))
    const service = new InlayAtomicAttachService(context(options.signal), adapter, {
        requirePermission,
        ledger: new IdempotencyLedger(),
        rateLimiter: new MessageMutationRateLimiter(options.now),
        ...(options.digest ? { digest: options.digest } : {}),
    })
    return { adapter, requirePermission, service }
}

describe('V3 current-message generated Inlay attachment', () => {
    it('maps the exact manual call shape after both permissions and preserves caller bytes', async () => {
        const state = harness()
        const request = input()
        const before = request.data.slice()

        await expect(state.service.attachGeneratedInlayToMessage(request)).resolves.toEqual(result)

        expect(state.requirePermission.mock.calls.map((call) => call[1])).toEqual(['chatWrite', 'inlayWrite'])
        expect(state.adapter.attachCurrentMessage).toHaveBeenCalledOnce()
        const prepared = vi.mocked(state.adapter.attachCurrentMessage).mock.calls[0][0]
        expect(prepared).toMatchObject({ principalId: 'plugin-a', input: { ...request, data: before } })
        expect(prepared.argumentDigest).toMatch(/^[0-9a-f]{64}$/u)
        expect(prepared.input.data).not.toBe(request.data)
        expect(request.data).toEqual(before)
    })

    it('joins identical binary-aware calls and conflicts on changed non-key arguments', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const state = harness({ adapter: { attachCurrentMessage: vi.fn(async () => {
            await gate
            return result
        }) } })

        const first = state.service.attachGeneratedInlayToMessage(input())
        const joined = state.service.attachGeneratedInlayToMessage(input())
        await vi.waitFor(() => expect(state.adapter.attachCurrentMessage).toHaveBeenCalledOnce())
        await expect(state.service.attachGeneratedInlayToMessage(input({ data: Uint8Array.of(1, 2, 4) })))
            .rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(state.service.attachGeneratedInlayToMessage(input({
            placement: { kind: 'utf16-offset', offset: 1 },
        }))).rejects.toMatchObject({ code: 'CONFLICT' })
        release()
        await expect(Promise.all([first, joined])).resolves.toEqual([result, result])
        expect(state.adapter.attachCurrentMessage).toHaveBeenCalledOnce()
    })

    it('rejects every broader mutation shape before reaching the adapter', async () => {
        const invalidInputs = [
            input({ data: 'data:image/png;base64,AA==' as never }),
            input({ inlay: {} as never }),
            input({ presentation: 'styled' as never }),
            input({ placement: { kind: 'replace-own-inlay', inlayId: 'old' } as never }),
            input({ messageMetadata: [] as never }),
            input({ messageMetadata: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }] as never }),
            input({ persist: 'eventual' as never }),
        ]
        for (const invalid of invalidInputs) {
            const state = harness()
            await expect(state.service.attachGeneratedInlayToMessage(invalid))
                .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
            expect(state.adapter.attachCurrentMessage).not.toHaveBeenCalled()
        }
    })

    it('rejects hostile shapes, cycles and unstable message IDs', async () => {
        const accessor = input() as any
        Object.defineProperty(accessor.inlay, 'name', { enumerable: true, get: () => 'slot.png' })
        const cycle: any = {}
        cycle.self = cycle
        const state = harness()

        await expect(state.service.attachGeneratedInlayToMessage(accessor))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(state.service.attachGeneratedInlayToMessage(input({ attachmentMetadata: cycle })))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(state.service.attachGeneratedInlayToMessage(input({
            target: { ...target, messageId: 'legacy-message:0' },
        }))).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('enforces exact byte, name, idempotency and metadata input limits', async () => {
        const exact = harness()
        await expect(exact.service.attachGeneratedInlayToMessage(input({
            data: new Uint8Array(33_554_432),
            inlay: { name: 'a'.repeat(255) },
            idempotencyKey: 'k'.repeat(256),
            attachmentMetadata: 'x'.repeat(65_534),
            messageMetadata: [{ key: 'l', value: null }],
        }))).resolves.toEqual(result)

        for (const over of [
            input({ data: new Uint8Array(33_554_433) }),
            input({ inlay: { name: 'a'.repeat(256) } }),
            input({ idempotencyKey: 'k'.repeat(257) }),
            input({ attachmentMetadata: 'x'.repeat(65_535), messageMetadata: [{ key: 'l', value: null }] }),
        ]) {
            await expect(harness().service.attachGeneratedInlayToMessage(over))
                .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        }
    })

    it('checks current scope around awaits with abort priority', async () => {
        let current = true
        const switched = harness({
            adapter: { current: () => current
                ? { characterId: target.characterId, conversationId: target.conversationId }
                : { characterId: 'other', conversationId: 'other' } },
            requirePermission: async (permission) => { if (permission === 'chatWrite') current = false },
        })
        await expect(switched.service.attachGeneratedInlayToMessage(input()))
            .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

        const controller = new AbortController()
        const aborted = harness({ signal: controller.signal, digest: async () => {
            controller.abort()
            throw new PluginApiError('INTERNAL', 'private digest failure')
        } })
        await expect(aborted.service.attachGeneratedInlayToMessage(input()))
            .rejects.toMatchObject({ code: 'ABORTED' })
    })

    it('allows 30 atomic message mutations per minute and rejects the 31st', async () => {
        let now = 1_000
        const state = harness({ now: () => now })
        for (let index = 0; index < 30; index++) {
            await state.service.attachGeneratedInlayToMessage(input({ idempotencyKey: `key-${index}` }))
        }
        await expect(state.service.attachGeneratedInlayToMessage(input({ idempotencyKey: 'key-30' })))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT', retryAfterMs: 60_000 })
        now += 60_001
        await expect(state.service.attachGeneratedInlayToMessage(input({ idempotencyKey: 'key-31' })))
            .resolves.toEqual(result)
    })
})
