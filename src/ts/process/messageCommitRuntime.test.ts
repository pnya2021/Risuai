import { describe, expect, it, vi } from 'vitest'

vi.mock('../parser/parser.svelte', () => ({
    applyMarkdownToNode: vi.fn(),
    assetRegex: /$^/,
    hasher: vi.fn(),
    parseMarkdownSafe: vi.fn(),
    risuChatParser: vi.fn((value: string) => value),
    risuEscape: vi.fn((value: string) => value),
    risuUnescape: vi.fn((value: string) => value),
}))

vi.mock('./modules', () => ({
    getModuleAssets: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleMcps: vi.fn(() => []),
    getModuleRegexScripts: vi.fn(() => []),
    getModuleToggles: vi.fn(() => []),
    getModuleTriggers: vi.fn(() => []),
    moduleUpdate: vi.fn(),
}))

import type { Message } from '../storage/database.svelte'
import {
    collectTerminalMessageCommitCandidates,
    reconcileGeneratedRerollTail,
} from '../plugins/apiV3/illustration/messageEvents.risu'
import { reconcileTerminalContinueMessage } from './index.svelte'

const message = (overrides: Partial<Message>): Message => ({
    role: 'char', data: 'text', ...overrides,
})

describe('terminal generation message commits', () => {
    it('keeps appended trigger generation when the stable Continue target still exists', () => {
        const before = [message({
            chatId: 'stable-continue',
            time: 10,
            saying: 'member-a',
            data: 'before',
            generationInfo: { generationId: 'stable-generation' },
        })]
        const after = [
            message({
                chatId: 'stable-continue',
                time: 10,
                saying: 'member-a',
                data: 'continued',
                generationInfo: { generationId: 'stable-generation' },
            }),
            message({
                chatId: 'trigger-generated',
                time: 20,
                saying: 'member-b',
                data: 'terminal trigger output',
                generationInfo: { generationId: 'trigger-generation' },
            }),
        ]

        reconcileTerminalContinueMessage(before, after, 'stable-continue', 30)

        expect(after.map((item) => ({
            chatId: item.chatId,
            data: item.data,
            saying: item.saying,
            generationId: item.generationInfo?.generationId,
        }))).toEqual([
            {
                chatId: 'stable-continue',
                data: 'continued',
                saying: 'member-a',
                generationId: 'stable-generation',
            },
            {
                chatId: 'trigger-generated',
                data: 'terminal trigger output',
                saying: 'member-b',
                generationId: 'trigger-generation',
            },
        ])
    })

    it('reconciles a generated group reroll by bounded position while keeping the new speaker and generation', () => {
        const originals = [
            message({
                chatId: 'stable-a', saying: 'member-a', time: 10,
                data: 'old-a{{inlay::owned}}',
                generationInfo: { generationId: 'old-generation-a' },
                pluginMessageState: {
                    principal: {
                        metadata: { keep: true },
                        attachments: [{ inlayId: 'owned', presentation: 'inline' }],
                    },
                },
            }),
            message({ chatId: 'stable-b', saying: 'member-b', time: 20 }),
        ]
        const replacements = [
            message({
                chatId: 'temporary-a', saying: 'member-c', data: 'new-a',
                generationInfo: { generationId: 'new-generation-a' },
            }),
            message({
                chatId: 'temporary-b', saying: 'member-b', data: 'new-b',
                generationInfo: { generationId: 'new-generation-b' },
            }),
        ]

        const reconciled = reconcileGeneratedRerollTail(originals, replacements, 100)

        expect(reconciled.map((item) => ({
            chatId: item.chatId,
            saying: item.saying,
            generationId: item.generationInfo?.generationId,
            data: item.data,
        }))).toEqual([
            { chatId: 'stable-a', saying: 'member-c', generationId: 'new-generation-a', data: 'new-a{{inlay::owned}}' },
            { chatId: 'stable-b', saying: 'member-b', generationId: 'new-generation-b', data: 'new-b' },
        ])
        expect(reconciled[0].pluginMessageState).toEqual(originals[0].pluginMessageState)
        expect(reconciled[0].time).toBe(10)
    })

    it('classifies the primary terminal message and output-trigger changes in stable conversation order', () => {
        const before = [
            message({ chatId: 'primary', data: 'before', generationInfo: { generationId: 'generation' } }),
            message({ chatId: 'trigger-old', data: 'old-trigger' }),
        ]
        const after = [
            message({ chatId: 'primary', data: 'after', generationInfo: { generationId: 'generation' } }),
            message({ chatId: 'trigger-old', data: 'updated-trigger' }),
            message({ chatId: 'trigger-new', data: 'new-trigger' }),
            message({ role: 'user', chatId: 'ignored-user', data: 'ignored' }),
        ]

        expect(collectTerminalMessageCommitCandidates({
            before,
            after,
            primaryCause: 'continue',
            primaryMessageIds: new Set(['primary']),
        }).map((candidate) => ({
            id: candidate.message.chatId,
            change: candidate.change,
            cause: candidate.cause,
        }))).toEqual([
            { id: 'primary', change: 'updated', cause: 'continue' },
            { id: 'trigger-old', change: 'updated', cause: 'trigger' },
            { id: 'trigger-new', change: 'created', cause: 'trigger' },
        ])
    })
})
