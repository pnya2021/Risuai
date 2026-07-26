import { describe, expect, it } from "vitest"
import { OpfsModelArtifactStore } from "./opfsModelArtifactStore"
import {
    TINY_ARTIFACT,
    tinyArtifactBytes,
} from "./fixtures/tinyArtifact"

class MemoryFileHandle {
    constructor(
        readonly name: string,
        private readonly directory: MemoryDirectory,
    ) {}

    async getFile(): Promise<File> {
        const bytes = this.directory.files.get(this.name)
        if (!bytes) throw new DOMException("missing", "NotFoundError")
        return new File([bytes.slice()], this.name)
    }

    async createWritable(options?: {
        keepExistingData?: boolean
    }): Promise<FileSystemWritableFileStream> {
        let value = options?.keepExistingData
            ? (this.directory.files.get(this.name)?.slice() ?? new Uint8Array())
            : new Uint8Array()
        let position = 0
        let closed = false
        const stream = {
            seek: async (next: number) => {
                position = next
            },
            write: async (input: Uint8Array) => {
                const chunk = input.slice()
                const next = new Uint8Array(
                    Math.max(value.byteLength, position + chunk.byteLength),
                )
                next.set(value)
                next.set(chunk, position)
                value = next
                position += chunk.byteLength
            },
            truncate: async (size: number) => {
                value = value.slice(0, size)
            },
            close: async () => {
                if (closed) return
                closed = true
                this.directory.files.set(this.name, value.slice())
                this.directory.events.push(`close:${this.name}`)
            },
            abort: async () => {
                closed = true
                this.directory.events.push(`abort:${this.name}`)
            },
        }
        return stream as unknown as FileSystemWritableFileStream
    }
}

class MemoryDirectory {
    readonly files = new Map<string, Uint8Array>()
    readonly directories = new Map<string, MemoryDirectory>()
    readonly events: string[]

    constructor(events: string[] = []) {
        this.events = events
    }

    async getDirectoryHandle(
        name: string,
        options?: { create?: boolean },
    ): Promise<FileSystemDirectoryHandle> {
        let directory = this.directories.get(name)
        if (!directory && options?.create) {
            directory = new MemoryDirectory(this.events)
            this.directories.set(name, directory)
        }
        if (!directory) throw new DOMException("missing", "NotFoundError")
        return directory as unknown as FileSystemDirectoryHandle
    }

    async getFileHandle(
        name: string,
        options?: { create?: boolean },
    ): Promise<FileSystemFileHandle> {
        if (!this.files.has(name) && !options?.create) {
            throw new DOMException("missing", "NotFoundError")
        }
        if (!this.files.has(name)) this.files.set(name, new Uint8Array())
        return new MemoryFileHandle(
            name,
            this,
        ) as unknown as FileSystemFileHandle
    }

    async removeEntry(name: string): Promise<void> {
        if (!this.files.delete(name) && !this.directories.delete(name)) {
            throw new DOMException("missing", "NotFoundError")
        }
    }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of source) {
        chunks.push(chunk)
        size += chunk.byteLength
    }
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
    }
    return result
}

function createStore(root: MemoryDirectory): OpfsModelArtifactStore {
    return new OpfsModelArtifactStore({
        getRoot: async () => root as unknown as FileSystemDirectoryHandle,
        rootName: "artifact-test",
        estimateStorage: async () => ({ usage: 100, quota: 1_000 }),
    })
}

describe("OPFS model artifact store", () => {
    it("copies chunks and resumes a partial after a store reload", async () => {
        const root = new MemoryDirectory()
        const bytes = tinyArtifactBytes()
        const firstChunk = bytes.slice(0, 61)
        const first = await createStore(root).beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: bytes.byteLength,
            etag: '"tiny"',
        })
        await first.write(firstChunk)
        firstChunk.fill(0)
        await first.abort({ keepPartial: true })

        expect(await createStore(root).stat(TINY_ARTIFACT.sha256)).toEqual({
            state: "partial",
            bytes: 61,
            etag: '"tiny"',
        })
        expect(
            await collect(
                createStore(root).readPartial(TINY_ARTIFACT.sha256, {
                    chunkSize: 17,
                }),
            ),
        ).toEqual(bytes.slice(0, 61))

        const resumed = await createStore(root).beginWrite(
            TINY_ARTIFACT.sha256,
            { expectedBytes: bytes.byteLength, etag: '"tiny"' },
        )
        expect(resumed.offset).toBe(61)
        await resumed.write(bytes.slice(61))
        await resumed.commit(TINY_ARTIFACT.sha256)

        expect(await createStore(root).stat(TINY_ARTIFACT.sha256)).toEqual({
            state: "verified",
            bytes: 130,
            etag: '"tiny"',
        })
        const opened = await createStore(root).openVerified(
            TINY_ARTIFACT.sha256,
        )
        const returned = await collect(opened.chunks({ chunkSize: 19 }))
        returned.fill(0)
        expect(await collect(opened.chunks({ chunkSize: 31 }))).toEqual(bytes)
    })

    it("publishes verified metadata last and exposes known quota", async () => {
        const root = new MemoryDirectory()
        const writer = await createStore(root).beginWrite(
            TINY_ARTIFACT.sha256,
            { expectedBytes: 130 },
        )
        await writer.write(tinyArtifactBytes())
        await writer.commit(TINY_ARTIFACT.sha256)

        const closes = root.events.filter((event) => event.startsWith("close:"))
        expect(closes.at(-2)).toContain(".data")
        expect(closes.at(-1)).toContain(".verified.json")
        expect(await createStore(root).estimate()).toEqual({
            usageBytes: 100,
            quotaBytes: 1_000,
            persistent: true,
        })
    })

    it("keeps aborted data unverified and removes only requested state", async () => {
        const root = new MemoryDirectory()
        const store = createStore(root)
        const writer = await store.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: 130,
        })
        await writer.write(tinyArtifactBytes().slice(0, 40))
        await expect(store.openVerified(TINY_ARTIFACT.sha256)).rejects.toThrow(
            /not verified/i,
        )
        await writer.abort({ keepPartial: false })
        expect(await store.stat(TINY_ARTIFACT.sha256)).toEqual({
            state: "absent",
            bytes: 0,
        })

        const committed = await store.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: 130,
        })
        await committed.write(tinyArtifactBytes())
        await committed.commit(TINY_ARTIFACT.sha256)
        await store.remove(TINY_ARTIFACT.sha256, {
            partial: true,
            verified: false,
        })
        expect((await store.stat(TINY_ARTIFACT.sha256)).state).toBe("verified")
        await store.remove(TINY_ARTIFACT.sha256, {
            partial: false,
            verified: true,
        })
        expect((await store.stat(TINY_ARTIFACT.sha256)).state).toBe("absent")
    })

    it("fails closed when verified metadata and physical data disagree", async () => {
        const root = new MemoryDirectory()
        const store = createStore(root)
        const writer = await store.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: 130,
        })
        await writer.write(tinyArtifactBytes())
        await writer.commit(TINY_ARTIFACT.sha256)

        const directory = root.directories.get("artifact-test")!
        directory.files.set(
            `${TINY_ARTIFACT.sha256}.data`,
            tinyArtifactBytes().slice(0, 129),
        )
        expect(await createStore(root).stat(TINY_ARTIFACT.sha256)).toMatchObject({
            state: "partial",
            bytes: 129,
        })
        await expect(
            createStore(root).openVerified(TINY_ARTIFACT.sha256),
        ).rejects.toThrow(/not verified/i)
    })

    it("enforces the 1 MiB chunk boundary on partial and verified reads", async () => {
        const root = new MemoryDirectory()
        const store = createStore(root)
        const bytes = tinyArtifactBytes()
        const partial = await store.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: bytes.byteLength,
        })
        await partial.write(bytes.slice(0, 41))
        await partial.abort({ keepPartial: true })

        await expect(
            collect(
                store.readPartial(TINY_ARTIFACT.sha256, {
                    chunkSize: 1_048_577,
                }),
            ),
        ).rejects.toThrow(/chunk size/i)

        const resumed = await store.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: bytes.byteLength,
        })
        await resumed.write(bytes.slice(resumed.offset))
        await resumed.commit(TINY_ARTIFACT.sha256)
        const opened = await store.openVerified(TINY_ARTIFACT.sha256)
        expect(await collect(opened.chunks({ chunkSize: 1_048_576 }))).toEqual(
            bytes,
        )
        await expect(
            collect(opened.chunks({ chunkSize: 1_048_577 })),
        ).rejects.toThrow(/chunk size/i)
    })
})
