export type InstanceCleanup = () => void | Promise<void>

export function removeOwnedArrayEntry<T>(entries: T[], expected: T) {
    const index = entries.indexOf(expected)
    if (index >= 0) entries.splice(index, 1)
}

export function removeOwnedMapEntry<K, V>(entries: Map<K, V>, key: K, expected: V) {
    if (entries.get(key) === expected) entries.delete(key)
}

export function removeOwnedSetEntry<T>(entries: Set<T>, expected: T) {
    entries.delete(expected)
}

export function registerInstanceResourceIfActive(isActive: () => boolean, register: () => void) {
    if (!isActive()) return false
    register()
    return true
}

export function cleanupOwnedProviderRegistration<TProvider, TOptions>({
    name, provider, options, providers, providerOptions, removeName, removeModel,
}: {
    name: string
    provider: TProvider
    options: TOptions
    providers: Map<string, TProvider>
    providerOptions: Map<string, TOptions>
    removeName: () => void
    removeModel: () => void
}) {
    const ownsProvider = providers.get(name) === provider
    removeOwnedMapEntry(providers, name, provider)
    removeOwnedMapEntry(providerOptions, name, options)
    if (ownsProvider || !providers.has(name)) removeName()
    removeModel()
}

export class OwnedTimeoutSet {
    private timers = new Set<ReturnType<typeof setTimeout>>()
    schedule(callback: () => void, delay: number) {
        const timer = setTimeout(() => {
            this.timers.delete(timer)
            callback()
        }, delay)
        this.timers.add(timer)
    }
    clear() {
        for (const timer of this.timers) clearTimeout(timer)
        this.timers.clear()
    }
}

export async function retainOrCleanupInstanceResource(
    signal: AbortSignal,
    cleanup: InstanceCleanup,
    retain: (cleanup: InstanceCleanup) => void,
) {
    if (signal.aborted) await cleanup()
    else retain(cleanup)
}

export class InstanceCleanupRegistry {
    private callbacks = new Map<string, InstanceCleanup[]>()
    private closing = new Set<string>()

    add(instanceId: string, callback: InstanceCleanup) {
        if (this.closing.has(instanceId)) {
            void Promise.resolve().then(callback).catch(() => undefined)
            return () => undefined
        }
        const entries = this.callbacks.get(instanceId) ?? []
        if (!this.callbacks.has(instanceId)) this.callbacks.set(instanceId, entries)
        entries.push(callback)
        return () => {
            const current = this.callbacks.get(instanceId)
            if (!current) return
            const index = current.indexOf(callback)
            if (index >= 0) current.splice(index, 1)
            if (current.length === 0) this.callbacks.delete(instanceId)
        }
    }

    take(instanceId: string) {
        this.closing.add(instanceId)
        const entries = this.callbacks.get(instanceId) ?? []
        this.callbacks.delete(instanceId)
        return [...entries]
    }

    async drain(instanceId: string) {
        for (const callback of this.take(instanceId)) {
            try { await callback() } catch { /* one cleanup must not block later instance resources */ }
        }
    }

    count(instanceId: string) {
        return this.callbacks.get(instanceId)?.length ?? 0
    }

    isClosing(instanceId: string) { return this.closing.has(instanceId) }
}

type ChannelRegistration = {
    instanceId: string
    callback: Function
}

const channelKey = (pluginName: string, channelName: string) => JSON.stringify([pluginName, channelName])

export class InstanceChannelRegistry {
    private channels = new Map<string, ChannelRegistration>()

    register(pluginName: string, channelName: string, instanceId: string, callback: Function) {
        this.channels.set(channelKey(pluginName, channelName), { instanceId, callback })
    }

    get(pluginName: string, channelName: string) {
        return this.channels.get(channelKey(pluginName, channelName))?.callback
    }

    removeOwned(pluginName: string, channelName: string, instanceId: string) {
        const key = channelKey(pluginName, channelName)
        if (this.channels.get(key)?.instanceId === instanceId) this.channels.delete(key)
    }
}
