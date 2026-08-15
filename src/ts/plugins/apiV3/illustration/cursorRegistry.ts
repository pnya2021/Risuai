import { PluginApiError } from './errors'
import { canonicalArgumentsDigest } from './idempotency'

interface CursorRecord<T = unknown> {
    principalId: string
    service: string
    instanceId: string
    queryDigest: string
    value: T
    expiresAt: number
}

export interface CursorPreparation {
    readonly principalId: string
    readonly service: string
    readonly instanceId: string
    readonly queryDigest: string
    readonly lifecycle: readonly (readonly [string, number])[]
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

    commitPrepared<T>(preparation: CursorPreparation, value: T) {
        if (!this.isLifecycleCurrent(preparation.lifecycle)) {
            throw new PluginApiError('ABORTED', 'Plugin cursor owner is no longer active')
        }
        this.removeExpired()
        if (this.activeCount(preparation.principalId) >= this.maxPerPrincipal) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Too many active cursors', { retryable: true })
        }
        let cursor: string
        do cursor = `${crypto.randomUUID()}.${crypto.randomUUID()}`
        while (this.records.has(cursor))
        if (!this.isLifecycleCurrent(preparation.lifecycle)) {
            throw new PluginApiError('ABORTED', 'Plugin cursor owner is no longer active')
        }
        this.records.set(cursor, {
            principalId: preparation.principalId,
            service: preparation.service,
            instanceId: preparation.instanceId,
            queryDigest: preparation.queryDigest,
            value,
            expiresAt: this.now() + this.ttlMs,
        })
        return cursor
    }

    async read<T>(cursor: string, principalId: string, service: string, instanceId: string, query: unknown): Promise<T> {
        const record = this.records.get(cursor)
        if (!record || record.expiresAt < this.now() || record.principalId !== principalId
            || record.service !== service || record.instanceId !== instanceId) {
            if (record?.expiresAt !== undefined && record.expiresAt < this.now()) this.records.delete(cursor)
            throw new PluginApiError('INVALID_ARGUMENT', 'Invalid or expired cursor')
        }
        const queryDigest = await this.digest(query)
        if (this.records.get(cursor) !== record || record.expiresAt < this.now() || record.queryDigest !== queryDigest) {
            if (record?.expiresAt !== undefined && record.expiresAt < this.now()) this.records.delete(cursor)
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
        for (const [cursor, record] of this.records) if (record.expiresAt < this.now()) this.records.delete(cursor)
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
