import { describe, expect, it } from 'vitest'
import { ContextAssetAuthorityRegistry } from './contextAssetAuthorityRegistry'

describe('ContextAssetAuthorityRegistry', () => {
    it('rejects capacity pressure without evicting already-issued current handles', () => {
        const registry = new ContextAssetAuthorityRegistry({ maxPerPrincipal: 2 })
        const owner = { principalId: 'pressure-principal', instanceId: 'pressure-instance' }
        const current = (suffix: string) => ({
            ...owner,
            assetId: `ctxasset_${suffix.repeat(64)}`,
            authorityKind: 'current-context-card' as const,
            identity: `identity-${suffix}`,
            origin: { kind: 'character' as const, characterId: 'card-a' },
        })
        const first = current('1')
        const second = current('2')
        registry.register(first)
        registry.register(second)

        expect(() => registry.register({
            ...owner,
            assetId: `ctxasset_${'3'.repeat(64)}`,
            authorityKind: 'studio-card-capture',
            parentRevision: 'access-a',
            revision: `sha256:${'4'.repeat(64)}`,
            name: 'new.png',
            mediaType: 'image/png',
            validate: async () => undefined,
            read: async () => new Uint8Array([3]),
        })).toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }))
        expect(registry.lookup(first.assetId, owner)).toBe(first)
        expect(registry.lookup(second.assetId, owner)).toBe(second)
        expect(registry.size(owner.principalId, owner.instanceId)).toBe(2)
    })

    it('validates duplicate and conflicting batches before publishing any new authority', () => {
        const registry = new ContextAssetAuthorityRegistry({ maxPerPrincipal: 2 })
        const owner = { principalId: 'batch-principal', instanceId: 'batch-instance' }
        const current = {
            ...owner,
            assetId: `ctxasset_${'a'.repeat(64)}`,
            authorityKind: 'current-context-card' as const,
            identity: 'identity-a',
            origin: { kind: 'character' as const, characterId: 'card-a' },
        }
        registry.register(current)
        registry.registerBatch([current, current, {
            ...current,
            assetId: `ctxasset_${'b'.repeat(64)}`,
            identity: 'identity-b',
        }])
        expect(registry.size(owner.principalId)).toBe(2)

        expect(() => registry.registerBatch([current, {
            ...current,
            identity: 'conflicting-identity',
        }])).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
        expect(registry.lookup(current.assetId, owner)).toBe(current)
        expect(registry.size(owner.principalId)).toBe(2)
    })

    it('does one owner-bound lookup and never falls through between authority kinds', async () => {
        const subjectPath = './contextAssetAuthorityRegistry'
        const subject = await import(/* @vite-ignore */ subjectPath).catch(() => undefined)
        const registry = subject ? new subject.ContextAssetAuthorityRegistry() : undefined
        const common = { principalId: 'principal-a', instanceId: 'instance-a' }
        registry?.register({
            ...common,
            assetId: `ctxasset_${'a'.repeat(64)}`,
            authorityKind: 'studio-card-capture',
            revision: `sha256:${'b'.repeat(64)}`,
            name: 'selected.png',
            mediaType: 'image/png',
            validate: async () => undefined,
            read: async () => new Uint8Array([1]),
        })
        expect(registry?.lookup(`ctxasset_${'a'.repeat(64)}`, common)).toMatchObject({
            authorityKind: 'studio-card-capture', name: 'selected.png',
        })
        expect(() => registry?.lookup(`ctxasset_${'a'.repeat(64)}`, {
            principalId: 'principal-b', instanceId: 'instance-a',
        })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
        expect(registry?.lookupCount).toBe(2)
    })

    it('revokes exact descendants and clears an instance without touching another instance', async () => {
        const subjectPath = './contextAssetAuthorityRegistry'
        const subject = await import(/* @vite-ignore */ subjectPath).catch(() => undefined)
        const registry = subject ? new subject.ContextAssetAuthorityRegistry() : undefined
        const make = (assetId: string, instanceId: string, parentRevision: string) => ({
            principalId: 'principal-a', instanceId, assetId,
            authorityKind: 'studio-catalogue-portrait' as const,
            revision: `sha256:${'c'.repeat(64)}`,
            name: 'portrait.png', mediaType: 'image/png', parentRevision,
            validate: async () => undefined,
            read: async () => new Uint8Array([1]),
        })
        registry?.register(make(`ctxasset_${'1'.repeat(64)}`, 'instance-a', 'page-a'))
        registry?.register(make(`ctxasset_${'2'.repeat(64)}`, 'instance-a', 'page-b'))
        registry?.register(make(`ctxasset_${'3'.repeat(64)}`, 'instance-b', 'page-a'))
        registry?.revokeParent('principal-a', 'instance-a', 'page-a')
        expect(registry?.size('principal-a', 'instance-a')).toBe(1)
        registry?.clearInstance('principal-a', 'instance-a')
        expect(registry?.size('principal-a', 'instance-a')).toBe(0)
        expect(registry?.size('principal-a', 'instance-b')).toBe(1)
    })
})
