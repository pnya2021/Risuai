import { pluginDataLifecycle, type PluginDataLifecycleRegistry } from './pluginDataLifecycle'
import { contextAssetReadCoordinator } from './apiV3/illustration/contextAssetReadCoordinator'

export interface PrincipalReadRetirer {
    retirePrincipal(principalId: string): void
}

export interface PluginPrincipalRetirementOptions {
    operationId?: string
    invalidate: () => void | Promise<void>
    remove?: () => void | Promise<void>
}

export function retirePluginPrincipal(
    principalId: string,
    options: PluginPrincipalRetirementOptions,
    registry: PluginDataLifecycleRegistry = pluginDataLifecycle,
    readRetirer: PrincipalReadRetirer = contextAssetReadCoordinator,
) {
    const retirement = registry.retirePrincipal(principalId, options)
    readRetirer.retirePrincipal(principalId)
    return retirement
}

export async function retirePluginPrincipals(
    principalIds: readonly string[],
    invalidate: (principalId: string) => void | Promise<void>,
    registry: PluginDataLifecycleRegistry = pluginDataLifecycle,
    readRetirer: PrincipalReadRetirer = contextAssetReadCoordinator,
) {
    for (const principalId of principalIds) {
        await retirePluginPrincipal(principalId, {
            invalidate: () => invalidate(principalId),
        }, registry, readRetirer)
    }
}
