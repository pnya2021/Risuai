import { BaseDirectory, SeekMode } from "@tauri-apps/plugin-fs"
import { describe, expect, it } from "vitest"
import {
    TauriModelArtifactStore,
    type TauriArtifactFile,
    type TauriFsBindings,
} from "./tauriModelArtifactStore"
import {
    TINY_ARTIFACT,
    tinyArtifactBytes,
} from "./fixtures/tinyArtifact"

class MemoryTauriFs implements TauriFsBindings {
    readonly files = new Map<string, Uint8Array>()
    readonly calls: Array<{ operation: string; paths: string[]; options: unknown }> = []
    maxReadBuffer = 0
    openHandles = 0
    failRenameFrom: string | undefined
    failWrites = false

    async mkdir(path: string, options: unknown): Promise<void> {
        this.calls.push({ operation: "mkdir", paths: [path], options })
    }

    async stat(path: string, options: unknown): Promise<{ size: number }> {
        this.calls.push({ operation: "stat", paths: [path], options })
        const bytes = this.files.get(path)
        if (!bytes) throw new Error("not found")
        return { size: bytes.byteLength }
    }

    async open(
        path: string,
        options: {
            read?: boolean
            write?: boolean
            create?: boolean
            truncate?: boolean
            baseDir?: BaseDirectory
        },
    ): Promise<TauriArtifactFile> {
        this.calls.push({ operation: "open", paths: [path], options })
        if (!this.files.has(path) && !options.create) throw new Error("not found")
        if (!this.files.has(path) || options.truncate) {
            this.files.set(path, new Uint8Array())
        }
        this.openHandles += 1
        let position = 0
        let closed = false
        return {
            read: async (target) => {
                this.maxReadBuffer = Math.max(
                    this.maxReadBuffer,
                    target.byteLength,
                )
                const source = this.files.get(path) ?? new Uint8Array()
                if (position >= source.byteLength) return null
                const size = Math.min(target.byteLength, source.byteLength - position)
                target.set(source.subarray(position, position + size))
                position += size
                return size
            },
            write: async (input) => {
                if (this.failWrites) throw new Error("write failed")
                const chunk = input.slice()
                const source = this.files.get(path) ?? new Uint8Array()
                const next = new Uint8Array(
                    Math.max(source.byteLength, position + chunk.byteLength),
                )
                next.set(source)
                next.set(chunk, position)
                this.files.set(path, next)
                position += chunk.byteLength
                return chunk.byteLength
            },
            seek: async (offset, mode) => {
                expect(mode).toBe(SeekMode.Start)
                position = offset
                return position
            },
            close: async () => {
                if (closed) return
                closed = true
                this.openHandles -= 1
                this.calls.push({ operation: "close", paths: [path], options: {} })
            },
        }
    }

    async readTextFile(path: string, options: unknown): Promise<string> {
        this.calls.push({ operation: "readTextFile", paths: [path], options })
        const bytes = this.files.get(path)
        if (!bytes) throw new Error("not found")
        return new TextDecoder().decode(bytes)
    }

    async writeTextFile(
        path: string,
        value: string,
        options: unknown,
    ): Promise<void> {
        this.calls.push({ operation: "writeTextFile", paths: [path], options })
        if (this.failWrites) throw new Error("write failed")
        this.files.set(path, new TextEncoder().encode(value))
    }

    async rename(
        from: string,
        to: string,
        options: unknown,
    ): Promise<void> {
        this.calls.push({ operation: "rename", paths: [from, to], options })
        if (from === this.failRenameFrom) throw new Error("rename failed")
        const value = this.files.get(from)
        if (!value) throw new Error("not found")
        this.files.set(to, value)
        this.files.delete(from)
    }

    async remove(path: string, options: unknown): Promise<void> {
        this.calls.push({ operation: "remove", paths: [path], options })
        if (!this.files.delete(path)) throw new Error("not found")
    }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: number[] = []
    for await (const chunk of source) chunks.push(...chunk)
    return new Uint8Array(chunks)
}

describe("Tauri model artifact store", () => {
    it("uses AppData-contained digest paths and resumes with seek", async () => {
        const fs = new MemoryTauriFs()
        const bytes = tinyArtifactBytes()
        const firstStore = new TauriModelArtifactStore({ fs })
        const first = await firstStore.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: 130,
            etag: '"tiny"',
        })
        const mutable = bytes.slice(0, 53)
        await first.write(mutable)
        mutable.fill(0)
        await first.abort({ keepPartial: true })

        const reloaded = new TauriModelArtifactStore({ fs })
        const resumed = await reloaded.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: 130,
            etag: '"tiny"',
        })
        expect(resumed.offset).toBe(53)
        await resumed.write(bytes.slice(53))
        await resumed.commit(TINY_ARTIFACT.sha256)

        expect(await reloaded.stat(TINY_ARTIFACT.sha256)).toEqual({
            state: "verified",
            bytes: 130,
            etag: '"tiny"',
        })
        const opened = await reloaded.openVerified(TINY_ARTIFACT.sha256)
        expect(await collect(opened.chunks({ chunkSize: 11 }))).toEqual(bytes)
        expect(fs.maxReadBuffer).toBeLessThanOrEqual(11)
        expect(fs.openHandles).toBe(0)

        const pathCalls = fs.calls.filter((call) => call.paths.length > 0)
        for (const call of pathCalls) {
            for (const path of call.paths) {
                expect(path).not.toContain("..")
                expect(path.startsWith("plugin-local-model-v1/") || path === "plugin-local-model-v1").toBe(true)
            }
            const options = call.options as {
                baseDir?: BaseDirectory
                oldPathBaseDir?: BaseDirectory
                newPathBaseDir?: BaseDirectory
            }
            if ("baseDir" in options) expect(options.baseDir).toBe(BaseDirectory.AppData)
            if ("oldPathBaseDir" in options) {
                expect(options.oldPathBaseDir).toBe(BaseDirectory.AppData)
                expect(options.newPathBaseDir).toBe(BaseDirectory.AppData)
            }
        }
        await expect(reloaded.stat("../escape")).rejects.toThrow(/digest/i)
    })

    it("promotes data then metadata with same-directory renames", async () => {
        const fs = new MemoryTauriFs()
        const store = new TauriModelArtifactStore({ fs })
        const writer = await store.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: 130,
        })
        await writer.write(tinyArtifactBytes())
        const beforeCommit = fs.calls.length
        await writer.commit(TINY_ARTIFACT.sha256)

        const promotions = fs.calls
            .slice(beforeCommit)
            .filter((call) =>
                ["rename", "writeTextFile"].includes(call.operation),
            )
        expect(promotions.map((call) => call.operation)).toEqual([
            "rename",
            "writeTextFile",
            "rename",
        ])
        expect(promotions[0].paths).toEqual([
            `plugin-local-model-v1/${TINY_ARTIFACT.sha256}.partial`,
            `plugin-local-model-v1/${TINY_ARTIFACT.sha256}.data`,
        ])
        expect(promotions[2].paths).toEqual([
            `plugin-local-model-v1/${TINY_ARTIFACT.sha256}.verified.tmp`,
            `plugin-local-model-v1/${TINY_ARTIFACT.sha256}.verified.json`,
        ])
        expect(await store.estimate()).toEqual({ persistent: true })
    })

    it("does not publish metadata after failed writes or promotion", async () => {
        const fs = new MemoryTauriFs()
        const store = new TauriModelArtifactStore({ fs })
        const writer = await store.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: 130,
        })
        fs.failWrites = true
        await expect(writer.write(tinyArtifactBytes())).rejects.toThrow(
            /write failed/i,
        )
        expect(fs.openHandles).toBe(0)
        expect(
            fs.files.has(
                `plugin-local-model-v1/${TINY_ARTIFACT.sha256}.verified.json`,
            ),
        ).toBe(false)

        fs.failWrites = false
        const retry = await store.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: 130,
            restart: true,
        })
        await retry.write(tinyArtifactBytes())
        fs.failRenameFrom = `plugin-local-model-v1/${TINY_ARTIFACT.sha256}.partial`
        await expect(retry.commit(TINY_ARTIFACT.sha256)).rejects.toThrow(
            /rename failed/i,
        )
        expect(
            fs.files.has(
                `plugin-local-model-v1/${TINY_ARTIFACT.sha256}.verified.json`,
            ),
        ).toBe(false)
        expect((await store.stat(TINY_ARTIFACT.sha256)).state).toBe("partial")
    })

    it("removes verified bytes only when explicitly requested", async () => {
        const fs = new MemoryTauriFs()
        const store = new TauriModelArtifactStore({ fs })
        const writer = await store.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: 130,
        })
        await writer.write(tinyArtifactBytes())
        await writer.commit(TINY_ARTIFACT.sha256)

        await store.remove(TINY_ARTIFACT.sha256, {
            partial: true,
            verified: false,
        })
        expect((await store.stat(TINY_ARTIFACT.sha256)).state).toBe("verified")
        await store.remove(TINY_ARTIFACT.sha256, {
            partial: false,
            verified: true,
        })
        expect(await store.stat(TINY_ARTIFACT.sha256)).toEqual({
            state: "absent",
            bytes: 0,
        })
    })
})
