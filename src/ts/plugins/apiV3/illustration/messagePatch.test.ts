import { describe, expect, it, vi } from 'vitest'
import { IdempotencyLedger } from './idempotency'
import { PluginApiError } from './errors'
import type { PluginExecutionContext, PluginPermissionId } from './permissions'
import {
    MessageMutationRateLimiter,
    MessagePatchService,
    type MessagePatchHostAdapter,
    type MessagePatchInput,
} from './messagePatch'

const context = {
    principalId: 'plugin-a',
    instanceId: 'instance-a',
    displayName: 'Illustration Agent',
    signal: new AbortController().signal,
}

describe('V3 current-message metadata patch', () => {
    it('persists caller metadata and returns the committed snapshot', async () => {
        const adapter: MessagePatchHostAdapter = {
            current: () => ({ characterId: 'character-1', conversationId: 'conversation-1' }),
            patchCurrentMessage: vi.fn(async () => ({
                changed: true,
                message: {
                    characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1',
                    role: 'char' as const, content: 'hello', revision: 'sha256:after', updatedAt: 2,
                    callerPluginState: { metadata: { ledger: { prefix: 1 } }, attachments: [] as never[] },
                },
                commitId: 'commit-1',
            })),
        }
        const requirePermission = vi.fn(async (
            _context: PluginExecutionContext,
            _permission: PluginPermissionId,
        ) => undefined)
        const service = new MessagePatchService(context, adapter, { requirePermission })

        await expect(service.patchMessage({
            target: { characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1' },
            expectedRevision: 'sha256:before',
            patch: { op: 'setPluginMetadata', key: 'ledger', value: { prefix: 1 } },
            idempotencyKey: 'ledger-1',
            persist: 'immediate',
        })).resolves.toMatchObject({
            changed: true,
            commitId: 'commit-1',
            message: { callerPluginState: { metadata: { ledger: { prefix: 1 } }, attachments: [] } },
        })
        expect(requirePermission).toHaveBeenCalledWith(context, 'chatWrite')
    })

    const input = (overrides: Partial<MessagePatchInput> = {}): MessagePatchInput => ({
        target: { characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1' },
        expectedRevision: 'sha256:before',
        patch: { op: 'setPluginMetadata', key: 'ledger', value: 1 },
        idempotencyKey: 'ledger-1',
        persist: 'immediate',
        ...overrides,
    })

    const result = {
        changed: true,
        message: {
            characterId: 'character-1', conversationId: 'conversation-1', messageId: 'message-1',
            role: 'char' as const, content: 'hello', revision: 'sha256:after', updatedAt: 2,
            callerPluginState: { metadata: { ledger: 1 }, attachments: [] as never[] },
        },
        commitId: 'commit-1',
    }

    const serviceHarness = (options: {
        adapter?: Partial<MessagePatchHostAdapter>
        requirePermission?: (
            context: PluginExecutionContext,
            permission: PluginPermissionId,
        ) => Promise<void>
        now?: () => number
        digest?: (value: unknown) => Promise<string>
        signal?: AbortSignal
    } = {}) => {
        const adapter: MessagePatchHostAdapter = {
            current: () => ({ characterId: 'character-1', conversationId: 'conversation-1' }),
            patchCurrentMessage: vi.fn(async () => result),
            ...options.adapter,
        }
        const service = new MessagePatchService(
            { ...context, ...(options.signal ? { signal: options.signal } : {}) },
            adapter,
            {
                requirePermission: options.requirePermission ?? (async () => undefined),
                ledger: new IdempotencyLedger(),
                rateLimiter: new MessageMutationRateLimiter(options.now),
                ...(options.digest ? { digest: options.digest } : {}),
            },
        )
        return { adapter, service }
    }

    it('joins identical in-flight calls and conflicts on different canonical arguments', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const state = serviceHarness({ adapter: {
            patchCurrentMessage: vi.fn(async () => {
                await gate
                return result
            }),
        } })

        const first = state.service.patchMessage(input())
        const joined = state.service.patchMessage(input())
        await vi.waitFor(() => expect(state.adapter.patchCurrentMessage).toHaveBeenCalledTimes(1))
        await expect(state.service.patchMessage(input({
            patch: { op: 'setPluginMetadata', key: 'ledger', value: 2 },
        }))).rejects.toMatchObject({ code: 'CONFLICT' })
        release()
        await expect(Promise.all([first, joined])).resolves.toEqual([result, result])
        expect(state.adapter.patchCurrentMessage).toHaveBeenCalledTimes(1)
    })

    it('normalizes own Inlay attach, replacement, metadata, and detach with the matching permission', async () => {
        const requirePermission = vi.fn(async (
            _context: PluginExecutionContext,
            _permission: PluginPermissionId,
        ) => undefined)
        const state = serviceHarness({ requirePermission })

        await state.service.patchMessage(input({
            patch: {
                op: 'attachInlay',
                inlayId: 'inlay-new',
                presentation: 'inline',
                metadata: { slot: 1 },
            },
            idempotencyKey: 'attach-1',
        } as never))
        await state.service.patchMessage(input({
            patch: {
                op: 'attachInlay',
                inlayId: 'inlay-replacement',
                presentation: 'inline',
                placement: { kind: 'replace-own-inlay', inlayId: 'inlay-old' },
            },
            idempotencyKey: 'replace-1',
        } as never))
        await state.service.patchMessage(input({
            patch: {
                op: 'setOwnInlayMetadata',
                inlayId: 'inlay-old',
                value: { locked: true },
            },
            idempotencyKey: 'metadata-1',
        } as never))
        await state.service.patchMessage(input({
            patch: { op: 'detachOwnInlay', inlayId: 'inlay-old' },
            idempotencyKey: 'detach-1',
        } as never))

        expect(requirePermission.mock.calls.map(([, permission]) => permission)).toEqual([
            'chatWrite', 'inlayWrite',
            'chatWrite', 'inlayWrite',
            'chatWrite', 'inlayWrite',
            'chatWrite', 'inlayWrite',
        ])
        expect(state.adapter.patchCurrentMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
            input: expect.objectContaining({
                patch: {
                    op: 'attachInlay',
                    inlayId: 'inlay-new',
                    presentation: 'inline',
                    placement: { kind: 'end' },
                    metadata: { slot: 1 },
                },
            }),
        }))
        expect(state.adapter.patchCurrentMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
            input: expect.objectContaining({
                patch: {
                    op: 'attachInlay',
                    inlayId: 'inlay-replacement',
                    presentation: 'inline',
                    placement: { kind: 'replace-own-inlay', inlayId: 'inlay-old' },
                },
            }),
        }))
        expect(state.adapter.patchCurrentMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({
            input: expect.objectContaining({
                patch: {
                    op: 'setOwnInlayMetadata',
                    inlayId: 'inlay-old',
                    value: { locked: true },
                },
            }),
        }))
        expect(state.adapter.patchCurrentMessage).toHaveBeenNthCalledWith(4, expect.objectContaining({
            input: expect.objectContaining({
                patch: { op: 'detachOwnInlay', inlayId: 'inlay-old' },
            }),
        }))
    })

    it.each([
        ['non-inline presentation', {
            op: 'attachInlay', inlayId: 'inlay-new', presentation: 'styled',
        }],
        ['invalid UTF-16 offset', {
            op: 'attachInlay', inlayId: 'inlay-new', presentation: 'inline',
            placement: { kind: 'utf16-offset', offset: -1 },
        }],
        ['empty replacement target', {
            op: 'attachInlay', inlayId: 'inlay-new', presentation: 'inline',
            placement: { kind: 'replace-own-inlay', inlayId: '' },
        }],
        ['extraneous detach metadata', {
            op: 'detachOwnInlay', inlayId: 'inlay-old', metadata: { hidden: true },
        }],
        ['missing own Inlay metadata value', {
            op: 'setOwnInlayMetadata', inlayId: 'inlay-old', metadata: { locked: true },
        }],
    ])('rejects %s before any permission or adapter call', async (_label, patch) => {
        const requirePermission = vi.fn(async () => undefined)
        const state = serviceHarness({ requirePermission })

        await expect(state.service.patchMessage(input({ patch } as never)))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        expect(requirePermission).not.toHaveBeenCalled()
        expect(state.adapter.patchCurrentMessage).not.toHaveBeenCalled()
    })

    it('rejects non-current targets before prompting and rechecks after permission awaits', async () => {
        const requirePermission = vi.fn(async () => undefined)
        const nonCurrent = serviceHarness({
            adapter: { current: () => ({ characterId: 'other', conversationId: 'elsewhere' }) },
            requirePermission,
        })
        await expect(nonCurrent.service.patchMessage(input())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(requirePermission).not.toHaveBeenCalled()

        let current = true
        const switched = serviceHarness({
            adapter: { current: () => current
                ? { characterId: 'character-1', conversationId: 'conversation-1' }
                : { characterId: 'other', conversationId: 'elsewhere' } },
            requirePermission: async () => { current = false },
        })
        await expect(switched.service.patchMessage(input())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(switched.adapter.patchCurrentMessage).not.toHaveBeenCalled()
    })

    it.each(['permission', 'digest'] as const)(
        'prioritizes a lost current scope over a rejecting %s dependency',
        async (boundary) => {
            let current = true
            const rejectAfterSwitch = async () => {
                current = false
                throw new PluginApiError('INTERNAL', 'private dependency error', { retryable: true })
            }
            const state = serviceHarness({
                adapter: { current: () => current
                    ? { characterId: 'character-1', conversationId: 'conversation-1' }
                    : { characterId: 'other', conversationId: 'elsewhere' } },
                requirePermission: boundary === 'permission' ? rejectAfterSwitch : async () => undefined,
                ...(boundary === 'digest' ? { digest: rejectAfterSwitch } : {}),
            })

            await expect(state.service.patchMessage(input())).rejects.toMatchObject({
                code: 'PERMISSION_DENIED', message: 'Message target is not current',
            })
            expect(state.adapter.patchCurrentMessage).not.toHaveBeenCalled()
        },
    )

    it('preserves a typed stable permission rejection and gives abort priority', async () => {
        const stable = serviceHarness({
            requirePermission: async () => {
                throw new PluginApiError('PERMISSION_DENIED', 'permission was denied')
            },
        })
        await expect(stable.service.patchMessage(input())).rejects.toMatchObject({
            code: 'PERMISSION_DENIED', message: 'permission was denied',
        })

        const controller = new AbortController()
        const aborted = serviceHarness({
            signal: controller.signal,
            digest: async () => {
                controller.abort()
                throw new PluginApiError('INTERNAL', 'private digest failure')
            },
        })
        await expect(aborted.service.patchMessage(input())).rejects.toMatchObject({ code: 'ABORTED' })
    })

    it.each([
        ['other operation', { patch: { op: 'appendText', text: 'x' } }],
        ['eventual persistence', { persist: 'eventual' }],
        ['legacy message ID', { target: {
            characterId: 'character-1', conversationId: 'conversation-1', messageId: 'legacy-message:0',
        } }],
    ])('rejects unsupported %s without reaching the adapter', async (_label, override) => {
        const state = serviceHarness()
        await expect(state.service.patchMessage(input(override as never))).rejects.toMatchObject({
            code: _label === 'legacy message ID' ? 'CONFLICT' : 'INVALID_ARGUMENT',
        })
        expect(state.adapter.patchCurrentMessage).not.toHaveBeenCalled()
    })

    it('rejects accessors, cycles and values beyond depth 32', async () => {
        const accessor = { op: 'setPluginMetadata', key: 'ledger', value: 1 }
        Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 })
        const cycle: any = {}
        cycle.self = cycle
        let depth32: unknown = 1
        for (let index = 0; index < 31; index++) depth32 = [depth32]
        const depth33: unknown = [depth32]
        const state = serviceHarness()

        await expect(state.service.patchMessage(input({ patch: accessor as never })))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(state.service.patchMessage(input({
            patch: { op: 'setPluginMetadata', key: 'ledger', value: cycle },
        }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(state.service.patchMessage(input({
            patch: { op: 'setPluginMetadata', key: 'ledger', value: depth32 as never },
            idempotencyKey: 'depth-32',
        }))).resolves.toMatchObject({ commitId: 'commit-1' })
        await expect(state.service.patchMessage(input({
            patch: { op: 'setPluginMetadata', key: 'ledger', value: depth33 as never },
            idempotencyKey: 'depth-33',
        }))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })

    it('enforces exact JSON and idempotency UTF-8 input boundaries', async () => {
        const state = serviceHarness()
        await expect(state.service.patchMessage(input({
            patch: { op: 'setPluginMetadata', key: 'ledger', value: 'x'.repeat(65_534) },
            idempotencyKey: 'a'.repeat(256),
        }))).resolves.toMatchObject({ commitId: 'commit-1' })
        await expect(state.service.patchMessage(input({
            patch: { op: 'setPluginMetadata', key: 'ledger', value: 'x'.repeat(65_535) },
            idempotencyKey: 'json-over',
        }))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(state.service.patchMessage(input({ idempotencyKey: 'a'.repeat(257) })))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })

    it('allows 30 distinct attempts per minute and rejects the 31st with retry timing', async () => {
        let now = 1_000
        const state = serviceHarness({ now: () => now })
        for (let index = 0; index < 30; index++) {
            await state.service.patchMessage(input({ idempotencyKey: `key-${index}` }))
        }
        await expect(state.service.patchMessage(input({ idempotencyKey: 'key-30' })))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT', retryable: true, retryAfterMs: 60_000 })
        now += 60_001
        await expect(state.service.patchMessage(input({ idempotencyKey: 'key-31' })))
            .resolves.toMatchObject({ commitId: 'commit-1' })
    })
})
