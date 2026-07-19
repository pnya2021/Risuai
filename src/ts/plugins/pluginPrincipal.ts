export interface PrincipalPluginRecord {
    name: string
    script: string
    principalId?: string
}

export type PluginRecordMutationKind =
    | 'fresh-install'
    | 'trusted-update'
    | 'hot-reload'
    | 'manual-replacement'
    | 'programmatic'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOMBSTONE_KEY = 'risu.plugin-principal-tombstones.v1'
const MAX_TOMBSTONES = 4096
const tombstones = new Set<string>()
let tombstonesLoaded = false

const loadTombstones = () => {
    if (tombstonesLoaded) return
    tombstonesLoaded = true
    try {
        const parsed = JSON.parse(globalThis.localStorage?.getItem(TOMBSTONE_KEY) ?? '[]')
        if (Array.isArray(parsed)) {
            for (const id of parsed.slice(-MAX_TOMBSTONES)) {
                if (typeof id === 'string' && UUID_V4.test(id)) tombstones.add(id)
            }
        }
    } catch {
        // Device storage is best-effort; the in-memory tombstone remains authoritative.
    }
}

const persistTombstones = () => {
    try {
        globalThis.localStorage?.setItem(TOMBSTONE_KEY, JSON.stringify([...tombstones].slice(-MAX_TOMBSTONES)))
    } catch {
        // A blocked localStorage must not make uninstall fail.
    }
}

const newPrincipalId = (
    randomUUID: () => string = () => crypto.randomUUID(),
    excluded: ReadonlySet<string> = new Set(),
) => {
    let id = randomUUID()
    while (!isCanonicalPluginPrincipalId(id) || tombstones.has(id) || excluded.has(id)) id = randomUUID()
    return id
}

export const isCanonicalPluginPrincipalId = (value: unknown): value is string =>
    typeof value === 'string' && UUID_V4.test(value)

export function stripPluginPrincipal<T extends PrincipalPluginRecord>(record: T): Omit<T, 'principalId'> {
    const publicRecord = { ...record }
    delete publicRecord.principalId
    return publicRecord
}

export function invalidatePluginPrincipal(principalId: string) {
    if (!isCanonicalPluginPrincipalId(principalId)) return
    loadTombstones()
    tombstones.delete(principalId)
    tombstones.add(principalId)
    while (tombstones.size > MAX_TOMBSTONES) tombstones.delete(tombstones.values().next().value!)
    persistTombstones()
}

export function isPluginPrincipalInvalidated(principalId: string) {
    loadTombstones()
    return tombstones.has(principalId)
}

export function clearPrincipalTombstonesForTests() {
    tombstones.clear()
    tombstonesLoaded = true
    try { globalThis.localStorage?.removeItem(TOMBSTONE_KEY) } catch { /* test cleanup */ }
}

export function preparePluginRecord<T extends PrincipalPluginRecord>(
    incoming: T,
    current: T | undefined,
    options: { kind: PluginRecordMutationKind; randomUUID?: () => string },
): T & { principalId: string } {
    loadTombstones()
    const sanitized = { ...incoming }
    delete sanitized.principalId
    const mayRetain = !!current && isCanonicalPluginPrincipalId(current.principalId)
        && !tombstones.has(current.principalId)
        && (options.kind === 'trusted-update'
            || options.kind === 'hot-reload'
            || (options.kind === 'programmatic' && current.script === incoming.script))
    return {
        ...sanitized,
        principalId: mayRetain ? current!.principalId! : newPrincipalId(options.randomUUID),
    } as T & { principalId: string }
}

export function normalizePluginPrincipals<T extends PrincipalPluginRecord>(
    records: T[],
    options: {
        randomUUID?: () => string
        preserveTombstonedPrincipal?: (principalId: string) => boolean
    } = {},
): { records: Array<T & { principalId: string }>; changed: boolean } {
    loadTombstones()
    const seen = new Set<string>()
    let changed = false
    const normalized = records.map((record) => {
        let principalId = record.principalId
        if (!isCanonicalPluginPrincipalId(principalId) || seen.has(principalId)
            || (tombstones.has(principalId) && !options.preserveTombstonedPrincipal?.(principalId))) {
            principalId = newPrincipalId(options.randomUUID, seen)
            changed = true
        }
        seen.add(principalId)
        if (record.principalId === principalId) return record as T & { principalId: string }
        return { ...record, principalId } as T & { principalId: string }
    })
    return { records: normalized, changed }
}

export function reconcileProgrammaticPluginRecords<T extends PrincipalPluginRecord>(
    current: T[],
    incoming: T[],
    options: { randomUUID?: () => string } = {},
): { records: Array<T & { principalId: string }>; invalidatedPrincipalIds: string[] } {
    const currentByName = new Map(current.map((record) => [record.name, record]))
    const retained = new Set<string>()
    const assigned = new Set<string>()
    const randomUUID = options.randomUUID ?? (() => crypto.randomUUID())
    const allocateUnassignedUuid = () => {
        let principalId = randomUUID()
        while (assigned.has(principalId)) principalId = randomUUID()
        return principalId
    }
    const records = incoming.map((record) => {
        const existing = currentByName.get(record.name)
        let prepared = preparePluginRecord(record, existing, { kind: 'programmatic', randomUUID: allocateUnassignedUuid })
        if (assigned.has(prepared.principalId)) {
            prepared = preparePluginRecord(record, undefined, { kind: 'fresh-install', randomUUID: allocateUnassignedUuid })
        }
        assigned.add(prepared.principalId)
        if (existing?.principalId === prepared.principalId) retained.add(prepared.principalId)
        return prepared
    })
    const invalidatedPrincipalIds = current
        .map((record) => record.principalId)
        .filter((principalId): principalId is string => isCanonicalPluginPrincipalId(principalId) && !retained.has(principalId))
    return { records, invalidatedPrincipalIds: [...new Set(invalidatedPrincipalIds)] }
}
