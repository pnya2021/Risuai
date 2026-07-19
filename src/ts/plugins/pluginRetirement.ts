import { pluginDataLifecycle, type PluginDataLifecycleRegistry } from './pluginDataLifecycle'

export async function retirePluginPrincipals(
    principalIds: readonly string[],
    invalidate: (principalId: string) => void | Promise<void>,
    registry: PluginDataLifecycleRegistry = pluginDataLifecycle,
) {
    for (const principalId of principalIds) {
        await registry.retirePrincipal(principalId, {
            invalidate: () => invalidate(principalId),
        })
    }
}
