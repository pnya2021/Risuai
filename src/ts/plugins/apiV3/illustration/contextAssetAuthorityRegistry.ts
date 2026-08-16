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
    touch?(): void
}

export type ContextAssetAuthority = CurrentContextAssetAuthority | StudioContextAssetAuthority

const keyOf = (principalId: string, instanceId: string, assetId: string) =>
    JSON.stringify([principalId, instanceId, assetId])

const sameOrigin = (
    left: CurrentContextAssetAuthority['origin'],
    right: CurrentContextAssetAuthority['origin'],
) => left.kind === right.kind && (left.kind === 'character'
    ? left.characterId === (right as { kind: 'character'; characterId: string }).characterId
    : left.moduleId === (right as { kind: 'module'; moduleId: string }).moduleId)

const compatibleAuthority = (left: ContextAssetAuthority, right: ContextAssetAuthority) => {
    if (left.authorityKind !== right.authorityKind || left.parentRevision !== right.parentRevision) return false
    if (left.authorityKind === 'current-context-card'
        || left.authorityKind === 'current-context-installed-module') {
        const currentRight = right as CurrentContextAssetAuthority
        return left.identity === currentRight.identity && sameOrigin(left.origin, currentRight.origin)
    }
    const studioLeft = left as StudioContextAssetAuthority
    const studioRight = right as StudioContextAssetAuthority
    return studioLeft.revision === studioRight.revision
        && studioLeft.name === studioRight.name
        && studioLeft.mediaType === studioRight.mediaType
        && studioLeft.byteLength === studioRight.byteLength
}

export interface ContextAssetAuthorityBatchRegistration {
    rollback(): void
}

export class ContextAssetAuthorityRegistry {
    private readonly records = new Map<string, ContextAssetAuthority>()
    private readonly maxPerPrincipal: number
    lookupCount = 0

    constructor(options: { maxPerPrincipal?: number } = {}) {
        this.maxPerPrincipal = options.maxPerPrincipal ?? 8_192
    }

    register(record: ContextAssetAuthority) {
        this.registerBatch([record])
    }

    registerBatch(records: readonly ContextAssetAuthority[]): ContextAssetAuthorityBatchRegistration {
        const staged = new Map<string, ContextAssetAuthority>()
        for (const record of records) {
            const key = keyOf(record.principalId, record.instanceId, record.assetId)
            const duplicate = staged.get(key)
            if (duplicate && !compatibleAuthority(duplicate, record)) {
                throw new PluginApiError('CONFLICT', 'Context asset authority collision')
            }
            if (!duplicate) staged.set(key, record)
        }

        const additions = new Map<string, number>()
        for (const [key, record] of staged) {
            const existing = this.records.get(key)
            if (existing && !compatibleAuthority(existing, record)) {
                throw new PluginApiError('CONFLICT', 'Context asset authority collision')
            }
            if (!existing) additions.set(
                record.principalId,
                (additions.get(record.principalId) ?? 0) + 1,
            )
        }
        for (const [principalId, added] of additions) {
            if (this.size(principalId) + added > this.maxPerPrincipal) {
                throw new PluginApiError('RESOURCE_LIMIT', 'Too many context asset authorities', {
                    retryable: true,
                })
            }
        }

        const inserted: Array<[string, ContextAssetAuthority]> = []
        for (const [key, record] of staged) {
            if (this.records.has(key)) continue
            this.records.set(key, record)
            inserted.push([key, record])
        }
        let active = true
        return {
            rollback: () => {
                if (!active) return
                active = false
                for (const [key, record] of inserted) {
                    if (this.records.get(key) === record) this.records.delete(key)
                }
            },
        }
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
