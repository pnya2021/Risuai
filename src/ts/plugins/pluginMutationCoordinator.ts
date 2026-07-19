export class PluginMutationCoordinator {
    private tail: Promise<unknown> = Promise.resolve()

    run<T>(mutation: () => Promise<T> | T): Promise<T> {
        const operation = this.tail.catch(() => undefined).then(mutation)
        this.tail = operation
        return operation
    }
}

export const pluginMutationCoordinator = new PluginMutationCoordinator()
export const withPluginMutationLock = <T>(mutation: () => Promise<T> | T) =>
    pluginMutationCoordinator.run(mutation)

export function runAuthorizedPluginMutation<T>(
    coordinator: PluginMutationCoordinator,
    authorize: () => boolean,
    mutation: () => Promise<T> | T,
) {
    return coordinator.run(() => {
        if (!authorize()) throw new Error('Plugin installed record is no longer current')
        return mutation()
    })
}

export const withAuthorizedPluginMutationLock = <T>(
    authorize: () => boolean,
    mutation: () => Promise<T> | T,
) => runAuthorizedPluginMutation(pluginMutationCoordinator, authorize, mutation)

export class PluginRuntimeReloadCoordinator<TSnapshot> {
    private tail: Promise<unknown> = Promise.resolve()

    async acquire() {
        let releaseGate!: () => void
        const gate = new Promise<void>((resolve) => { releaseGate = resolve })
        const predecessor = this.tail.catch(() => undefined)
        this.tail = predecessor.then(() => gate)
        await predecessor
        let released = false
        return () => {
            if (released) return
            released = true
            releaseGate()
        }
    }

    async run<T>(snapshot: () => TSnapshot, reload: (snapshot: TSnapshot) => Promise<T> | T) {
        const release = await this.acquire()
        try { return await reload(snapshot()) } finally { release() }
    }
}

export const pluginRuntimeReloadCoordinator = new PluginRuntimeReloadCoordinator<unknown>()
