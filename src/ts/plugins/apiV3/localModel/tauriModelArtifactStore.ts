import {
    BaseDirectory,
    SeekMode,
    mkdir,
    open,
    readTextFile,
    remove,
    rename,
    stat,
    writeTextFile,
} from "@tauri-apps/plugin-fs"
import {
    MODEL_ARTIFACT_MAX_CHUNK_BYTES,
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

type BaseOptions = { baseDir?: BaseDirectory }

export interface TauriArtifactFile {
    read(buffer: Uint8Array): Promise<number | null>
    write(data: Uint8Array): Promise<number>
    seek(offset: number, mode: SeekMode): Promise<number>
    close(): Promise<void>
}

export interface TauriFsBindings {
    mkdir(
        path: string,
        options: BaseOptions & { recursive?: boolean },
    ): Promise<void>
    stat(path: string, options: BaseOptions): Promise<{ size: number }>
    open(
        path: string,
        options: BaseOptions & {
            read?: boolean
            write?: boolean
            create?: boolean
            truncate?: boolean
        },
    ): Promise<TauriArtifactFile>
    readTextFile(path: string, options: BaseOptions): Promise<string>
    writeTextFile(
        path: string,
        value: string,
        options: BaseOptions,
    ): Promise<void>
    rename(
        from: string,
        to: string,
        options: {
            oldPathBaseDir?: BaseDirectory
            newPathBaseDir?: BaseDirectory
        },
    ): Promise<void>
    remove(path: string, options: BaseOptions): Promise<void>
}

const defaultFs: TauriFsBindings = {
    mkdir,
    stat,
    open,
    readTextFile,
    writeTextFile,
    rename,
    remove,
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && /not found|missing/i.test(error.message)
}

async function ignoreNotFound(action: () => Promise<void>): Promise<void> {
    try {
        await action()
    } catch (error) {
        if (!isNotFound(error)) throw error
    }
}

function validateChunkSize(options: ArtifactReadOptions): number {
    if (
        !Number.isSafeInteger(options.chunkSize) ||
        options.chunkSize <= 0 ||
        options.chunkSize > MODEL_ARTIFACT_MAX_CHUNK_BYTES
    ) {
        throw new Error("Invalid artifact read chunk size")
    }
    return options.chunkSize
}

export class TauriModelArtifactStore implements ModelArtifactStore {
    readonly kind = "tauri" as const
    readonly supportsResume = true
    private readonly fs: TauriFsBindings
    private readonly rootName: string

    constructor(options: { fs?: TauriFsBindings; rootName?: string } = {}) {
        this.fs = options.fs ?? defaultFs
        this.rootName = options.rootName ?? "plugin-local-model-v1"
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(this.rootName)) {
            throw new Error("Invalid Tauri model artifact root name")
        }
    }

    async estimate(): Promise<ArtifactEstimate> {
        return { persistent: true }
    }

    async stat(digest: string): Promise<ArtifactStat> {
        assertArtifactDigest(digest)
        await this.ensureRoot()
        const verifiedMetadata = await this.readMetadata(
            this.metadataPath(digest),
            digest,
        )
        const partialMetadata = await this.readMetadata(
            this.partialMetadataPath(digest),
            digest,
        )
        const dataSize = await this.fileSize(this.dataPath(digest))
        if (
            dataSize !== undefined &&
            verifiedMetadata?.verified === true &&
            verifiedMetadata.digest === digest &&
            verifiedMetadata.expectedBytes === dataSize
        ) {
            return {
                state: "verified",
                bytes: dataSize,
                ...(verifiedMetadata.etag
                    ? { etag: verifiedMetadata.etag }
                    : {}),
            }
        }
        const partialSize = await this.fileSize(this.partialPath(digest))
        const bytes = partialSize ?? dataSize
        if (bytes === undefined) return { state: "absent", bytes: 0 }
        return {
            state: "partial",
            bytes,
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
        await this.ensureRoot()
        const state = await this.stat(digest)
        if (state.state === "verified" && !metadata.restart) {
            throw new Error("Artifact is already verified")
        }
        if (metadata.restart) {
            await this.removeFiles(digest)
        } else if (state.bytes > metadata.expectedBytes) {
            throw new Error("Partial artifact exceeds expected size")
        }

        const partialExists =
            !metadata.restart &&
            (await this.fileSize(this.partialPath(digest))) !== undefined
        const dataExists =
            !metadata.restart &&
            (await this.fileSize(this.dataPath(digest))) !== undefined
        const path = partialExists || !dataExists
            ? this.partialPath(digest)
            : this.dataPath(digest)
        const offset = metadata.restart
            ? 0
            : ((await this.fileSize(path)) ?? 0)
        await ignoreNotFound(() =>
            this.fs.remove(this.metadataPath(digest), {
                baseDir: BaseDirectory.AppData,
            }),
        )
        await this.writePartialMetadata({
            version: 1,
            digest,
            expectedBytes: metadata.expectedBytes,
            ...(metadata.etag ? { etag: metadata.etag } : {}),
            verified: false,
        })
        const file = await this.fs.open(path, {
            read: true,
            write: true,
            create: true,
            truncate: metadata.restart,
            baseDir: BaseDirectory.AppData,
        })
        await file.seek(offset, SeekMode.Start)
        let written = offset
        let handleClosed = false
        let terminal = false
        const closeFile = async () => {
            if (handleClosed) return
            handleClosed = true
            await file.close()
        }

        return {
            offset,
            write: async (chunk) => {
                if (terminal || handleClosed) {
                    throw new Error("Artifact writer is closed")
                }
                if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
                    throw new Error("Artifact chunk must be non-empty bytes")
                }
                if (written + chunk.byteLength > metadata.expectedBytes) {
                    await closeFile()
                    terminal = true
                    await this.removeFiles(digest)
                    throw new Error("Artifact write exceeds expected size")
                }
                try {
                    const copied = chunk.slice()
                    const count = await file.write(copied)
                    if (count !== copied.byteLength) {
                        throw new Error("Artifact write was incomplete")
                    }
                    written += count
                } catch (error) {
                    await closeFile().catch(() => undefined)
                    throw error
                }
            },
            commit: async (verifiedSha256) => {
                if (terminal || handleClosed) {
                    throw new Error("Artifact writer is closed")
                }
                if (verifiedSha256 !== digest || written !== metadata.expectedBytes) {
                    await closeFile()
                    terminal = true
                    throw new Error("Artifact cannot be committed before exact verification")
                }
                await closeFile()
                terminal = true
                const physicalSize = await this.fileSize(path)
                if (physicalSize !== metadata.expectedBytes) {
                    throw new Error("Stored artifact size changed before commit")
                }
                if (path !== this.dataPath(digest)) {
                    await ignoreNotFound(() =>
                        this.fs.remove(this.dataPath(digest), {
                            baseDir: BaseDirectory.AppData,
                        }),
                    )
                    await this.fs.rename(path, this.dataPath(digest), {
                        oldPathBaseDir: BaseDirectory.AppData,
                        newPathBaseDir: BaseDirectory.AppData,
                    })
                }
                await ignoreNotFound(() =>
                    this.fs.remove(this.partialMetadataPath(digest), {
                        baseDir: BaseDirectory.AppData,
                    }),
                )
                await this.writeMetadata(
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
                if (terminal) return
                await closeFile()
                terminal = true
                if (!keepPartial) await this.removeFiles(digest)
            },
        }
    }

    async *readPartial(
        digest: string,
        options: ArtifactReadOptions,
    ): AsyncIterable<Uint8Array> {
        assertArtifactDigest(digest)
        const chunkSize = validateChunkSize(options)
        await this.ensureRoot()
        const path = await this.partialPhysicalPath(digest)
        if (!path) return
        const file = await this.fs.open(path, {
            read: true,
            baseDir: BaseDirectory.AppData,
        })
        try {
            while (true) {
                const target = new Uint8Array(chunkSize)
                const count = await file.read(target)
                if (count === null) break
                if (count <= 0 || count > target.byteLength) {
                    throw new Error("Invalid artifact read size")
                }
                yield target.slice(0, count)
            }
        } finally {
            await file.close()
        }
    }

    async openVerified(digest: string): Promise<ModelArtifactReadable> {
        assertArtifactDigest(digest)
        const state = await this.stat(digest)
        if (state.state !== "verified") {
            throw new Error("Artifact is not verified")
        }
        const path = this.dataPath(digest)
        const currentSize = await this.fileSize(path)
        if (currentSize !== state.bytes) throw new Error("Artifact is not verified")
        const fs = this.fs
        return {
            size: state.bytes,
            chunks: async function* (options) {
                const chunkSize = validateChunkSize(options)
                const file = await fs.open(path, {
                    read: true,
                    baseDir: BaseDirectory.AppData,
                })
                try {
                    let total = 0
                    while (true) {
                        const target = new Uint8Array(chunkSize)
                        const count = await file.read(target)
                        if (count === null) break
                        if (count <= 0 || count > target.byteLength) {
                            throw new Error("Invalid artifact read size")
                        }
                        total += count
                        if (total > state.bytes) {
                            throw new Error("Verified artifact grew during read")
                        }
                        yield target.slice(0, count)
                    }
                    if (total !== state.bytes) {
                        throw new Error("Verified artifact shrank during read")
                    }
                } finally {
                    await file.close()
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
            await this.removeFiles(digest)
        }
    }

    private async ensureRoot(): Promise<void> {
        await this.fs.mkdir(this.rootName, {
            recursive: true,
            baseDir: BaseDirectory.AppData,
        })
    }

    private partialPath(digest: string): string {
        return `${this.rootName}/${digest}.partial`
    }

    private dataPath(digest: string): string {
        return `${this.rootName}/${digest}.data`
    }

    private metadataPath(digest: string): string {
        return `${this.rootName}/${digest}.verified.json`
    }

    private partialMetadataPath(digest: string): string {
        return `${this.rootName}/${digest}.partial.json`
    }

    private metadataTempPath(digest: string): string {
        return `${this.rootName}/${digest}.verified.tmp`
    }

    private async fileSize(path: string): Promise<number | undefined> {
        try {
            return (await this.fs.stat(path, { baseDir: BaseDirectory.AppData })).size
        } catch (error) {
            if (isNotFound(error)) return undefined
            throw error
        }
    }

    private async partialPhysicalPath(
        digest: string,
    ): Promise<string | undefined> {
        const partial = this.partialPath(digest)
        if ((await this.fileSize(partial)) !== undefined) return partial
        const data = this.dataPath(digest)
        if ((await this.fileSize(data)) !== undefined) return data
        return undefined
    }

    private async readMetadata(
        path: string,
        digest: string,
    ): Promise<StoredMetadata | undefined> {
        try {
            const text = await this.fs.readTextFile(path, {
                baseDir: BaseDirectory.AppData,
            })
            if (text.length > 16_384) return undefined
            const value = JSON.parse(text) as Partial<StoredMetadata>
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
        } catch (error) {
            if (isNotFound(error) || error instanceof SyntaxError) return undefined
            throw error
        }
    }

    private async writeMetadata(metadata: StoredMetadata): Promise<void> {
        const value = JSON.stringify(metadata)
        const temporary = this.metadataTempPath(metadata.digest)
        await this.fs.writeTextFile(temporary, value, {
            baseDir: BaseDirectory.AppData,
        })
        await this.fs.rename(temporary, this.metadataPath(metadata.digest), {
            oldPathBaseDir: BaseDirectory.AppData,
            newPathBaseDir: BaseDirectory.AppData,
        })
    }

    private async writePartialMetadata(metadata: StoredMetadata): Promise<void> {
        await this.fs.writeTextFile(
            this.partialMetadataPath(metadata.digest),
            JSON.stringify(metadata),
            { baseDir: BaseDirectory.AppData },
        )
    }

    private async removeFiles(digest: string): Promise<void> {
        for (const path of [
            this.partialPath(digest),
            this.dataPath(digest),
            this.partialMetadataPath(digest),
            this.metadataTempPath(digest),
            this.metadataPath(digest),
        ]) {
            await ignoreNotFound(() =>
                this.fs.remove(path, { baseDir: BaseDirectory.AppData }),
            )
        }
    }
}
