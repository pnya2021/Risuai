import { PluginApiError } from './errors'
import type {
    MessageQueryConversationLocation,
    MessageQueryHostAdapter,
    MessageQueryHostMessage,
} from './messageQuery'

type UnknownRecord = Record<string, any>

export interface RisuMessageQueryAdapterDependencies {
    getDatabase(): { characters?: UnknownRecord[] }
    getCurrentCharacter(): UnknownRecord | undefined
    getCurrentChat(): UnknownRecord | undefined
    preLoadChat(characterIndex: number, chatIndex: number): Promise<void>
    coldStorageHeader: string
    listInlayAssets(): Promise<Array<[string, unknown]>>
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const changed = () => new PluginApiError('CONFLICT', 'Conversation changed during hydration; retry the request', {
    retryable: true,
    details: { reason: 'message-query-changed' },
})

function findExactConversation(
    root: { characters?: UnknownRecord[] },
    target: { characterId: string; conversationId: string },
) {
    const characters = root.characters ?? []
    const characterMatches = characters.flatMap((character, characterIndex) =>
        character?.chaId === target.characterId ? [{ character, characterIndex }] : [])
    if (characterMatches.length !== 1) return undefined
    const { character, characterIndex } = characterMatches[0]
    const chats = Array.isArray(character.chats) ? character.chats : []
    const chatMatches = chats.flatMap((chat: UnknownRecord, chatIndex: number) =>
        chat?.id === target.conversationId ? [{ chat, chatIndex }] : [])
    if (chatMatches.length !== 1) return undefined
    return { character, characterIndex, ...chatMatches[0] }
}

const isColdPointer = (messages: unknown, header: string) => Array.isArray(messages)
    && typeof messages[0]?.data === 'string'
    && messages[0].data.startsWith(header)

const isSyntheticColdFailure = (messages: unknown) => Array.isArray(messages)
    && typeof messages[0]?.data === 'string'
    && messages[0].data.startsWith('[Cold storage data could not be loaded.')

function resolveGroupMembers(root: { characters?: UnknownRecord[] }, group: UnknownRecord) {
    if (group.type !== 'group' || !Array.isArray(group.characters)) return undefined
    const referenceCounts = new Map<string, number>()
    for (const id of group.characters) {
        if (nonEmptyString(id)) referenceCounts.set(id, (referenceCounts.get(id) ?? 0) + 1)
    }
    return group.characters.flatMap((id: unknown) => {
        if (!nonEmptyString(id) || referenceCounts.get(id) !== 1) return []
        const matches = (root.characters ?? []).filter((candidate) => candidate?.chaId === id)
        return matches.length === 1 && matches[0].type === 'character' ? [matches[0]] : []
    })
}

export function createRisuMessageQueryAdapter(
    dependencies: RisuMessageQueryAdapterDependencies,
): MessageQueryHostAdapter {
    return {
        current() {
            const character = dependencies.getCurrentCharacter()
            const chat = dependencies.getCurrentChat()
            if (!nonEmptyString(character?.chaId) || !nonEmptyString(chat?.id)) return null
            return { characterId: character.chaId, conversationId: chat.id }
        },

        async prepareConversation(target) {
            const root = dependencies.getDatabase()
            const located = findExactConversation(root, target)
            if (!located || !isColdPointer(located.chat.message, dependencies.coldStorageHeader)) return
            try {
                await dependencies.preLoadChat(located.characterIndex, located.chatIndex)
            } catch {
                throw changed()
            }
            const currentRoot = dependencies.getDatabase()
            const current = findExactConversation(currentRoot, target)
            if (currentRoot !== root
                || !current
                || current.character !== located.character
                || current.chat !== located.chat
                || !Array.isArray(current.chat.message)
                || isColdPointer(current.chat.message, dependencies.coldStorageHeader)
                || isSyntheticColdFailure(current.chat.message)) throw changed()
        },

        resolveConversation(target): MessageQueryConversationLocation | undefined {
            const root = dependencies.getDatabase()
            const located = findExactConversation(root, target)
            if (!located || !Array.isArray(located.chat.message)
                || isColdPointer(located.chat.message, dependencies.coldStorageHeader)
                || isSyntheticColdFailure(located.chat.message)) return undefined
            const memberCharacters = resolveGroupMembers(root, located.character)
            return {
                rootEpoch: root,
                characterEpoch: located.character,
                conversationEpoch: located.chat,
                messages: located.chat.message as MessageQueryHostMessage[],
                characterId: target.characterId,
                conversationId: target.conversationId,
                currentCharacterId: target.characterId,
                ...(memberCharacters
                    ? {
                        memberCharacterIds: memberCharacters.map((member) => member.chaId as string),
                        memberCharacterEpochs: memberCharacters,
                    }
                    : {}),
                isStreaming: located.chat.isStreaming === true,
            }
        },

        async recognizedInlayIds() {
            try {
                const assets = await dependencies.listInlayAssets()
                return new Set(assets.flatMap((entry) => Array.isArray(entry) && nonEmptyString(entry[0])
                    ? [entry[0]] : []))
            } catch {
                throw new PluginApiError('INTERNAL', 'Unable to enumerate Inlay references', { retryable: true })
            }
        },
    }
}
