import { PluginApiError } from './errors'
import { canonicalArgumentsDigest } from './idempotency'

interface CursorRecord<T = unknown> {
    principalId: string
    service: string
    instanceId: string
    queryDigest: string
    value: T
    expiresAt: number
    pending?: object
}

export interface CursorPreparation {
    readonly principalId: string
    readonly service: string
    readonly instanceId: string
    readonly queryDigest: string
    readonly lifecycle: readonly (readonly [string, number])[]
}

export interface CursorCommitPreparation<T> {
    readonly preparation: CursorPreparation
    readonly cursor: string
    readonly value: T
    readonly expiresAt: number
    readonly replacement?: { readonly cursor: string; readonly record: object }
}

export interface CursorTransaction {
    readonly cursor?: string
    commit(): void
    /** Returns whether an exact replaced cursor was restored, or true when there was none. */
    rollback(): boolean
}

export class CursorRegistry {
    private records = new Map<string, CursorRecord>()
    private ttlMs: number
    private maxPerPrincipal: number
    private now: () => number
    private digest: (query: unknown) => Promise<string>
    private lifecycleEpochs = new Map<string, number>()

    constructor(options: {
        ttlMs?: number
        maxPerPrincipal?: number
        now?: () => number
        digest?: (query: unknown) => Promise<string>
    } = {}) {
        this.ttlMs = options.ttlMs ?? 300_000
        this.maxPerPrincipal = options.maxPerPrincipal ?? 64
        this.now = options.now ?? Date.now
        this.digest = options.digest ?? canonicalArgumentsDigest
    }

    async create<T>(principalId: string, service: string, instanceId: string, query: unknown, value: T) {
        const preparation = await this.prepareCreate(principalId, service, instanceId, query)
        return this.commitPrepared(preparation, value)
    }

    async prepareCreate(
        principalId: string,
        service: string,
        instanceId: string,
        query: unknown,
    ): Promise<CursorPreparation> {
        const lifecycle = this.captureLifecycle(principalId, service, instanceId)
        const queryDigest = await this.digest(query)
        if (!this.isLifecycleCurrent(lifecycle)) {
            throw new PluginApiError('ABORTED', 'Plugin cursor owner is no longer active')
        }
        return { principalId, service, instanceId, queryDigest, lifecycle }
    }

    prepareCommit<T>(
        preparation: CursorPreparation,
        value: T,
        replacingCursor?: string,
    ): CursorCommitPreparation<T> {
        if (!this.isLifecycleCurrent(preparation.lifecycle)) {
            throw new PluginApiError('ABORTED', 'Plugin cursor owner is no longer active')
        }
        this.removeExpired()
        const replacement = replacingCursor ? this.records.get(replacingCursor) : undefined
        if (replacingCursor && (!replacement
            || replacement.principalId !== preparation.principalId
            || replacement.service !== preparation.service
            || replacement.instanceId !== preparation.instanceId
            || replacement.queryDigest !== preparation.queryDigest)) {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid or expired cursor')
        }
        const active = [...this.records.values()].filter((record) =>
            record.principalId === preparation.principalId).length
        if (active - (replacement ? 1 : 0) >= this.maxPerPrincipal) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Too many active cursors', { retryable: true })
        }
        let cursor: string
        do cursor = `${crypto.randomUUID()}.${crypto.randomUUID()}`
        while (this.records.has(cursor))
        if (!this.isLifecycleCurrent(preparation.lifecycle)) {
            throw new PluginApiError('ABORTED', 'Plugin cursor owner is no longer active')
        }
        const expiresAt = this.now() + this.ttlMs
        if (!this.isLifecycleCurrent(preparation.lifecycle)) {
            throw new PluginApiError('ABORTED', 'Plugin cursor owner is no longer active')
        }
        return Object.freeze({
            preparation,
            cursor,
            value,
            expiresAt,
            ...(replacement && replacingCursor ? {
                replacement: { cursor: replacingCursor, record: replacement },
            } : {}),
        })
    }

    commitPrepared<T>(
        preparation: CursorPreparation,
        value: T,
        commit = this.prepareCommit(preparation, value),
    ) {
        const transaction = this.beginPrepared(preparation, value, commit)
        transaction.commit()
        return transaction.cursor!
    }

    beginPrepared<T>(
        preparation: CursorPreparation,
        value: T,
        commit = this.prepareCommit(preparation, value),
    ): CursorTransaction {
        if (commit.preparation !== preparation || commit.value !== value) {
            throw new PluginApiError('INVALID_ARGUMENT', 'Cursor commit does not match its preparation')
        }
        if (!this.isLifecycleCurrent(preparation.lifecycle)) {
            throw new PluginApiError('ABORTED', 'Plugin cursor owner is no longer active')
        }
        const replacement = commit.replacement
        if (replacement && this.records.get(replacement.cursor) !== replacement.record) {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid or expired cursor')
        }
        const active = [...this.records.values()].filter((record) =>
            record.principalId === preparation.principalId).length
        if (this.records.has(commit.cursor)
            || active - (replacement ? 1 : 0) >= this.maxPerPrincipal) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Too many active cursors', { retryable: true })
        }
        const pending = {}
        const record: CursorRecord<T> = {
            principalId: preparation.principalId,
            service: preparation.service,
            instanceId: preparation.instanceId,
            queryDigest: preparation.queryDigest,
            value,
            expiresAt: commit.expiresAt,
            pending,
        }
        this.records.set(commit.cursor, record)
        if (replacement) this.records.delete(replacement.cursor)
        let settled = false
        return Object.freeze({
            cursor: commit.cursor,
            commit: () => {
                if (settled) return
                settled = true
                if (this.records.get(commit.cursor) === record && record.pending === pending) {
                    record.expiresAt = this.refreshExpiry(record.expiresAt)
                    delete record.pending
                }
            },
            rollback: () => {
                if (settled) return !replacement
                settled = true
                if (this.records.get(commit.cursor) === record) this.records.delete(commit.cursor)
                if (!replacement) return true
                if (!this.isLifecycleCurrent(preparation.lifecycle)
                    || this.records.has(replacement.cursor)) return false
                const replacementRecord = replacement.record as CursorRecord
                replacementRecord.expiresAt = this.refreshExpiry(replacementRecord.expiresAt)
                this.records.set(replacement.cursor, replacementRecord)
                return true
            },
        })
    }

    beginRetire(cursor: string, value: unknown): CursorTransaction {
        this.removeExpired()
        const record = this.records.get(cursor)
        if (!record || record.pending || record.value !== value) {
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid or expired cursor')
        }
        const lifecycle = this.captureLifecycle(record.principalId, record.service, record.instanceId)
        this.records.delete(cursor)
        let settled = false
        return Object.freeze({
            commit: () => { settled = true },
            rollback: () => {
                if (settled) return false
                settled = true
                if (!this.isLifecycleCurrent(lifecycle) || this.records.has(cursor)) return false
                record.expiresAt = this.refreshExpiry(record.expiresAt)
                this.records.set(cursor, record)
                return true
            },
        })
    }

    async read<T>(cursor: string, principalId: string, service: string, instanceId: string, query: unknown): Promise<T> {
        const record = this.records.get(cursor)
        if (!record || record.pending || record.expiresAt < this.now() || record.principalId !== principalId
            || record.service !== service || record.instanceId !== instanceId) {
            if (record && !record.pending && record.expiresAt < this.now()
                && this.records.get(cursor) === record) this.records.delete(cursor)
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid or expired cursor')
        }
        const queryDigest = await this.digest(query)
        if (this.records.get(cursor) !== record || record.expiresAt < this.now() || record.queryDigest !== queryDigest) {
            if (!record.pending && record.expiresAt < this.now()
                && this.records.get(cursor) === record) this.records.delete(cursor)
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid or expired cursor')
        }
        return record.value as T
    }

    clear(cursor: string) { this.records.delete(cursor) }
    clearPrincipal(principalId: string) {
        this.bumpLifecycle(`principal:${principalId}`)
        for (const [cursor, record] of this.records) if (record.principalId === principalId) this.records.delete(cursor)
    }
    clearInstance(principalId: string, instanceId: string) {
        this.bumpLifecycle(`instance:${principalId}:${instanceId}`)
        for (const [cursor, record] of this.records) {
            if (record.principalId === principalId && record.instanceId === instanceId) this.records.delete(cursor)
        }
    }
    clearService(principalId: string, service: string) {
        this.bumpLifecycle(`service:${principalId}:${service}`)
        for (const [cursor, record] of this.records) {
            if (record.principalId === principalId && record.service === service) this.records.delete(cursor)
        }
    }
    activeCount(principalId: string) {
        this.removeExpired()
        return [...this.records.values()].filter((record) => record.principalId === principalId).length
    }
    private removeExpired() {
        for (const [cursor, record] of this.records) {
            if (!record.pending && record.expiresAt < this.now()) this.records.delete(cursor)
        }
    }
    private refreshExpiry(expiresAt: number) {
        try {
            return Math.max(expiresAt, this.now() + this.ttlMs)
        } catch {
            return expiresAt
        }
    }
    private bumpLifecycle(key: string) {
        this.lifecycleEpochs.set(key, (this.lifecycleEpochs.get(key) ?? 0) + 1)
    }
    private captureLifecycle(principalId: string, service: string, instanceId: string) {
        const keys = [
            `principal:${principalId}`,
            `service:${principalId}:${service}`,
            `instance:${principalId}:${instanceId}`,
        ]
        return keys.map((key) => [key, this.lifecycleEpochs.get(key) ?? 0] as const)
    }
    private isLifecycleCurrent(lifecycle: readonly (readonly [string, number])[]) {
        return lifecycle.every(([key, epoch]) => (this.lifecycleEpochs.get(key) ?? 0) === epoch)
    }
}

/** Shared extension-wide registry so the advertised 64-cursor ceiling is per principal, not per service. */
export const illustrationCursorRegistry = new CursorRegistry()
