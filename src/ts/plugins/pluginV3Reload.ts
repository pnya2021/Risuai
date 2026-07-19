export async function replacePluginV3RuntimeSnapshot<TInstance, TPlugin>(options: {
    liveInstances: TInstance[]
    plugins: TPlugin[]
    unload: (instance: TInstance) => void | Promise<void>
    load: (plugin: TPlugin) => void | Promise<void>
}) {
    const retiring = [...options.liveInstances]
    await Promise.all(retiring.map((instance) => options.unload(instance)))
    await Promise.all(options.plugins.map((plugin) => options.load(plugin)))
}
