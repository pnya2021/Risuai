import { describe, expect, it } from 'vitest'

describe('ContextAssetAuthorityRegistry', () => {
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
