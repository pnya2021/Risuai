import { alertError } from "src/ts/alert"
import { importPlugin } from "../plugins.svelte"
import { sleep } from "src/ts/util"
import { DBState } from "src/ts/stores.svelte"
import { pluginDataLifecycle } from "../pluginDataLifecycle"
import { watchPluginFile } from './developModeWatcher'

const watcherControllers = new Map<string, AbortController>()

export async function hotReloadPluginFiles(){

    if(!('showOpenFilePicker' in window)){
        alertError("Your browser does not support the File System Access API, which is required for hot-reloading plugin files.")
        return
    }

    let fileHandle: FileSystemFileHandle
    try {
        [fileHandle] = await window.showOpenFilePicker({
            types: [
                {
                    description: "JavaScript or TypeScript Plugin File",
                    accept: {
                        "text/typescript": [".ts"],
                        "application/javascript": [".js"]
                    }
                }
            ]
        })   
    } catch (error) {
        return
    }

    const initialFile = await fileHandle.getFile()
    const installed = await importPlugin(await initialFile.text(), {
        isHotReload: true,
        isUpdate: true,
        isTypescript: initialFile.name.endsWith(".ts")
    })
    if (!installed?.principalId) return

    watcherControllers.get(installed.principalId)?.abort()
    const controller = new AbortController()
    watcherControllers.set(installed.principalId, controller)
    const watcherInstanceId = `develop:${crypto.randomUUID()}`
    const unregister = pluginDataLifecycle.registerInstanceStop(
        installed.principalId,
        watcherInstanceId,
        () => controller.abort(),
    )
    void watchPluginFile(fileHandle, {
        expectedPrincipalId: installed.principalId,
        signal: controller.signal,
        currentPrincipalId: () => DBState.db.plugins.find((plugin) => plugin.name === installed.name)?.principalId,
        importPlugin,
        poll: async () => { await sleep(500) },
        isTypescript: initialFile.name.endsWith('.ts'),
        initialLastModified: initialFile.lastModified,
    }).catch((error) => console.error('Error reading plugin development file:', error)).finally(() => {
        unregister()
        if (watcherControllers.get(installed.principalId!) === controller) watcherControllers.delete(installed.principalId!)
    })
    return () => controller.abort()
}
