import type { Message } from 'src/ts/storage/database.svelte'

import type { CapturedMessageCommit, MessageCommitCause } from './messageEvents'
import {
    captureMessageSnapshotSource,
    messageRevisionValue,
    projectLogicalContent,
    resolveLogicalInsertionOffset,
    type MessageQueryHostMessage,
} from './messageQuery'
import { createRevision } from './revision'

type HostMessage = MessageQueryHostMessage

const managedInlayIds = (message: MessageQueryHostMessage) => {
    const ids = new Set<string>()
    const root = message.pluginMessageState
    if (!root || typeof root !== 'object' || Array.isArray(root)) return ids
    for (const state of Object.values(root as Record<string, unknown>)) {
        if (!state || typeof state !== 'object' || Array.isArray(state)) continue
        const attachments = (state as Record<string, unknown>).attachments
        if (!Array.isArray(attachments)) continue
        for (const attachment of attachments) {
            if (attachment && typeof attachment === 'object'
                && typeof (attachment as Record<string, unknown>).inlayId === 'string') {
                ids.add((attachment as Record<string, unknown>).inlayId as string)
            }
        }
    }
    return ids
}

const restoreManagedMarkers = (previous: MessageQueryHostMessage, replacementData: string) => {
    const recognized = managedInlayIds(previous)
    if (recognized.size === 0) return replacementData
    const previousProjection = projectLogicalContent(previous.data, recognized)
    const alreadyPresent = new Set(projectLogicalContent(replacementData, recognized).markers.map((marker) => marker.id))
    let data = replacementData
    for (const marker of previousProjection.markers) {
        if (alreadyPresent.has(marker.id)) continue
        const projection = projectLogicalContent(data, recognized)
        const offset = Math.min(marker.utf16Offset, projection.content.length)
        const rawOffset = resolveLogicalInsertionOffset(data, recognized, {
            kind: 'utf16-offset', offset,
        })
        if (rawOffset === null) continue
        data = data.slice(0, rawOffset) + previous.data.slice(marker.rawStart, marker.rawEnd) + data.slice(rawOffset)
        alreadyPresent.add(marker.id)
    }
    return data
}

export function applyContinueMessageIdentity<T extends HostMessage>(
    previous: T,
    replacement: T,
    now = Date.now(),
): T {
    return {
        ...replacement,
        data: restoreManagedMarkers(previous, replacement.data),
        role: previous.role,
        saying: previous.saying,
        chatId: previous.chatId,
        time: previous.time,
        generationInfo: {
            ...replacement.generationInfo,
            generationId: previous.generationInfo?.generationId,
        },
        pluginMessageState: previous.pluginMessageState,
        pluginMessageUpdatedAt: now,
    }
}

export function applyRerollMessageIdentity<T extends HostMessage>(
    previous: T,
    replacement: T,
    now = Date.now(),
): T {
    return {
        ...replacement,
        data: restoreManagedMarkers(previous, replacement.data),
        chatId: previous.chatId,
        time: previous.time,
        pluginMessageState: previous.pluginMessageState,
        pluginMessageUpdatedAt: now,
    }
}

export function reconcileGeneratedRerollTail(
    originals: Message[],
    replacements: Message[],
    now = Date.now(),
) {
    return replacements.map((replacement, index) => {
        const original = originals[index]
        return original?.role === 'char'
            && replacement.role === 'char'
            && typeof replacement.generationInfo?.generationId === 'string'
            ? applyRerollMessageIdentity(original as HostMessage, replacement as HostMessage, now) as Message
            : replacement
    })
}

export function collectTerminalMessageCommitCandidates(input: {
    before: Message[]
    after: Message[]
    primaryCause: Extract<MessageCommitCause, 'model' | 'continue' | 'reroll'>
    primaryMessageIds: ReadonlySet<string>
}) {
    const beforeById = new Map(input.before.flatMap((message) =>
        typeof message.chatId === 'string' ? [[message.chatId, message] as const] : []))
    return input.after.flatMap((message) => {
        if (message.role !== 'char' || typeof message.chatId !== 'string') return []
        const previous = beforeById.get(message.chatId)
        if (previous && JSON.stringify(messageRevisionValue(previous)) === JSON.stringify(messageRevisionValue(message))) {
            return []
        }
        return [{
            message,
            change: previous ? 'updated' as const : 'created' as const,
            cause: input.primaryMessageIds.has(message.chatId) ? input.primaryCause : 'trigger' as const,
        }]
    })
}

export interface RisuMessageCommitCandidate {
    characterId: string
    conversationId: string
    currentCharacterId: string
    memberCharacterIds?: string[]
    message: Message | MessageQueryHostMessage
    change: 'created' | 'updated'
    cause: MessageCommitCause
}

export function createRisuMessageCommitRuntime(dependencies: {
    recognizedInlayIds(): Promise<ReadonlySet<string>>
    waitForMessagePersistence(
        target: { characterId: string; conversationId: string; messageId: string },
        revision: string,
    ): Promise<void>
    requestDatabaseSaveNow(): void
    publish(commit: CapturedMessageCommit): void
    createId?: () => string
}) {
    return {
        async commit(candidates: RisuMessageCommitCandidate[]) {
            const eligible = candidates.filter((candidate) => candidate.message.role === 'char'
                && typeof candidate.message.chatId === 'string'
                && candidate.message.chatId.length > 0
                && !candidate.message.chatId.startsWith('legacy-message:'))
            if (eligible.length === 0) return
            const recognizedInlayIds = await dependencies.recognizedInlayIds()
            const records: Array<{ state: CapturedMessageCommit; persisted: CapturedMessageCommit }> = []
            for (const candidate of eligible) {
                const source = captureMessageSnapshotSource({
                    characterId: candidate.characterId,
                    conversationId: candidate.conversationId,
                    currentCharacterId: candidate.currentCharacterId,
                    memberCharacterIds: candidate.memberCharacterIds,
                    message: candidate.message,
                    recognizedInlayIds,
                })
                const target = {
                    characterId: candidate.characterId,
                    conversationId: candidate.conversationId,
                    messageId: source.message.chatId!,
                }
                const eventId = dependencies.createId?.() ?? crypto.randomUUID()
                const revision = await createRevision(messageRevisionValue(source.message))
                const base = {
                    eventId,
                    target,
                    revision,
                    role: 'char' as const,
                    change: candidate.change,
                    cause: candidate.cause,
                    source,
                }
                records.push({
                    state: { ...base, durability: 'state' },
                    persisted: { ...base, durability: 'persisted' },
                })
            }
            for (const record of records) dependencies.publish(record.state)
            const waits = records.map((record) =>
                dependencies.waitForMessagePersistence(record.state.target, record.state.revision))
            dependencies.requestDatabaseSaveNow()
            void Promise.allSettled(waits).then((settled) => {
                for (let index = 0; index < records.length; index += 1) {
                    if (settled[index].status === 'fulfilled') dependencies.publish(records[index].persisted)
                }
            })
        },
    }
}

const commitListeners = new Set<(commit: CapturedMessageCommit) => void>()

export function subscribeRisuMessageCommits(listener: (commit: CapturedMessageCommit) => void) {
    commitListeners.add(listener)
    return () => { commitListeners.delete(listener) }
}

export async function commitRisuMessages(candidates: RisuMessageCommitCandidate[]) {
    if (candidates.length === 0) return
    const [{ listInlayAssets }, persistence] = await Promise.all([
        import('src/ts/process/files/inlays'),
        import('src/ts/globalApi.svelte'),
    ])
    const runtime = createRisuMessageCommitRuntime({
        recognizedInlayIds: async () => new Set((await listInlayAssets()).map(([id]) => id)),
        waitForMessagePersistence: persistence.waitForMessagePersistence,
        requestDatabaseSaveNow: persistence.requestDatabaseSaveNow,
        publish: (commit) => {
            for (const listener of commitListeners) listener(commit)
        },
    })
    await runtime.commit(candidates)
}
