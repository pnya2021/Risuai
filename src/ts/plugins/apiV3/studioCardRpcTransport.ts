export interface StudioCardRpcFinalizer {
    commit(): void
    rollback(): void
}

const finalizers = new WeakMap<object, StudioCardRpcFinalizer>()

export function registerStudioCardRpcFinalizer<T extends object>(
    value: T,
    finalizer: StudioCardRpcFinalizer,
): T {
    let settled = false
    const settle = (operation: () => void) => {
        if (settled) return
        settled = true
        operation()
    }
    finalizers.set(value, {
        commit: () => settle(finalizer.commit),
        rollback: () => settle(finalizer.rollback),
    })
    return value
}

export function takeStudioCardRpcFinalizer(value: unknown): StudioCardRpcFinalizer | undefined {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined
    const finalizer = finalizers.get(value)
    if (finalizer) finalizers.delete(value)
    return finalizer
}
