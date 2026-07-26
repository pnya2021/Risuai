import { afterEach, describe, expect, it } from "vitest"
import { OpfsModelArtifactStore } from "./opfsModelArtifactStore"
import {
    TINY_ARTIFACT,
    tinyArtifactBytes,
} from "./fixtures/tinyArtifact"

let testRoot: string | undefined

afterEach(async () => {
    if (!testRoot) return
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(testRoot, { recursive: true }).catch(() => undefined)
    testRoot = undefined
})

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const result = new Uint8Array(TINY_ARTIFACT.bytes)
    let offset = 0
    for await (const chunk of source) {
        result.set(chunk, offset)
        offset += chunk.byteLength
    }
    return result.slice(0, offset)
}

describe("OPFS model artifact store in Chromium", () => {
    it("reloads, resumes, verifies metadata last, opens, and removes", async () => {
        testRoot = `pixai-artifact-${crypto.randomUUID()}`
        const bytes = tinyArtifactBytes()
        const first = new OpfsModelArtifactStore({ rootName: testRoot })
        const partial = await first.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: bytes.byteLength,
            etag: '"chromium"',
        })
        await partial.write(bytes.slice(0, 47))
        await partial.abort({ keepPartial: true })

        const reloaded = new OpfsModelArtifactStore({ rootName: testRoot })
        expect(await reloaded.stat(TINY_ARTIFACT.sha256)).toEqual({
            state: "partial",
            bytes: 47,
            etag: '"chromium"',
        })
        const resumed = await reloaded.beginWrite(TINY_ARTIFACT.sha256, {
            expectedBytes: bytes.byteLength,
            etag: '"chromium"',
        })
        expect(resumed.offset).toBe(47)
        await resumed.write(bytes.slice(47))
        await resumed.commit(TINY_ARTIFACT.sha256)

        expect(await reloaded.stat(TINY_ARTIFACT.sha256)).toEqual({
            state: "verified",
            bytes: 130,
            etag: '"chromium"',
        })
        const opened = await reloaded.openVerified(TINY_ARTIFACT.sha256)
        expect(await collect(opened.chunks({ chunkSize: 23 }))).toEqual(bytes)

        await reloaded.remove(TINY_ARTIFACT.sha256, {
            partial: true,
            verified: true,
        })
        expect(await reloaded.stat(TINY_ARTIFACT.sha256)).toEqual({
            state: "absent",
            bytes: 0,
        })
    })
})
