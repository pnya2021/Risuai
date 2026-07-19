export type ProviderResult = { success: boolean; content: string }

export async function invokePermissionCheckedProvider<T>(
    requestPermission: () => Promise<boolean>,
    provider: (argument: T, abortSignal?: AbortSignal) => Promise<ProviderResult>,
    argument: T,
    abortSignal?: AbortSignal,
    ownerSignal?: AbortSignal,
): Promise<ProviderResult> {
    if (ownerSignal?.aborted) return { success: false, content: 'Permission denied: provider' }
    if (!await requestPermission()) return { success: false, content: 'Permission denied: provider' }
    if (ownerSignal?.aborted) return { success: false, content: 'Permission denied: provider' }
    return provider(argument, abortSignal)
}
