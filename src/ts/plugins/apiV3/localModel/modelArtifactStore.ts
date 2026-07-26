export type ArtifactStoreKind = "opfs" | "tauri"

export const MODEL_ARTIFACT_MAX_CHUNK_BYTES = 1_048_576

export interface ArtifactEstimate {
    usageBytes?: number
    quotaBytes?: number
    persistent: boolean
}

export interface ArtifactStat {
    state: "absent" | "partial" | "verified"
    bytes: number
    etag?: string
}

export interface ArtifactWriteMetadata {
    expectedBytes: number
    etag?: string
    restart?: boolean
}

export interface ArtifactReadOptions {
    chunkSize: number
}

export interface ModelArtifactReadable {
    readonly size: number
    chunks(options: ArtifactReadOptions): AsyncIterable<Uint8Array>
}

export interface ModelArtifactWriteHandle {
    readonly offset: number
    write(chunk: Uint8Array): Promise<void>
    commit(verifiedSha256: string): Promise<void>
    abort(options: { keepPartial: boolean }): Promise<void>
}

export interface ModelArtifactStore {
    readonly kind: ArtifactStoreKind
    readonly supportsResume: boolean
    estimate(): Promise<ArtifactEstimate>
    stat(digest: string): Promise<ArtifactStat>
    beginWrite(
        digest: string,
        metadata: ArtifactWriteMetadata,
    ): Promise<ModelArtifactWriteHandle>
    readPartial(
        digest: string,
        options: ArtifactReadOptions,
    ): AsyncIterable<Uint8Array>
    openVerified(digest: string): Promise<ModelArtifactReadable>
    remove(
        digest: string,
        options: { partial: boolean; verified: boolean },
    ): Promise<void>
}

export function assertArtifactDigest(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error("Invalid artifact digest")
    }
    return digest
}

export function assertArtifactWriteMetadata(
    metadata: ArtifactWriteMetadata,
): void {
    if (
        !Number.isSafeInteger(metadata.expectedBytes) ||
        metadata.expectedBytes <= 0
    ) {
        throw new Error("Invalid expected artifact size")
    }
    if (metadata.etag !== undefined && metadata.etag.length > 4_096) {
        throw new Error("Artifact ETag is too large")
    }
}
