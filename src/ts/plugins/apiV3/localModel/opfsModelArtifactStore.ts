import {
    assertArtifactDigest,
    assertArtifactWriteMetadata,
    type ArtifactEstimate,
    type ArtifactReadOptions,
    type ArtifactStat,
    type ArtifactWriteMetadata,
    type ModelArtifactReadable,
    type ModelArtifactStore,
    type ModelArtifactWriteHandle,
} from "./modelArtifactStore"

interface StoredMetadata {
    version: 1
    digest: string
    expectedBytes: number
    etag?: string
    verified: boolean
}

export interface OpfsModelArtifactStoreOptions {
    rootName?: string
    getRoot?: () => Promise<FileSystemDirectoryHandle>
    estimateStorage?: () => Promise<{ usage?: number; quota?: number }>
}

function isNotFound(error: unknown): boolean {
    return (
        (error instanceof DOMException && error.name === "NotFoundError") ||
        (error instanceof Error && /not found|missing/i.test(error.message))
    )
}

async function ignoreNotFound(action: () => Promise<void>): Promise<void> {
    try {
        await action()
    } catch (error) {
        if (!isNotFound(error)) throw error
    }
}

function validateChunkSize(options: ArtifactReadOptions): number {
    if (!Number.isSafeInteger(options.chunkSize) || options.chunkSize <= 0) {
        throw new Error("Invalid artifact read chunk size")
    }
    return options.chunkSize
}

export class OpfsModelArtifactStore implements ModelArtifactStore {
    readonly kind = "opfs" as const
    readonly supportsResume = true
    private readonly rootName: string
    private readonly getRoot: () => Promise<FileSystemDirectoryHandle>
    private readonly estimateStorage: () => Promise<{
        usage?: number
        quota?: number
    }>

    constructor(options: OpfsModelArtifactStoreOptions = {}) {
        this.rootName = options.rootName ?? "plugin-local-model-v1"
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(this.rootName)) {
            throw new Error("Invalid OPFS model artifact root name")
        }
        this.getRoot =
            options.getRoot ?? (() => navigator.storage.getDirectory())
        this.estimateStorage =
            options.estimateStorage ?? (() => navigator.storage.estimate())
    }

    async estimate(): Promise<ArtifactEstimate> {
        const estimate = await this.estimateStorage()
        return {
            ...(estimate.usage === undefined
                ? {}
                : { usageBytes: estimate.usage }),
            ...(estimate.quota === undefined
                ? {}
                : { quotaBytes: estimate.quota }),
            persistent: true,
        }
    }

    async stat(digest: string): Promise<ArtifactStat> {
        assertArtifactDigest(digest)
        const directory = await this.directory()
        const file = await this.getFile(directory, this.dataName(digest))
        const verifiedMetadata = await this.readMetadata(
            directory,
            this.verifiedMetadataName(digest),
            digest,
        )
        const partialMetadata = await this.readMetadata(
            directory,
            this.partialMetadataName(digest),
            digest,
        )
        if (!file) return { state: "absent", bytes: 0 }
        if (
            verifiedMetadata?.verified === true &&
            verifiedMetadata.digest === digest &&
            verifiedMetadata.expectedBytes === file.size
        ) {
            return {
                state: "verified",
                bytes: file.size,
                ...(verifiedMetadata.etag
                    ? { etag: verifiedMetadata.etag }
                    : {}),
            }
        }
        return {
            state: "partial",
            bytes: file.size,
            ...(partialMetadata?.digest === digest && partialMetadata.etag
                ? { etag: partialMetadata.etag }
                : {}),
        }
    }

    async beginWrite(
        digest: string,
        metadata: ArtifactWriteMetadata,
    ): Promise<ModelArtifactWriteHandle> {
        assertArtifactDigest(digest)
        assertArtifactWriteMetadata(metadata)
        const directory = await this.directory()
        const current = await this.stat(digest)
        if (current.state === "verified" && !metadata.restart) {
            throw new Error("Artifact is already verified")
        }
        if (metadata.restart) {
            await this.removeFiles(directory, digest)
        } else if (current.bytes > metadata.expectedBytes) {
            throw new Error("Partial artifact exceeds expected size")
        }

        const fileHandle = await directory.getFileHandle(this.dataName(digest), {
            create: true,
        })
        const file = await fileHandle.getFile()
        const offset = metadata.restart ? 0 : file.size
        await ignoreNotFound(() =>
            directory.removeEntry(this.verifiedMetadataName(digest)),
        )
        await this.writeMetadata(directory, this.partialMetadataName(digest), {
            version: 1,
            digest,
            expectedBytes: metadata.expectedBytes,
            ...(metadata.etag ? { etag: metadata.etag } : {}),
            verified: false,
        })
        const writable = await fileHandle.createWritable({
            keepExistingData: offset > 0,
        })
        if (offset > 0) await writable.seek(offset)
        let written = offset
        let closed = false

        const closeKeepingPartial = async () => {
            if (closed) return
            closed = true
            await writable.close()
        }
        const discardAndClose = async () => {
            if (!closed) {
                closed = true
                await writable.abort().catch(() => undefined)
            }
            await this.removeFiles(directory, digest)
        }

        return {
            offset,
            write: async (chunk) => {
                if (closed) throw new Error("Artifact writer is closed")
                if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
                    throw new Error("Artifact chunk must be non-empty bytes")
                }
                if (written + chunk.byteLength > metadata.expectedBytes) {
                    await discardAndClose()
                    throw new Error("Artifact write exceeds expected size")
                }
                try {
                    await writable.write(chunk.slice())
                    written += chunk.byteLength
                } catch (error) {
                    closed = true
                    await writable.abort().catch(() => undefined)
                    throw error
                }
            },
            commit: async (verifiedSha256) => {
                if (closed) throw new Error("Artifact writer is closed")
                if (verifiedSha256 !== digest || written !== metadata.expectedBytes) {
                    await closeKeepingPartial()
                    throw new Error("Artifact cannot be committed before exact verification")
                }
                await closeKeepingPartial()
                const stored = await fileHandle.getFile()
                if (stored.size !== metadata.expectedBytes) {
                    throw new Error("Stored artifact size changed before commit")
                }
                await ignoreNotFound(() =>
                    directory.removeEntry(this.partialMetadataName(digest)),
                )
                await this.writeMetadata(
                    directory,
                    this.verifiedMetadataName(digest),
                    {
                    version: 1,
                    digest,
                    expectedBytes: metadata.expectedBytes,
                    ...(metadata.etag ? { etag: metadata.etag } : {}),
                    verified: true,
                    },
                )
            },
            abort: async ({ keepPartial }) => {
                if (closed) return
                if (keepPartial) await closeKeepingPartial()
                else await discardAndClose()
            },
        }
    }

    async *readPartial(
        digest: string,
        options: ArtifactReadOptions,
    ): AsyncIterable<Uint8Array> {
        assertArtifactDigest(digest)
        const chunkSize = validateChunkSize(options)
        const directory = await this.directory()
        const file = await this.getFile(directory, this.dataName(digest))
        if (!file) return
        for (let offset = 0; offset < file.size; offset += chunkSize) {
            const buffer = await file
                .slice(offset, Math.min(file.size, offset + chunkSize))
                .arrayBuffer()
            yield new Uint8Array(buffer).slice()
        }
    }

    async openVerified(digest: string): Promise<ModelArtifactReadable> {
        assertArtifactDigest(digest)
        const state = await this.stat(digest)
        if (state.state !== "verified") {
            throw new Error("Artifact is not verified")
        }
        const directory = await this.directory()
        const file = await this.getFile(directory, this.dataName(digest))
        if (!file || file.size !== state.bytes) {
            throw new Error("Artifact is not verified")
        }
        return {
            size: file.size,
            chunks: async function* (options) {
                const chunkSize = validateChunkSize(options)
                for (let offset = 0; offset < file.size; offset += chunkSize) {
                    const buffer = await file
                        .slice(offset, Math.min(file.size, offset + chunkSize))
                        .arrayBuffer()
                    yield new Uint8Array(buffer).slice()
                }
            },
        }
    }

    async remove(
        digest: string,
        options: { partial: boolean; verified: boolean },
    ): Promise<void> {
        assertArtifactDigest(digest)
        const state = await this.stat(digest)
        if (
            (state.state === "verified" && options.verified) ||
            (state.state === "partial" && options.partial) ||
            (state.state === "absent" && options.partial)
        ) {
            await this.removeFiles(await this.directory(), digest)
        }
    }

    private async directory(): Promise<FileSystemDirectoryHandle> {
        const root = await this.getRoot()
        return root.getDirectoryHandle(this.rootName, { create: true })
    }

    private dataName(digest: string): string {
        return `${digest}.data`
    }

    private verifiedMetadataName(digest: string): string {
        return `${digest}.verified.json`
    }

    private partialMetadataName(digest: string): string {
        return `${digest}.partial.json`
    }

    private async getFile(
        directory: FileSystemDirectoryHandle,
        name: string,
    ): Promise<File | undefined> {
        try {
            const handle = await directory.getFileHandle(name)
            return await handle.getFile()
        } catch (error) {
            if (isNotFound(error)) return undefined
            throw error
        }
    }

    private async readMetadata(
        directory: FileSystemDirectoryHandle,
        name: string,
        digest: string,
    ): Promise<StoredMetadata | undefined> {
        const file = await this.getFile(directory, name)
        if (!file || file.size > 16_384) return undefined
        try {
            const value = JSON.parse(await file.text()) as Partial<StoredMetadata>
            if (
                value.version !== 1 ||
                value.digest !== digest ||
                !Number.isSafeInteger(value.expectedBytes) ||
                typeof value.verified !== "boolean" ||
                (value.etag !== undefined && typeof value.etag !== "string")
            ) {
                return undefined
            }
            return value as StoredMetadata
        } catch {
            return undefined
        }
    }

    private async writeMetadata(
        directory: FileSystemDirectoryHandle,
        name: string,
        metadata: StoredMetadata,
    ): Promise<void> {
        const handle = await directory.getFileHandle(name, { create: true })
        const writable = await handle.createWritable()
        try {
            await writable.write(
                new TextEncoder().encode(JSON.stringify(metadata)),
            )
            await writable.close()
        } catch (error) {
            await writable.abort().catch(() => undefined)
            throw error
        }
    }

    private async removeFiles(
        directory: FileSystemDirectoryHandle,
        digest: string,
    ): Promise<void> {
        await ignoreNotFound(() => directory.removeEntry(this.dataName(digest)))
        await ignoreNotFound(() =>
            directory.removeEntry(this.partialMetadataName(digest)),
        )
        await ignoreNotFound(() =>
            directory.removeEntry(this.verifiedMetadataName(digest)),
        )
    }
}
