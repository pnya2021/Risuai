import { afterEach, describe, expect, it } from "vitest"
import { OpfsModelArtifactStore } from "./opfsModelArtifactStore"
import type { ModelArtifactReadable } from "./modelArtifactStore"
import {
    TINY_ARTIFACT,
    tinyArtifactBytes,
} from "./fixtures/tinyArtifact"
import {
    PixaiOrtWorkerClient,
    type PixaiOrtWorkerError,
} from "./pixaiOrtWorkerClient"

let testRoot: string | undefined
const clients = new Set<PixaiOrtWorkerClient>()

afterEach(async () => {
    await Promise.all([...clients].map((client) => client.dispose()))
    clients.clear()
    if (!testRoot) return
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(testRoot, { recursive: true }).catch(() => undefined)
    testRoot = undefined
})

const createClient = () => {
    const client = new PixaiOrtWorkerClient()
    clients.add(client)
    return client
}

async function verifiedTinyModel(): Promise<ModelArtifactReadable> {
    testRoot = `pixai-ort-worker-${crypto.randomUUID()}`
    const store = new OpfsModelArtifactStore({ rootName: testRoot })
    const bytes = tinyArtifactBytes()
    const writer = await store.beginWrite(TINY_ARTIFACT.sha256, {
        expectedBytes: bytes.byteLength,
        etag: '"ort-worker"',
    })
    await writer.write(bytes)
    await writer.commit(TINY_ARTIFACT.sha256)
    return store.openVerified(TINY_ARTIFACT.sha256)
}

const expectCode = async (
    promise: Promise<unknown>,
    code: PixaiOrtWorkerError["code"],
    message: string,
) => {
    await expect(promise).rejects.toMatchObject({
        name: "PixaiOrtWorkerError",
        code,
        message,
    })
}

describe("PixAI ORT Host Worker in Chromium", () => {
    it("loads a verified OPFS model and executes it through real ORT WASM", async () => {
        const readable = await verifiedTinyModel()
        let requestedChunkSize = 0
        const observed: ModelArtifactReadable = {
            size: readable.size,
            chunks(options) {
                requestedChunkSize = options.chunkSize
                return readable.chunks(options)
            },
        }
        const client = createClient()

        await expect(client.load(observed)).resolves.toEqual({
            provider: "wasm",
            inputName: "X",
            outputName: "Y",
        })
        expect(requestedChunkSize).toBe(1_048_576)

        const output = await client.run({
            data: new Float32Array([2, 3, 4, 5, 6, 7]),
            dimensions: [3, 2],
        })
        expect(output.dimensions).toEqual([3, 2])
        expect(Array.from(output.data)).toEqual([2, 6, 12, 20, 30, 42])

        await client.dispose()
        await client.dispose()
        await expectCode(
            client.run({ data: new Float32Array([1]), dimensions: [1] }),
            "DISPOSED",
            "ORT worker is disposed",
        )
    })

    it("aborts a bounded model stream without accepting a late load", async () => {
        const bytes = tinyArtifactBytes()
        const controller = new AbortController()
        let releaseRead!: () => void
        let firstChunk!: () => void
        const firstChunkSent = new Promise<void>((resolve) => { firstChunk = resolve })
        const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
        const readable: ModelArtifactReadable = {
            size: bytes.byteLength,
            async *chunks() {
                yield bytes.slice(0, 17)
                firstChunk()
                await readGate
                yield bytes.slice(17)
            },
        }
        const client = createClient()
        const loading = client.load(readable, { signal: controller.signal })
        await firstChunkSent
        controller.abort()
        releaseRead()

        await expectCode(loading, "ABORTED", "ORT worker operation was aborted")
        await expectCode(
            client.load(readable),
            "DISPOSED",
            "ORT worker is disposed",
        )
    })

    it("redacts an actual ORT model-load failure", async () => {
        const invalidBytes = new Uint8Array([1, 2, 3, 4])
        const readable: ModelArtifactReadable = {
            size: invalidBytes.byteLength,
            async *chunks() {
                yield invalidBytes
            },
        }
        const client = createClient()

        await expectCode(
            client.load(readable),
            "MODEL_LOAD_FAILED",
            "ORT model could not be loaded",
        )
    })
})
