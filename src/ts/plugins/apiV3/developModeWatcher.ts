export interface PluginFileWatchOptions {
    expectedPrincipalId: string
    signal: AbortSignal
    currentPrincipalId: () => string | undefined
    importPlugin: (code: string, options: {
        isHotReload: true
        isUpdate: true
        isTypescript: boolean
        expectedPrincipalId: string
    }) => Promise<unknown>
    poll: () => Promise<void>
    isTypescript?: boolean
    initialLastModified?: number
}

export async function watchPluginFile(fileHandle: FileSystemFileHandle, options: PluginFileWatchOptions) {
    let lastModified = options.initialLastModified ?? 0
    while (!options.signal.aborted) {
        if (options.currentPrincipalId() !== options.expectedPrincipalId) return
        const file = await fileHandle.getFile()
        if (file.lastModified !== lastModified) {
            lastModified = file.lastModified
            const content = await file.text()
            if (options.signal.aborted || options.currentPrincipalId() !== options.expectedPrincipalId) return
            await options.importPlugin(content, {
                isHotReload: true,
                isUpdate: true,
                isTypescript: options.isTypescript ?? false,
                expectedPrincipalId: options.expectedPrincipalId,
            })
        }
        if (!options.signal.aborted) await options.poll()
    }
}
