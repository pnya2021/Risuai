import { describe, expect, it, vi } from 'vitest'
import type { InlayAssetRecord } from 'src/ts/process/files/inlays'
import { createRisuInlayLifecycleAdapter } from './inlayLifecycle.risu'

const lifecycle = {
    version: 1 as const,
    ownerPrincipalId: 'principal-1',
    operation: 'inlay.create.v1' as const,
    idempotencyKey: 'create-1',
    argumentDigest: 'a'.repeat(64),
    revision: `sha256:${'b'.repeat(64)}`,
    context: { kind: 'character' as const, characterId: 'character-1' },
}

function harness(overrides: Record<string, unknown> = {}) {
    const stored = new Map<string, InlayAssetRecord>()
    const dependencies = {
        getDatabase: vi.fn(() => ({
            characters: [{
                chaId: 'character-1',
                chats: [{ message: [{ data: 'plain text' }] }],
            }],
        })),
        getCurrentCharacter: vi.fn(() => ({ chaId: 'character-1' })),
        listColdDataKeys: vi.fn(async () => [] as string[]),
        getColdStorageItem: vi.fn(async (_key: string) => null as unknown),
        getInlayAssetRecord: vi.fn(async (id: string) => stored.get(id) ?? null),
        writeInlayImageFromBytes: vi.fn(async (_data: Uint8Array, request: any) => {
            await request.beforeStore()
            stored.set(request.id, {
                data: new Blob(['png']),
                ext: 'png',
                height: 1,
                width: 1,
                name: request.name,
                type: 'image',
                lifecycle: request.lifecycle,
            })
            return request.id
        }),
        removeInlayAsset: vi.fn(async (id: string) => stored.delete(id)),
        ...overrides,
    }
    return { adapter: createRisuInlayLifecycleAdapter(dependencies as any), dependencies, stored }
}

describe('Risu owned Inlay adapter', () => {
    it('projects current character identity and private stored lifecycle metadata', async () => {
        const { adapter, stored } = harness()
        stored.set('inlay-1', {
            data: new Blob(['png']), ext: 'png', name: 'image.png', type: 'image',
            lifecycle,
        })

        expect(adapter.getCurrentCharacterId()).toBe('character-1')
        await expect(adapter.getInlay('inlay-1')).resolves.toEqual({
            id: 'inlay-1', name: 'image.png', revision: lifecycle.revision, lifecycle,
        })
    })

    it('passes a copied image and the immediate pre-storage authorization callback to the existing image path', async () => {
        const order: string[] = []
        const writeInlayImageFromBytes = vi.fn(async (data: Uint8Array, request: any) => {
            order.push('decoded')
            data.fill(0)
            await request.beforeStore()
            order.push('stored')
            return request.id
        })
        const { adapter } = harness({ writeInlayImageFromBytes })
        const bytes = new Uint8Array([1, 2])

        await adapter.writeImage(bytes, {
            id: 'inlay-1', name: 'image.png', lifecycle,
            beforeMutation: async () => { order.push('authorized') },
        })

        expect(order).toEqual(['decoded', 'authorized', 'stored'])
        expect(bytes).toEqual(new Uint8Array([1, 2]))
    })

    it('maps only image decode rejection to DECODE_FAILED', async () => {
        const decodeError = new Error('bad image')
        decodeError.name = 'InlayImageDecodeError'
        const { adapter } = harness({
            writeInlayImageFromBytes: vi.fn(async () => { throw decodeError }),
        })

        await expect(adapter.writeImage(new Uint8Array([1]), {
            id: 'inlay-1', name: 'image.png', lifecycle, beforeMutation: async () => undefined,
        })).rejects.toMatchObject({ name: 'PluginApiError', code: 'DECODE_FAILED' })
    })

    it.each(['inlay', 'inlayed', 'inlayeddata'])('finds an exact hydrated %s token', async (kind) => {
        const id = 'inlay_' + 'a'.repeat(64)
        const { adapter } = harness({
            getDatabase: vi.fn(() => ({
                characters: [{ chats: [{ message: [{ data: `before {{${kind}::${id}}} after` }] }] }],
            })),
        })

        await expect(adapter.hasReference(id)).resolves.toBe(true)
    })

    it('does not confuse a prefix or suffix with the exact token', async () => {
        const id = 'inlay_' + 'a'.repeat(64)
        const { adapter } = harness({
            getDatabase: vi.fn(() => ({
                characters: [{ chats: [{ message: [{ data: `{{inlayed::${id}extra}} {{inlay::prefix${id}}}` }] }] }],
            })),
        })

        await expect(adapter.hasReference(id)).resolves.toBe(false)
    })

    it('loads Risu cold-storage payloads on demand and finds character and chat references', async () => {
        const id = 'inlay_' + 'a'.repeat(64)
        const listColdDataKeys = vi.fn(async () => ['cold-character', 'cold-chat'])
        const getColdStorageItem = vi.fn(async (key: string) => key === 'cold-character'
            ? { character: { chats: [{ message: [{ data: 'unrelated' }] }] } }
            : { message: [{ data: `{{inlayeddata::${id}}}` }] })
        const { adapter } = harness({ listColdDataKeys, getColdStorageItem })

        await expect(adapter.hasReference(id)).resolves.toBe(true)

        expect(listColdDataKeys).toHaveBeenCalledOnce()
        expect(getColdStorageItem).toHaveBeenCalledTimes(2)
    })

    it.each([
        ['unreadable', null],
        ['malformed', { unexpected: [] }],
        ['malformed message', { message: [{ data: 42 }] }],
    ])('fails closed for %s cold storage', async (_label, payload) => {
        const { adapter } = harness({
            listColdDataKeys: vi.fn(async () => ['cold-1']),
            getColdStorageItem: vi.fn(async () => payload),
        })

        await expect(adapter.hasReference('inlay_' + 'a'.repeat(64)))
            .rejects.toMatchObject({ name: 'PluginApiError', code: 'INTERNAL', retryable: true })
    })
})
