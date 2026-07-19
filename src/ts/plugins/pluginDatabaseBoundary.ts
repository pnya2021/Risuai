import { stripPluginPrincipal, type PrincipalPluginRecord } from './pluginPrincipal'

type BoundaryDatabase = {
    plugins?: PrincipalPluginRecord[]
    pluginCustomStorage?: Record<string, unknown>
}

export function createPluginDatabaseBoundary<T extends BoundaryDatabase>(target: T, allowedKeys: readonly string[]): T {
    const publicPlugins = () => (target.plugins ?? []).map((plugin) => stripPluginPrincipal(plugin))
    return new Proxy(target, {
        get(database, prop) {
            if (prop === 'plugins') return publicPlugins()
            if (typeof prop === 'string' && allowedKeys.includes(prop)) return (database as any)[prop]
            return database.pluginCustomStorage?.[String(prop)]
        },
        set(database, prop, value) {
            if (prop === 'plugins') throw new Error('Direct plugin-array assignment is blocked; use setDatabase() so Host lifecycle checks can run.')
            if (typeof prop === 'string' && allowedKeys.includes(prop)) (database as any)[prop] = value
            else (database.pluginCustomStorage ??= {})[String(prop)] = value
            return true
        },
        ownKeys(database) {
            const allowed = Reflect.ownKeys(database).filter((key) => typeof key === 'string' && allowedKeys.includes(key))
            const custom = Object.keys(database.pluginCustomStorage ?? {}).filter((key) => !allowed.includes(key))
            return [...allowed, ...custom]
        },
        getOwnPropertyDescriptor(database, prop) {
            if (prop === 'plugins') {
                const source = Reflect.getOwnPropertyDescriptor(database, prop)
                return { configurable: true, enumerable: source?.enumerable ?? true, writable: false, value: publicPlugins() }
            }
            if (typeof prop === 'string' && allowedKeys.includes(prop)) return Reflect.getOwnPropertyDescriptor(database, prop)
            if (typeof prop === 'string' && Object.hasOwn(database.pluginCustomStorage ?? {}, prop)) {
                return { configurable: true, enumerable: true, writable: true, value: database.pluginCustomStorage![prop] }
            }
        },
        defineProperty(database, prop, descriptor) {
            if (prop === 'plugins') throw new Error('Direct plugin-array definition is blocked; use setDatabase().')
            if (typeof prop === 'string' && allowedKeys.includes(prop)) return Reflect.defineProperty(database, prop, descriptor)
            if (!Object.hasOwn(descriptor, 'value')) return false
            ;(database.pluginCustomStorage ??= {})[String(prop)] = descriptor.value
            return true
        },
        deleteProperty() { return false },
        getPrototypeOf(database) { return Reflect.getPrototypeOf(database) },
    })
}
