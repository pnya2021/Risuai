export interface PluginRuntimeReplacementAdapter {
    suspend(): void | Promise<void>
    resume(): void | Promise<void>
    failClosed?(): void | Promise<void>
    release?(): void
}

export interface RuntimePluginRecord {
    principalId?: string
    name: string
    script: string
    version?: number | string
    enabled?: boolean
}

export function isCurrentPluginRuntimeRecord(
    candidate: RuntimePluginRecord,
    installed: readonly RuntimePluginRecord[],
    isRetiring: (principalId: string) => boolean,
) {
    if (!candidate.principalId || isRetiring(candidate.principalId)) return false
    const current = installed.find((plugin) => plugin.principalId === candidate.principalId)
    return !!current?.enabled
        && current.name === candidate.name
        && current.version === candidate.version
        && current.script === candidate.script
}

export interface PluginRuntimeLoadAdapter<T> {
    loadV2(plugins: T[]): void | Promise<void>
    loadV3(plugins: T[]): void | Promise<void>
}

export async function reloadPluginRuntime<T>(
    pluginV2: T[], pluginV3: T[], runtime: PluginRuntimeLoadAdapter<T>,
) {
    await runtime.loadV3([])
    await runtime.loadV2(pluginV2)
    await runtime.loadV3(pluginV3)
}

export async function suspendPluginRuntime<T>(runtime: PluginRuntimeLoadAdapter<T>) {
    await runtime.loadV3([])
    await runtime.loadV2([])
}

export type PluginRuntimeReplacementState = 'prepared' | 'committed' | 'rolled-back' | 'failed-closed'

export async function runCoordinatedPluginRuntimeMutation<T>(
    transaction: PluginRuntimeReplacementTransaction,
    mutate: (markLiveMutationStarted: () => void) => T | Promise<T>,
    reload: () => void | Promise<void>,
    failClosed: () => void | Promise<void>,
) {
    let liveMutationStarted = false
    try {
        const result = await mutate(() => { liveMutationStarted = true })
        await reload()
        transaction.commit()
        return result
    } catch (error) {
        try {
            if (liveMutationStarted) await transaction.failClosed(failClosed)
            else await transaction.rollback()
        } catch (recoveryError) {
            if (transaction.state === 'prepared') {
                try { await transaction.failClosed(failClosed) } catch { /* preserve both original failures */ }
            }
            throw new AggregateError([error, recoveryError], 'Plugin runtime mutation and recovery failed')
        }
        throw error
    }
}

export async function runAuthorizedPluginRuntimeMutation<T>(options: {
    prepare: () => PluginRuntimeReplacementTransaction | Promise<PluginRuntimeReplacementTransaction>
    authorizeAfterSuspend?: () => boolean
    mutate: (markLiveMutationStarted: () => void) => T | Promise<T>
    reload: () => void | Promise<void>
    failClosed: () => void | Promise<void>
}) {
    const transaction = await options.prepare()
    return runCoordinatedPluginRuntimeMutation(
        transaction,
        async (markLive) => {
            if (options.authorizeAfterSuspend && !options.authorizeAfterSuspend()) {
                throw new Error('Plugin installed record is no longer current')
            }
            return options.mutate(markLive)
        },
        options.reload,
        options.failClosed,
    )
}

export async function runCoordinatedPersistedRuntimeMutation<T, U>(
    transaction: PluginRuntimeReplacementTransaction,
    persist: () => T | Promise<T>,
    mutatePersistedState: (persisted: T) => U | Promise<U>,
    reload: () => void | Promise<void>,
    failClosed: () => void | Promise<void>,
) {
    try {
        // A remote persistence request can commit and still reject locally if
        // its response is lost. Once issued, recovery must never resume the
        // old runtime; treat every request failure as an ambiguous commit.
        const persisted = await persist()
        const result = await mutatePersistedState(persisted)
        await reload()
        transaction.commit()
        return { persisted, result }
    } catch (error) {
        if (transaction.state !== 'prepared') throw error
        try {
            await transaction.failClosed(failClosed)
        } catch (recoveryError) {
            throw new AggregateError([error, recoveryError], 'Persisted database mutation and recovery failed')
        }
        throw error
    }
}

export class PluginRuntimeReplacementTransaction {
    state: PluginRuntimeReplacementState = 'prepared'
    private released = false
    private constructor(private readonly runtime: PluginRuntimeReplacementAdapter) {}

    private release() {
        if (this.released) return
        this.released = true
        this.runtime.release?.()
    }

    static async prepare(runtime: PluginRuntimeReplacementAdapter, authorizeBeforeSuspend: () => boolean = () => true) {
        let authorized = false
        try { authorized = authorizeBeforeSuspend() } catch (error) {
            try { runtime.release?.() } catch { /* preserve the authorization error */ }
            throw error
        }
        if (!authorized) {
            try { runtime.release?.() } catch { /* preserve the authorization failure */ }
            throw new Error('Plugin installed record is no longer current')
        }
        try {
            await runtime.suspend()
            return new PluginRuntimeReplacementTransaction(runtime)
        } catch (suspendError) {
            try {
                await runtime.resume()
            } catch (resumeError) {
                try { await runtime.failClosed?.() } catch { /* preserve the suspension and recovery failures */ }
                runtime.release?.()
                throw new AggregateError([suspendError, resumeError], 'Plugin runtime suspension and recovery failed')
            }
            runtime.release?.()
            throw suspendError
        }
    }

    async runRequest<T>(request: () => T | Promise<T>): Promise<T> {
        if (this.state !== 'prepared') throw new Error(`Plugin runtime replacement is ${this.state}`)
        try {
            return await request()
        } catch (error) {
            try {
                await this.rollback()
            } catch (recoveryError) {
                throw new AggregateError([error, recoveryError], 'Database restore failed and plugin runtime recovery failed')
            }
            throw error
        }
    }

    commit() {
        if (this.state !== 'prepared') throw new Error(`Plugin runtime replacement is ${this.state}`)
        this.state = 'committed'
        this.release()
    }

    async rollback() {
        if (this.state !== 'prepared') return
        await this.runtime.resume()
        this.state = 'rolled-back'
        this.release()
    }

    async failClosed(reload: () => void | Promise<void>) {
        if (this.state !== 'prepared') return
        this.state = 'failed-closed'
        try { await reload() } finally { this.release() }
    }
}
