import { CAPABILITY_CONTRACT, CAPABILITY_IDS, type PluginCapabilityId } from './capabilityContract'
import type { PluginExecutionContext, PluginPermissionId, PluginPermissionState } from './permissions'

export type PluginCapabilityReason =
    | 'unknown-capability' | 'unsupported-platform' | 'unsupported-hardware'
    | 'disabled' | 'permission-required' | 'no-current-context' | 'not-configured'
    | 'consent-required' | 'insufficient-storage' | 'insufficient-memory'
    | 'temporarily-unavailable'

export interface PluginCapability {
    id: string
    version: number
    supported: boolean
    available: boolean
    permission?: PluginPermissionId
    permissionState?: PluginPermissionState
    reason?: PluginCapabilityReason
    limits?: Record<string, string | number | boolean>
}

export interface CapabilityRuntimeFacts {
    registeredServices: ReadonlySet<string>
    hasCurrentContext?: boolean
    unavailableReasons?: Partial<Record<PluginCapabilityId, PluginCapabilityReason>>
}

const defaultRuntime: CapabilityRuntimeFacts = { registeredServices: new Set() }

export async function getCapabilities(
    context: PluginExecutionContext,
    ids: string[] = [...CAPABILITY_IDS],
    dependencies: {
        permissionState?: (principalId: string, permission: PluginPermissionId) => Promise<PluginPermissionState>
        runtime?: CapabilityRuntimeFacts
    } = {},
): Promise<Record<string, PluginCapability>> {
    const runtime = dependencies.runtime ?? defaultRuntime
    const result: Record<string, PluginCapability> = {}
    const setResult = (id: string, descriptor: PluginCapability) => {
        Object.defineProperty(result, id, { value: descriptor, enumerable: true, writable: true, configurable: true })
    }
    for (const id of ids) {
        if (!Object.hasOwn(CAPABILITY_CONTRACT, id)) {
            setResult(id, { id, version: 0, supported: false, available: false, reason: 'unknown-capability' })
            continue
        }
        const contract = CAPABILITY_CONTRACT[id as PluginCapabilityId]
        const descriptor: PluginCapability = {
            id, version: contract.version, supported: true, available: false,
            limits: { ...contract.limits },
        }
        if (contract.permission) descriptor.permission = contract.permission
        if (!runtime.registeredServices.has(id)) {
            descriptor.reason = 'temporarily-unavailable'
            setResult(id, descriptor)
            continue
        }
        const runtimeReason = runtime.unavailableReasons?.[id as PluginCapabilityId]
            ?? (contract.requiresCurrentContext && runtime.hasCurrentContext === false ? 'no-current-context' : undefined)
        if (runtimeReason) {
            descriptor.reason = runtimeReason
            setResult(id, descriptor)
            continue
        }
        if (contract.permission) {
            const permissionState = await dependencies.permissionState?.(context.principalId, contract.permission) ?? 'not-requested'
            descriptor.permissionState = permissionState
            if (permissionState !== 'granted') {
                descriptor.reason = 'permission-required'
                setResult(id, descriptor)
                continue
            }
        }
        descriptor.available = true
        setResult(id, descriptor)
    }
    return result
}
