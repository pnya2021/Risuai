import { describe, expect, it, vi } from 'vitest'
import { CAPABILITY_CONTRACT, CAPABILITY_IDS } from './capabilityContract'
import { getCapabilities } from './capabilities'
import { INLAY_LIFECYCLE_CAPABILITY_IDS } from './inlayLifecycle'
import { DEVICE_CACHE_CAPABILITY_IDS } from './deviceCache'

const context = {
    principalId: '11111111-1111-4111-8111-111111111111',
    instanceId: 'instance',
    displayName: 'Demo',
    signal: new AbortController().signal,
}

describe('V3 capability discovery', () => {
    it('contains all fourteen version-one descriptors and exact registry data', () => {
        expect(CAPABILITY_IDS).toHaveLength(14)
        expect(Object.values(CAPABILITY_CONTRACT).every((entry) => entry.version === 1)).toBe(true)
        expect(CAPABILITY_CONTRACT['context.assets.v1'].permission).toBe('contextAssets')
        expect(CAPABILITY_CONTRACT['context.assets.v1'].additionalPermissions).toEqual(['installedModulesRead'])
        expect(CAPABILITY_CONTRACT['inlay.atomic-attach.v1'].additionalPermissions).toEqual(['chatWriteAll', 'inlayWrite'])
        expect(CAPABILITY_CONTRACT['storage.device-cache.v1'].permission).toBeUndefined()
        expect(CAPABILITY_CONTRACT['context.current.v1'].limits).toEqual({
            maxSnapshotJsonBytes: 2097152, maxJsonDepth: 32, maxTextFieldUtf8Bytes: 524288,
        })
    })

    it('locks every exact capability limit key and value to the reviewed registry', async () => {
        const serialized = JSON.stringify(CAPABILITY_CONTRACT)
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))]
            .map((value) => value.toString(16).padStart(2, '0')).join('')
        expect(new TextEncoder().encode(serialized).byteLength).toBe(5195)
        expect(digest).toBe('bc197fe68ca0129f4ca5351e66b49c46f83bfac17358cb74b0f0d9a3a8512b64')
    })

    it('returns an explicit descriptor for unknown IDs', async () => {
        expect((await getCapabilities(context, ['unknown.v1']))['unknown.v1']).toEqual({
            id: 'unknown.v1', version: 0, supported: false, available: false, reason: 'unknown-capability',
        })
    })

    it.each(['__proto__', 'constructor', 'toString'])('treats inherited object key %s as an own unknown descriptor', async (id) => {
        const result = await getCapabilities(context, [id])
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
        expect(Object.hasOwn(result, id)).toBe(true)
        expect(result[id]).toEqual({ id, version: 0, supported: false, available: false, reason: 'unknown-capability' })
    })

    it('keeps the exact permission matrix for every capability', () => {
        expect(Object.fromEntries(CAPABILITY_IDS.map((id) => [id, {
            permission: CAPABILITY_CONTRACT[id].permission,
            additionalPermissions: CAPABILITY_CONTRACT[id].additionalPermissions,
        }]))).toEqual({
            'context.current.v1': { permission: 'contextAssets', additionalPermissions: [] },
            'context.assets.v1': { permission: 'contextAssets', additionalPermissions: ['installedModulesRead'] },
            'context.modules-installed.v1': { permission: 'installedModulesRead', additionalPermissions: [] },
            'secrets.write-only.v1': { permission: 'secrets', additionalPermissions: [] },
            'chat.message-events.v1': { permission: 'chatObserve', additionalPermissions: ['chatObserveAll'] },
            'chat.message-query.v1': { permission: 'chatObserve', additionalPermissions: ['chatObserveAll'] },
            'chat.message-patch.v1': { permission: 'chatWrite', additionalPermissions: ['chatWriteAll', 'inlayWrite', 'inlayRead', 'inlayManage'] },
            'inlay.create.v1': { permission: 'inlayWrite', additionalPermissions: [] },
            'inlay.read.v1': { permission: 'inlayWrite', additionalPermissions: ['inlayRead'] },
            'inlay.delete-own.v1': { permission: 'inlayWrite', additionalPermissions: ['chatWrite', 'chatWriteAll', 'chatObserve', 'chatObserveAll'] },
            'inlay.atomic-attach.v1': { permission: 'chatWrite', additionalPermissions: ['chatWriteAll', 'inlayWrite'] },
            'local-model.pixai-v0.9.v1': { permission: 'localModelInference', additionalPermissions: ['contextAssets', 'inlayWrite', 'inlayRead'] },
            'storage.device-cache.v1': { permission: undefined, additionalPermissions: [] },
            'plugin-jobs.v1': { permission: 'pluginJobs', additionalPermissions: [] },
        })
    })

    it('reports temporarily unavailable before permission-required and never prompts', async () => {
        const permissionState = vi.fn(async () => 'not-requested' as const)
        const descriptors = await getCapabilities(context, ['context.current.v1'], {
            permissionState,
            runtime: { registeredServices: new Set() },
        })
        expect(descriptors['context.current.v1']).toMatchObject({
            supported: true, available: false, reason: 'temporarily-unavailable', permission: 'contextAssets',
        })
        expect(permissionState).not.toHaveBeenCalled()
    })

    it('reports permission state only after the service is callable', async () => {
        const denied = await getCapabilities(context, ['context.current.v1'], {
            permissionState: async () => 'denied',
            runtime: { registeredServices: new Set(['context.current.v1']), hasCurrentContext: true },
        })
        expect(denied['context.current.v1']).toMatchObject({ available: false, reason: 'permission-required', permissionState: 'denied' })
        const granted = await getCapabilities(context, ['context.current.v1'], {
            permissionState: async () => 'granted',
            runtime: { registeredServices: new Set(['context.current.v1']), hasCurrentContext: true },
        })
        expect(granted['context.current.v1']).toMatchObject({ available: true, permissionState: 'granted' })
        expect(granted['context.current.v1'].reason).toBeUndefined()
    })

    it('reports runtime context unavailability after permission is granted', async () => {
        const result = await getCapabilities(context, ['context.current.v1'], {
            permissionState: async () => 'granted',
            runtime: { registeredServices: new Set(['context.current.v1']), hasCurrentContext: false },
        })
        expect(result['context.current.v1']).toMatchObject({ available: false, reason: 'no-current-context' })
    })

    it('returns all known descriptors when IDs are omitted', async () => {
        expect(Object.keys(await getCapabilities(context))).toEqual(CAPABILITY_IDS)
    })

    it('registers only the usable owned Inlay lifecycle and still gates it on inlayWrite', async () => {
        expect(INLAY_LIFECYCLE_CAPABILITY_IDS).toEqual([
            'inlay.create.v1',
            'inlay.delete-own.v1',
        ])
        expect(INLAY_LIFECYCLE_CAPABILITY_IDS).not.toContain('inlay.atomic-attach.v1')

        const granted = await getCapabilities(context, [
            'inlay.create.v1',
            'inlay.delete-own.v1',
            'inlay.atomic-attach.v1',
        ], {
            permissionState: async () => 'granted',
            runtime: { registeredServices: new Set(INLAY_LIFECYCLE_CAPABILITY_IDS) },
        })
        expect(granted['inlay.create.v1']).toMatchObject({ available: true, permission: 'inlayWrite' })
        expect(granted['inlay.delete-own.v1']).toMatchObject({ available: true, permission: 'inlayWrite' })
        expect(granted['inlay.atomic-attach.v1']).toMatchObject({
            available: false,
            reason: 'temporarily-unavailable',
        })
    })

    it('makes only the principal device cache callable while PixAI remains unavailable', async () => {
        expect(DEVICE_CACHE_CAPABILITY_IDS).toEqual(['storage.device-cache.v1'])
        expect(DEVICE_CACHE_CAPABILITY_IDS).not.toContain('local-model.pixai-v0.9.v1')
        const descriptors = await getCapabilities(context, [
            'storage.device-cache.v1',
            'local-model.pixai-v0.9.v1',
        ], {
            permissionState: async () => 'granted',
            runtime: { registeredServices: new Set(DEVICE_CACHE_CAPABILITY_IDS) },
        })
        expect(descriptors['storage.device-cache.v1']).toMatchObject({ available: true })
        expect(descriptors['storage.device-cache.v1'].permission).toBeUndefined()
        expect(descriptors['local-model.pixai-v0.9.v1']).toMatchObject({
            available: false,
            reason: 'temporarily-unavailable',
        })
    })
})
