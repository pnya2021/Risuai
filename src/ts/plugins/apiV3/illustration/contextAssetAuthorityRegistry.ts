import { PluginApiError } from './errors'

export type ContextAssetAuthorityKind =
    | 'current-context-card'
    | 'current-context-installed-module'
    | 'studio-catalogue-portrait'
    | 'studio-card-capture'

export interface ContextAssetAuthorityOwner {
    principalId: string
    instanceId: string
}

interface ContextAssetAuthorityBase extends ContextAssetAuthorityOwner {
    assetId: string
    authorityKind: ContextAssetAuthorityKind
    parentRevision?: string
}

export interface CurrentContextAssetAuthority extends ContextAssetAuthorityBase {
    authorityKind: 'current-context-card' | 'current-context-installed-module'
    identity: string
    origin: { kind: 'character'; characterId: string } | { kind: 'module'; moduleId: string }
}

export interface StudioContextAssetAuthority extends ContextAssetAuthorityBase {
    authorityKind: 'studio-catalogue-portrait' | 'studio-card-capture'
    revision: string
    name: string
    mediaType: string
    byteLength?: number
    validate(signal?: AbortSignal): Promise<void>
    read(signal?: AbortSignal): Promise<Uint8Array | null>
}

export type ContextAssetAuthority = CurrentContextAssetAuthority | StudioContextAssetAuthority

const keyOf = (principalId: string, instanceId: string, assetId: string) =>
    JSON.stringify([principalId, instanceId, assetId])

export class ContextAssetAuthorityRegistry {
    private readonly records = new Map<string, ContextAssetAuthority>()
    private readonly maxPerPrincipal: number
    lookupCount = 0

    constructor(options: { maxPerPrincipal?: number } = {}) {
        this.maxPerPrincipal = options.maxPerPrincipal ?? 8_192
    }

    register(record: ContextAssetAuthority) {
        const key = keyOf(record.principalId, record.instanceId, record.assetId)
        const existing = this.records.get(key)
        if (existing && (existing.authorityKind !== record.authorityKind
            || existing.parentRevision !== record.parentRevision
            || ('revision' in existing && 'revision' in record && existing.revision !== record.revision))) {
            throw new PluginApiError('CONFLICT', 'Context asset authority collision')
        }
        if (!existing && this.size(record.principalId) >= this.maxPerPrincipal) {
            const evictable = [...this.records].find(([, candidate]) =>
                candidate.principalId === record.principalId
                && (candidate.authorityKind === 'current-context-card'
                    || candidate.authorityKind === 'current-context-installed-module'))
            if (!evictable) {
                throw new PluginApiError('RESOURCE_LIMIT', 'Too many context asset authorities', { retryable: true })
            }
            this.records.delete(evictable[0])
        }
        this.records.set(key, record)
    }

    lookup(assetId: string, owner: ContextAssetAuthorityOwner): ContextAssetAuthority {
        this.lookupCount += 1
        const record = this.records.get(keyOf(owner.principalId, owner.instanceId, assetId))
        if (!record) throw new PluginApiError('NOT_FOUND', 'Context asset was not found')
        const key = keyOf(owner.principalId, owner.instanceId, assetId)
        this.records.delete(key)
        this.records.set(key, record)
        return record
    }

    revoke(assetId: string, owner: ContextAssetAuthorityOwner) {
        this.records.delete(keyOf(owner.principalId, owner.instanceId, assetId))
    }

    revokeParent(principalId: string, instanceId: string, parentRevision: string) {
        for (const [key, record] of this.records) {
            if (record.principalId === principalId && record.instanceId === instanceId
                && record.parentRevision === parentRevision) this.records.delete(key)
        }
    }

    clearInstance(principalId: string, instanceId: string) {
        for (const [key, record] of this.records) {
            if (record.principalId === principalId && record.instanceId === instanceId) this.records.delete(key)
        }
    }

    clearPrincipal(principalId: string) {
        for (const [key, record] of this.records) {
            if (record.principalId === principalId) this.records.delete(key)
        }
    }

    size(principalId?: string, instanceId?: string) {
        return [...this.records.values()].filter((record) =>
            (principalId === undefined || record.principalId === principalId)
            && (instanceId === undefined || record.instanceId === instanceId)).length
    }
}

export const contextAssetAuthorityRegistry = new ContextAssetAuthorityRegistry()
