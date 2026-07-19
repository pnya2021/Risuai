export interface ColdDatabaseHydrationAdapter<TDatabase> {
    setDatabase(data: TDatabase): { pluginStateChanged: boolean }
    getSnapshot(): TDatabase
    setPatchSyncBaseline?(data: TDatabase): void
}

type DurableDatabaseWriter = () => Promise<void>

let requestedGeneration = 0
let persistedGeneration = 0
let writebackInFlight: Promise<boolean> | null = null
let registeredWriter: DurableDatabaseWriter | null = null

export function requestColdDatabaseWriteback() { requestedGeneration += 1 }

export function registerColdDatabaseWritebackWriter(writer: DurableDatabaseWriter) {
    registeredWriter = writer
    return () => {
        if (registeredWriter === writer) registeredWriter = null
    }
}

export function hasPendingColdDatabaseWriteback() {
    return persistedGeneration < requestedGeneration
}

export function hydrateColdDatabase<TDatabase>(data: TDatabase, adapter: ColdDatabaseHydrationAdapter<TDatabase>) {
    const result = adapter.setDatabase(data)
    adapter.setPatchSyncBaseline?.(adapter.getSnapshot())
    if (result.pluginStateChanged) requestColdDatabaseWriteback()
    return result
}

export async function flushColdDatabaseWriteback(writeFullDatabase?: DurableDatabaseWriter) {
    if (writebackInFlight) return writebackInFlight
    if (!hasPendingColdDatabaseWriteback()) return false

    const writer = writeFullDatabase ?? registeredWriter
    if (!writer) {
        throw new Error('Cold database writeback is pending but no durable writer is registered')
    }

    const targetGeneration = requestedGeneration
    let operation!: Promise<boolean>
    operation = (async () => {
        try {
            await writer()
            persistedGeneration = Math.max(persistedGeneration, targetGeneration)
            return true
        } finally {
            if (writebackInFlight === operation) writebackInFlight = null
        }
    })()
    writebackInFlight = operation
    return operation
}

export async function ensureColdDatabaseWriteback(writeFullDatabase?: DurableDatabaseWriter) {
    let wrote = false
    while (hasPendingColdDatabaseWriteback()) {
        wrote = await flushColdDatabaseWriteback(writeFullDatabase) || wrote
    }
    return wrote
}

export async function runAfterColdDatabaseWriteback<T>(operation: () => T | Promise<T>) {
    await ensureColdDatabaseWriteback()
    return operation()
}

export async function loadPluginsAfterColdDatabaseWriteback<T>(
    writeFullDatabase: DurableDatabaseWriter, loadPlugins: () => T | Promise<T>,
) {
    await ensureColdDatabaseWriteback(writeFullDatabase)
    return loadPlugins()
}
