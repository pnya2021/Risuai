import { describe, expect, it, vi } from 'vitest'
import type { CharacterCardSnapshot } from './contextResources'

const sha = (value: string) => `sha256:${value.padEnd(64, '0').slice(0, 64)}`

const card = (id: string, name = id, type: 'character' | 'group' = 'character'): CharacterCardSnapshot => ({
    id,
    revision: sha(`card-${id}`),
    type,
    name,
    textSections: [{ key: 'description', label: 'Description', content: `${name} description` }],
    lorebook: [],
    ...(type === 'group' ? { groupMemberIds: ['member-b', 'member-a', 'member-a'] } : {}),
})

const studioSubjectPath = './studioCardResources'
const registrySubjectPath = './contextAssetAuthorityRegistry'
const loadSubject = async () => import(/* @vite-ignore */ studioSubjectPath).catch(() => undefined)
const loadRegistry = async () => import(/* @vite-ignore */ registrySubjectPath).catch(() => undefined)

describe('Studio card resource core', () => {
    it('publishes stable filtered pages and separately retains the Host-active summary', async () => {
        const subject = await loadSubject()
        const captureCatalogue = vi.fn(async () => ({
            nativeRevision: 'native-1',
            hostActiveCardId: 'card-60',
            records: Array.from({ length: 60 }, (_, index) => ({
                cardId: `card-${String(index + 1).padStart(2, '0')}`,
                catalogueItemRevision: `item-${index + 1}`,
                kind: index === 2 ? 'group' as const : 'character' as const,
                name: index === 0 ? 'Zeta' : `Alpha ${String(index + 1).padStart(2, '0')}`,
                groupMemberIds: index === 2 ? ['member-a', 'member-b'] : [],
                ...(index === 59 ? {
                    portrait: {
                        revision: sha('portrait'), name: 'portrait.png', mediaType: 'image/png',
                        locator: {
                            ownerCardId: 'card-60', ownerRevision: 'owner-1',
                            storageRevision: 'storage-1', nativeSlot: 0,
                        },
                    },
                } : {}),
            })),
            authority: {},
        }))
        const adapter = {
            captureCatalogue,
            revalidateCatalogue: () => true,
            captureSource: vi.fn(),
            revalidateSource: () => true,
            readAsset: vi.fn(),
            captureGeneration: () => 'generation-1',
            isGenerationCurrent: () => true,
        }
        const registryModule = await loadRegistry()
        const context = {
            principalId: 'principal-a', instanceId: 'instance-a', displayName: 'Studio',
            signal: new AbortController().signal,
        }
        const service = subject && registryModule
            ? subject.createStudioCardResourceService({
                context,
                adapter,
                assetAuthorityRegistry: new registryModule.ContextAssetAuthorityRegistry(),
                readCoordinator: { schedule: ({ run }: any) => run(new AbortController().signal) } as any,
                permissionGeneration: () => 'permission-1',
                requirePermission: async () => undefined,
            })
            : undefined

        const first = await service?.listStudioCards({ limit: 24 })
        expect(first?.items).toHaveLength(24)
        expect(first?.items[0].name).toBe('Alpha 02')
        expect(first?.hostActiveCard).toMatchObject({ cardId: 'card-60', portrait: { name: 'portrait.png' } })
        const second = await service?.listStudioCards({
            limit: 24,
            cursor: first?.nextCursor,
            catalogueRevision: first?.catalogueRevision,
        })
        expect(second?.catalogueRevision).toBe(first?.catalogueRevision)
        expect(second?.total).toBe(60)
        const third = await service?.listStudioCards({
            limit: 24,
            cursor: second?.nextCursor,
            catalogueRevision: first?.catalogueRevision,
        })
        expect(third?.items).toHaveLength(12)
        await expect(service?.captureStudioCardSource({
            cardId: first!.items[0].cardId,
            expectedCatalogueItemRevision: first!.items[0].catalogueItemRevision,
            catalogueRevision: first!.catalogueRevision,
        })).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(adapter.captureSource).not.toHaveBeenCalled()
        expect(captureCatalogue).toHaveBeenCalledTimes(1)
    })

    it('promotes an admitted selection, deduplicates direct members, and pages descriptors without handles', async () => {
        const subject = await loadSubject()
        const registryModule = await loadRegistry()
        const root = card('group-1', 'Group', 'group')
        const nativeSource = {
            nativeRevision: 'source-1',
            card: root,
            groupMembers: [card('member-b'), card('member-a'), card('member-a')],
            assets: Array.from({ length: 125 }, (_, index) => ({
                logicalIdentity: `asset-${index}`,
                revision: sha(`asset-${index}`),
                name: `${index}.png`,
                mediaType: 'image/png',
                role: 'additional' as const,
                locator: {
                    ownerCardId: 'group-1', ownerRevision: 'owner-1',
                    storageRevision: `storage-${index}`, nativeSlot: index,
                },
            })),
            authority: {},
        }
        const adapter = {
            captureCatalogue: async () => ({
                nativeRevision: 'catalogue-1', records: [{
                    cardId: 'group-1', catalogueItemRevision: 'item-1', kind: 'group' as const,
                    name: 'Group', groupMemberIds: ['member-b', 'member-a', 'member-a'],
                }], authority: {},
            }),
            revalidateCatalogue: () => true,
            captureSource: vi.fn(async () => structuredClone(nativeSource)),
            revalidateSource: () => true,
            readAsset: vi.fn(async () => new Uint8Array([1, 2, 3])),
            captureGeneration: () => 'generation-1',
            isGenerationCurrent: () => true,
        }
        const context = {
            principalId: 'principal-b', instanceId: 'instance-b', displayName: 'Studio',
            signal: new AbortController().signal,
        }
        const registry = registryModule ? new registryModule.ContextAssetAuthorityRegistry() : undefined
        const service = subject && registry
            ? subject.createStudioCardResourceService({
                context, adapter, assetAuthorityRegistry: registry,
                readCoordinator: { schedule: ({ run }: any) => run(new AbortController().signal) } as any,
                permissionGeneration: () => 'permission-1', requirePermission: async () => undefined,
            })
            : undefined
        const listing = await service?.listStudioCards({ limit: 24 })
        const capture = await service?.captureStudioCardSource({
            cardId: 'group-1', expectedCatalogueItemRevision: 'item-1',
            catalogueRevision: listing?.catalogueRevision ?? '',
        })
        expect(capture?.groupMembers.map((member) => member.id)).toEqual(['member-a', 'member-b'])
        const first = await service?.listStudioCardAssets({ captureRevision: capture?.captureRevision ?? '', limit: 100 })
        const second = await service?.listStudioCardAssets({
            captureRevision: capture?.captureRevision ?? '', cursor: first?.nextCursor, limit: 100,
        })
        expect(first?.assets).toHaveLength(100)
        expect(second?.assets).toHaveLength(25)
        expect(registry?.size(context.principalId, context.instanceId)).toBe(0)
        const access = await service?.resolveStudioCardAssetHandles({
            captureRevision: capture?.captureRevision ?? '',
            logicalAssetIds: first?.assets.slice(0, 3).map((asset) => asset.logicalAssetId) ?? [],
            purpose: 'selected',
        })
        expect(access?.assets).toHaveLength(3)
        expect(registry?.size(context.principalId, context.instanceId)).toBe(3)
    })
})
