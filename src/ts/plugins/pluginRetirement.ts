import { pluginDataLifecycle, type PluginDataLifecycleRegistry } from './pluginDataLifecycle'
import { contextAssetReadCoordinator } from './apiV3/illustration/contextAssetReadCoordinator'
import { illustrationCursorRegistry } from './apiV3/illustration/cursorRegistry'
import { illustrationQueryCaptureCache } from './apiV3/illustration/queryCaptureCache'

export interface PrincipalReadRetirer {
    retirePrincipal(principalId: string): void
}

export interface PrincipalCatalogueRetirer {
    clearPrincipal(principalId: string): void
}

const contextCatalogueRetirer: PrincipalCatalogueRetirer = {
    clearPrincipal(principalId) {
        illustrationQueryCaptureCache.clearPrincipal(principalId)
        illustrationCursorRegistry.clearPrincipal(principalId)
    },
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
    catalogueRetirer: PrincipalCatalogueRetirer = contextCatalogueRetirer,
) {
    catalogueRetirer.clearPrincipal(principalId)
    readRetirer.retirePrincipal(principalId)
    return registry.retirePrincipal(principalId, options)
}

export async function retirePluginPrincipals(
    principalIds: readonly string[],
    invalidate: (principalId: string) => void | Promise<void>,
    registry: PluginDataLifecycleRegistry = pluginDataLifecycle,
    readRetirer: PrincipalReadRetirer = contextAssetReadCoordinator,
    catalogueRetirer: PrincipalCatalogueRetirer = contextCatalogueRetirer,
) {
    for (const principalId of principalIds) {
        await retirePluginPrincipal(principalId, {
            invalidate: () => invalidate(principalId),
        }, registry, readRetirer, catalogueRetirer)
    }
}
