export interface FullEncoderReloadState { state: boolean }

export async function persistRestoredDatabaseAndInvalidateEncoder(
    persist: () => void | Promise<void>,
    reloadState: FullEncoderReloadState,
) {
    await persist()
    reloadState.state = true
}
