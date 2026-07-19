import localforage from 'localforage'
import type { PluginDataLifecycleRegistry } from '../../pluginDataLifecycle'
import { pluginDataLifecycle } from '../../pluginDataLifecycle'
import { pluginSecretConsentCopy } from '../../pluginSecretPrompt.svelte'
import type { SecurityConfirmationQueue } from '../../securityConfirmationQueue'
import { securityConfirmationQueue } from '../../securityConfirmationQueue'
import { CAPABILITY_CONTRACT } from './capabilityContract'
import { PluginApiError } from './errors'
import type { PluginExecutionContext } from './permissions'
import {
    assertPluginSecretId,
    assertPluginSecretValue,
    canonicalizePluginSecretPolicy,
    secretPolicyDigestInput,
    type CanonicalPluginSecretPolicy,
    type PluginSecretPolicy,
} from './secretPolicy'

export interface StoredPluginSecret {
    value: string
    policy: CanonicalPluginSecretPolicy
}

export interface QuarantinedPluginSecret {
    principalId: string
    id: string
    record: StoredPluginSecret
}

export interface PluginSecretStorageStatus {
    supported: true
    available: boolean
    reason?: 'disabled'
}

export interface PluginSecretBackend {
    status(): Promise<PluginSecretStorageStatus>
    read(principalId: string, id: string): Promise<StoredPluginSecret | null>
    write(principalId: string, id: string, record: StoredPluginSecret): Promise<void>
    delete(principalId: string, id: string): Promise<boolean>
    listIds(principalId: string): Promise<string[]>
    purgePrincipal(principalId: string): Promise<void>
    quarantinePrincipal(principalId: string): Promise<void>
    withPrincipalLock?<T>(principalId: string, operation: () => Promise<T>): Promise<T>
    /** Used only after a durable retirement fence blocks all new mutations. */
    withRetiredPrincipalCleanup?<T>(principalId: string, operation: () => Promise<T>): Promise<T>
    markPrincipalRetired?(principalId: string): Promise<void>
    isPrincipalRetired?(principalId: string): Promise<boolean>
}

const recordKey = (principalId: string, id: string) => JSON.stringify([principalId, id])
const cloneRecord = (record: StoredPluginSecret): StoredPluginSecret => ({
    value: record.value,
    policy: {
        allowedOrigins: [...record.policy.allowedOrigins],
        uses: record.policy.uses.map((use) => ({ ...use })),
    },
})

export class MemoryPluginSecretBackend implements PluginSecretBackend {
    private records = new Map<string, StoredPluginSecret>()
    private quarantine: QuarantinedPluginSecret[] = []
    failNextWrite = false
    constructor(private options: { available?: boolean } = {}) {}
    async status(): Promise<PluginSecretStorageStatus> {
        return this.options.available === false
            ? { supported: true, available: false, reason: 'disabled' }
            : { supported: true, available: true }
    }
    async read(principalId: string, id: string) {
        const record = this.records.get(recordKey(principalId, id))
        return record ? cloneRecord(record) : null
    }
    async write(principalId: string, id: string, record: StoredPluginSecret) {
        if (this.failNextWrite) {
            this.failNextWrite = false
            throw new Error('simulated device write failure')
        }
        this.records.set(recordKey(principalId, id), cloneRecord(record))
    }
    async delete(principalId: string, id: string) { return this.records.delete(recordKey(principalId, id)) }
    async listIds(principalId: string) {
        const ids: string[] = []
        for (const key of this.records.keys()) {
            const [owner, id] = JSON.parse(key) as [string, string]
            if (owner === principalId) ids.push(id)
        }
        return ids.sort()
    }
    async purgePrincipal(principalId: string) {
        for (const id of await this.listIds(principalId)) this.records.delete(recordKey(principalId, id))
    }
    async quarantinePrincipal(principalId: string) {
        for (const id of await this.listIds(principalId)) {
            const key = recordKey(principalId, id)
            const record = this.records.get(key)
            if (record) this.quarantine.push({ principalId, id, record: cloneRecord(record) })
            this.records.delete(key)
        }
    }
    quarantinedCount() { return this.quarantine.length }
    quarantinedEntries() {
        return this.quarantine.map(({ principalId, id, record }) => ({ principalId, id, record: cloneRecord(record) }))
    }
}

type EncryptedRecord = { version: 1; iv: Uint8Array; ciphertext: Uint8Array }
type QuarantinedEncryptedRecord = {
    version: 1
    principalId: string
    id: string
    encrypted: EncryptedRecord
    quarantinedAt: number
}

export class ProtectedWebPluginSecretBackend implements PluginSecretBackend {
    private records = localforage.createInstance({ name: 'plugin_secrets_v3', storeName: 'encrypted_records' })
    private keys = localforage.createInstance({ name: 'plugin_secrets_v3', storeName: 'host_keys' })
    private quarantine = localforage.createInstance({ name: 'plugin_secrets_v3', storeName: 'quarantine' })
    private retirements = localforage.createInstance({ name: 'plugin_secrets_v3', storeName: 'retired_principals' })
    private keyPromise?: Promise<CryptoKey>

    async status(): Promise<PluginSecretStorageStatus> {
        try {
            this.lockManager()
            await this.key()
            return { supported: true, available: true }
        } catch {
            return { supported: true, available: false, reason: 'disabled' }
        }
    }

    private lockManager() {
        if (typeof navigator === 'undefined' || !navigator.locks?.request) {
            throw new Error('cross-context protected storage lock unavailable')
        }
        return navigator.locks
    }

    private requestPrincipalLock<T>(lockManager: LockManager, principalId: string, operation: () => Promise<T>) {
        return lockManager.request<Promise<T>>(
            `risu-plugin-secrets-v3:${JSON.stringify([principalId])}`,
            { mode: 'exclusive' },
            operation,
        ).then((result) => result)
    }

    withPrincipalLock<T>(principalId: string, operation: () => Promise<T>) {
        return this.requestPrincipalLock(this.lockManager(), principalId, operation)
    }

    withRetiredPrincipalCleanup<T>(principalId: string, operation: () => Promise<T>) {
        let lockManager: LockManager
        try {
            lockManager = this.lockManager()
        } catch {
            // status() fails closed without Web Locks, so no new protected mutation can start.
            // The durable retirement marker is written before this lifecycle-only fallback.
            return operation()
        }
        return this.requestPrincipalLock(lockManager, principalId, operation)
    }

    async markPrincipalRetired(principalId: string) {
        await this.retirements.setItem(principalId, { version: 1, retiredAt: Date.now() })
    }

    async isPrincipalRetired(principalId: string) {
        return await this.retirements.getItem(principalId) !== null
    }

    private key() {
        return this.keyPromise ??= (async () => {
            if (!globalThis.crypto?.subtle || typeof indexedDB === 'undefined') throw new Error('protected storage unavailable')
            let key = await this.keys.getItem<CryptoKey>('aes-gcm-v1')
            if (!key) {
                key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
                await this.keys.setItem('aes-gcm-v1', key)
                const restored = await this.keys.getItem<CryptoKey>('aes-gcm-v1')
                if (!restored || restored.extractable) throw new Error('non-extractable key persistence unavailable')
                key = restored
            }
            if (key.extractable) throw new Error('extractable key rejected')
            return key
        })()
    }

    private aad(principalId: string, id: string) { return new TextEncoder().encode(recordKey(principalId, id)) }

    async read(principalId: string, id: string): Promise<StoredPluginSecret | null> {
        const encrypted = await this.records.getItem<EncryptedRecord>(recordKey(principalId, id))
        if (!encrypted) return null
        try {
            const plaintext = await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: encrypted.iv.slice().buffer as ArrayBuffer,
                    additionalData: this.aad(principalId, id).buffer as ArrayBuffer,
                },
                await this.key(), encrypted.ciphertext.slice().buffer as ArrayBuffer,
            )
            const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as StoredPluginSecret
            return { value: decoded.value, policy: canonicalizePluginSecretPolicy(decoded.policy) }
        } catch {
            throw new PluginApiError('INTERNAL', 'Protected Secret storage is unreadable')
        }
    }

    async write(principalId: string, id: string, record: StoredPluginSecret) {
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const plaintext = new TextEncoder().encode(JSON.stringify(record))
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: this.aad(principalId, id) }, await this.key(), plaintext,
        ))
        await this.records.setItem(recordKey(principalId, id), { version: 1, iv, ciphertext } satisfies EncryptedRecord)
    }

    async delete(principalId: string, id: string) {
        const key = recordKey(principalId, id)
        if (await this.records.getItem(key) === null) return false
        await this.records.removeItem(key)
        return true
    }

    async listIds(principalId: string) {
        const result: string[] = []
        for (const key of await this.records.keys()) {
            try {
                const [owner, id] = JSON.parse(key) as [string, string]
                if (owner === principalId && typeof id === 'string') result.push(id)
            } catch { /* unrelated or malformed local record */ }
        }
        return result.sort()
    }

    async purgePrincipal(principalId: string) {
        await Promise.all((await this.listIds(principalId)).map((id) => this.records.removeItem(recordKey(principalId, id))))
    }

    async quarantinePrincipal(principalId: string) {
        for (const id of await this.listIds(principalId)) {
            const key = recordKey(principalId, id)
            const encrypted = await this.records.getItem<EncryptedRecord>(key)
            if (encrypted) await this.quarantine.setItem(crypto.randomUUID(), {
                version: 1, principalId, id, encrypted, quarantinedAt: Date.now(),
            } satisfies QuarantinedEncryptedRecord)
            await this.records.removeItem(key)
        }
    }
}

export class PluginSecretRetentionRegistry {
    private retained = new Set<string>()
    retainOnUninstall(principalId: string) { this.retained.add(principalId) }
    consume(principalId: string) { return this.retained.delete(principalId) }
}

export function registerPluginSecretLifecycle(
    backend: PluginSecretBackend,
    lifecycle: PluginDataLifecycleRegistry = pluginDataLifecycle,
    retention = new PluginSecretRetentionRegistry(),
) {
    return lifecycle.register('secrets', 'purge', async ({ principalId }) => {
        markSecretPrincipalRetired(backend, principalId)
        await backend.markPrincipalRetired?.(principalId)
        await withBackendPrincipalLock(backend, principalId, async () => {
            if (retention.consume(principalId)) await backend.quarantinePrincipal(principalId)
            else await backend.purgePrincipal(principalId)
        }, true)
    })
}

export interface PluginSecretServiceDependencies {
    requirePermission: () => Promise<void>
    queue?: SecurityConfirmationQueue
    locale?: 'en' | 'ko'
    isPrincipalRetiring?: (principalId: string) => boolean
}

const backendPrincipalTails = new WeakMap<PluginSecretBackend, Map<string, Promise<void>>>()
const retiredBackendPrincipals = new WeakMap<PluginSecretBackend, Set<string>>()

function markSecretPrincipalRetired(backend: PluginSecretBackend, principalId: string) {
    let principals = retiredBackendPrincipals.get(backend)
    if (!principals) {
        principals = new Set()
        retiredBackendPrincipals.set(backend, principals)
    }
    principals.add(principalId)
}

const isSecretPrincipalRetired = (backend: PluginSecretBackend, principalId: string) =>
    retiredBackendPrincipals.get(backend)?.has(principalId) === true

async function withBackendPrincipalLock<T>(
    backend: PluginSecretBackend,
    principalId: string,
    operation: () => Promise<T>,
    retiredCleanup = false,
): Promise<T> {
    let tails = backendPrincipalTails.get(backend)
    if (!tails) {
        tails = new Map()
        backendPrincipalTails.set(backend, tails)
    }
    const previous = tails.get(principalId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => gate)
    tails.set(principalId, tail)
    await previous.catch(() => undefined)
    try {
        if (retiredCleanup && backend.withRetiredPrincipalCleanup) {
            return await backend.withRetiredPrincipalCleanup(principalId, operation)
        }
        return backend.withPrincipalLock
            ? await backend.withPrincipalLock(principalId, operation)
            : await operation()
    } finally {
        release()
        if (tails.get(principalId) === tail) tails.delete(principalId)
    }
}

export class PluginSecretService {
    private queue: SecurityConfirmationQueue
    private locale: 'en' | 'ko'
    constructor(
        private context: PluginExecutionContext,
        private backend: PluginSecretBackend,
        private dependencies: PluginSecretServiceDependencies,
    ) {
        this.queue = dependencies.queue ?? securityConfirmationQueue
        this.locale = dependencies.locale ?? 'en'
    }

    /** Host-internal principal binding; never returned through the plugin RPC API. */
    get principalId() { return this.context.principalId }

    /** Host-internal lifecycle signal; never returned through the plugin RPC API. */
    get executionSignal() { return this.context.signal }

    private assertActive() {
        if (this.context.signal.aborted) throw new PluginApiError('ABORTED', 'Plugin instance unloaded')
    }

    private assertMutable() {
        this.assertActive()
        const isRetiring = this.dependencies.isPrincipalRetiring
            ?? ((principalId: string) => pluginDataLifecycle.isRetiring(principalId))
        if (isSecretPrincipalRetired(this.backend, this.context.principalId)
            || isRetiring(this.context.principalId)) {
            throw new PluginApiError('ABORTED', 'Plugin principal retired')
        }
    }

    private async assertPersistedMutable() {
        this.assertMutable()
        if (!this.backend.isPrincipalRetired) return
        let retired: boolean
        try {
            retired = await this.backend.isPrincipalRetired(this.context.principalId)
        } catch {
            throw new PluginApiError('INTERNAL', 'Protected Secret retirement fence is unreadable')
        }
        this.assertMutable()
        if (retired) {
            markSecretPrincipalRetired(this.backend, this.context.principalId)
            throw new PluginApiError('ABORTED', 'Plugin principal retired')
        }
    }

    private async requireAvailable() {
        const status = await this.backend.status()
        if (!status.available) throw new PluginApiError('UNSUPPORTED', 'Protected device-local Secret storage is unavailable', {
            details: { reason: status.reason ?? 'disabled' },
        })
    }

    private async authorize() {
        this.assertActive()
        await this.dependencies.requirePermission()
        this.assertActive()
        await this.requireAvailable()
        this.assertActive()
    }

    async setPluginSecret(id: string, value: string, policy: PluginSecretPolicy) {
        assertPluginSecretId(id)
        assertPluginSecretValue(value)
        const canonicalPolicy = canonicalizePluginSecretPolicy(policy)
        this.assertMutable()
        await this.authorize()
        await this.assertPersistedMutable()
        const existing = await this.backend.read(this.context.principalId, id)
        await this.assertPersistedMutable()
        const copy = pluginSecretConsentCopy(this.locale, {
            displayName: this.context.displayName,
            internalName: this.context.internalName ?? this.context.displayName,
            secretId: id,
            replacement: existing !== null,
            policy: canonicalPolicy,
        })
        const approved = await this.queue.request({
            kind: existing ? 'secret-replacement' : 'secret-placement',
            principalId: this.context.principalId,
            instanceId: this.context.instanceId,
            action: id,
            policyDigest: secretPolicyDigestInput(canonicalPolicy),
            copyVersion: 1,
            displayName: this.context.displayName,
            internalName: this.context.internalName ?? this.context.displayName,
            ...copy,
        }, this.context.signal)
        await this.assertPersistedMutable()
        if (!approved) throw new PluginApiError('PERMISSION_DENIED', 'Secret placement denied', { details: { secretId: id } })
        try {
            await withBackendPrincipalLock(this.backend, this.context.principalId, async () => {
                await this.assertPersistedMutable()
                const ids = await this.backend.listIds(this.context.principalId)
                await this.assertPersistedMutable()
                const maximum = Number(CAPABILITY_CONTRACT['secrets.write-only.v1'].limits.maxSecretsPerPrincipal)
                if (!ids.includes(id) && ids.length >= maximum) {
                    throw new PluginApiError('QUOTA_EXCEEDED', 'Secret quota exceeded', { details: { maximum } })
                }
                await this.backend.write(this.context.principalId, id, { value, policy: canonicalPolicy })
                await this.assertPersistedMutable()
            })
        } catch (error) {
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', 'Protected Secret storage write failed')
        }
        this.assertMutable()
    }

    async hasPluginSecret(id: string) {
        assertPluginSecretId(id)
        await this.authorize()
        await this.assertPersistedMutable()
        const record = await this.backend.read(this.context.principalId, id)
        await this.assertPersistedMutable()
        return record !== null
    }

    async deletePluginSecret(id: string) {
        assertPluginSecretId(id)
        this.assertMutable()
        await this.authorize()
        await this.assertPersistedMutable()
        return withBackendPrincipalLock(this.backend, this.context.principalId, async () => {
            await this.assertPersistedMutable()
            const deleted = await this.backend.delete(this.context.principalId, id)
            await this.assertPersistedMutable()
            return deleted
        })
    }

    /** Host-internal: returned records must never cross the plugin RPC boundary. */
    async resolveForRequest(id: string) {
        assertPluginSecretId(id)
        await this.authorize()
        await this.assertPersistedMutable()
        const record = await this.backend.read(this.context.principalId, id)
        await this.assertPersistedMutable()
        if (!record) throw new PluginApiError('NOT_FOUND', `Secret not found: ${id}`, { details: { secretId: id } })
        return record
    }
}

export const protectedPluginSecretBackend = new ProtectedWebPluginSecretBackend()
export const pluginSecretRetention = new PluginSecretRetentionRegistry()
registerPluginSecretLifecycle(protectedPluginSecretBackend, pluginDataLifecycle, pluginSecretRetention)
