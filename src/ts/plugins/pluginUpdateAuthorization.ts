import { isCanonicalPluginPrincipalId } from './pluginPrincipal'

export interface PrincipalBoundPluginUpdateTarget {
    name: string
    script: string
    updateURL?: string
    principalId?: string
}

export interface PrincipalBoundPluginUpdateOptions {
    isUpdate: true
    originalPluginName: string
    expectedPrincipalId: string
    expectedPluginScript: string
}

export async function runPrincipalBoundPluginUpdate(
    plugin: PrincipalBoundPluginUpdateTarget,
    dependencies: {
        fetchUpdate: (url: string) => Promise<{ status: number; text: () => Promise<string> }>
        isInstalledRecordCurrent: (name: string, principalId: string, script: string) => boolean
        importUpdate: (code: string, options: PrincipalBoundPluginUpdateOptions) => Promise<unknown>
    },
): Promise<boolean> {
    if (!plugin.updateURL || !isCanonicalPluginPrincipalId(plugin.principalId)) return false
    const expectedPrincipalId = plugin.principalId
    const expectedPluginScript = plugin.script
    const response = await dependencies.fetchUpdate(plugin.updateURL)
    if (response.status < 200 || response.status >= 300) return false
    const code = await response.text()
    if (!dependencies.isInstalledRecordCurrent(plugin.name, expectedPrincipalId, expectedPluginScript)) return false
    return !!(await dependencies.importUpdate(code, {
        isUpdate: true,
        originalPluginName: plugin.name,
        expectedPrincipalId,
        expectedPluginScript,
    }))
}
