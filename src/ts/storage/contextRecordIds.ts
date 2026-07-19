type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
    value !== null && typeof value === 'object'

const isUsableId = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0

const nextUniqueId = (
    reserved: Set<string>,
    assigned: Set<string>,
    createId: () => string,
) => {
    for (let attempt = 0; attempt < 1_024; attempt++) {
        const candidate = createId()
        if (isUsableId(candidate) && !reserved.has(candidate) && !assigned.has(candidate)) return candidate
    }
    throw new Error('Unable to allocate a unique persisted context ID')
}

/** Normalizes stable IDs on persisted records before the database becomes visible to plugins. */
export function normalizeContextRecordIds(
    data: { characters?: unknown },
    createId: () => string = () => crypto.randomUUID(),
) {
    const characters = Array.isArray(data.characters)
        ? data.characters.filter(isRecord)
        : []
    const reservedCharacterIds = new Set(characters.map((character) => character.chaId).filter(isUsableId))
    const assignedCharacterIds = new Set<string>()
    let contextIdsChanged = false

    for (const character of characters) {
        const current = character.chaId
        if (isUsableId(current) && !assignedCharacterIds.has(current)) {
            assignedCharacterIds.add(current)
            continue
        }
        const replacement = nextUniqueId(reservedCharacterIds, assignedCharacterIds, createId)
        character.chaId = replacement
        reservedCharacterIds.add(replacement)
        assignedCharacterIds.add(replacement)
        contextIdsChanged = true
    }

    const chats = characters.flatMap((character) => Array.isArray(character.chats)
        ? character.chats.filter(isRecord)
        : [])
    const reservedConversationIds = new Set(chats.map((chat) => chat.id).filter(isUsableId))
    const assignedConversationIds = new Set<string>()
    for (const chat of chats) {
        const current = chat.id
        if (isUsableId(current) && !assignedConversationIds.has(current)) {
            assignedConversationIds.add(current)
            continue
        }
        const replacement = nextUniqueId(reservedConversationIds, assignedConversationIds, createId)
        chat.id = replacement
        reservedConversationIds.add(replacement)
        assignedConversationIds.add(replacement)
        contextIdsChanged = true
    }

    return { contextIdsChanged }
}
