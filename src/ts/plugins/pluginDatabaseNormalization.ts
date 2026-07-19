import { normalizePluginPrincipals, type PrincipalPluginRecord } from './pluginPrincipal'
import { pluginDataLifecycle } from './pluginDataLifecycle'

export function normalizePluginDatabaseState<TPlugin extends PrincipalPluginRecord>(
    data: { plugins?: TPlugin[] },
    isRetirementInProgress: (principalId: string) => boolean = (principalId) =>
        pluginDataLifecycle.isRetirementInProgress(principalId),
) {
    const normalized = normalizePluginPrincipals(data.plugins ?? [], {
        preserveTombstonedPrincipal: isRetirementInProgress,
    })
    data.plugins = normalized.records
    return { pluginStateChanged: normalized.changed }
}
