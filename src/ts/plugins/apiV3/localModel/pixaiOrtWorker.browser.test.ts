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
import { getPixaiArtifact, PIXAI_PROFILE_ID } from "./pixaiRegistry"

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

const concat = (...parts: Uint8Array[]) => {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
    let offset = 0
    for (const part of parts) {
        result.set(part, offset)
        offset += part.byteLength
    }
    return result
}

const varint = (value: number) => {
    const bytes: number[] = []
    do {
        const next = value & 0x7f
        value = Math.floor(value / 128)
        bytes.push(next | (value > 0 ? 0x80 : 0))
    } while (value > 0)
    return new Uint8Array(bytes)
}
const field = (number: number, wire: number) => varint(number * 8 + wire)
const message = (number: number, value: Uint8Array) =>
    concat(field(number, 2), varint(value.byteLength), value)
const textField = (number: number, value: string) =>
    message(number, new TextEncoder().encode(value))
const integer = (number: number, value: number) =>
    concat(field(number, 0), varint(value))

const tensorType = (shape: number[]) => {
    const dimensions = shape.map((size) => message(1, integer(1, size)))
    const tensor = concat(integer(1, 1), message(2, concat(...dimensions)))
    return message(1, tensor)
}
const valueInfo = (name: string, shape: number[]) =>
    concat(textField(1, name), message(2, tensorType(shape)))

function pixaiShapeTestModel() {
    const scores = concat(
        integer(1, 1),
        integer(1, 13_461),
        integer(2, 1),
        message(9, new Uint8Array(13_461 * 4)),
    )
    const attribute = concat(
        textField(1, "value"),
        message(5, scores),
        integer(20, 4),
    )
    const node = concat(
        textField(2, "Y"),
        textField(3, "constant_scores"),
        textField(4, "Constant"),
        message(5, attribute),
    )
    const graph = concat(
        message(1, node),
        textField(2, "pixai browser test"),
        message(11, valueInfo("X", [1, 3, 448, 448])),
        message(12, valueInfo("Y", [1, 13_461])),
    )
    const opset = integer(2, 13)
    return concat(
        integer(1, 8),
        textField(2, "risu-test"),
        message(7, graph),
        message(8, opset),
    )
}

const readable = (bytes: Uint8Array): ModelArtifactReadable => ({
    size: bytes.byteLength,
    async *chunks(options) {
        for (let offset = 0; offset < bytes.byteLength; offset += options.chunkSize) {
            yield bytes.slice(offset, offset + options.chunkSize)
        }
    },
})

function fixedSidecars() {
    const preprocessSize = getPixaiArtifact(PIXAI_PROFILE_ID, "preprocess.json").bytes
    const selectedTagsSize = getPixaiArtifact(PIXAI_PROFILE_ID, "selected_tags.csv").bytes
    const preprocessText = JSON.stringify({
        stages: [
            { type: "resize", size: [448, 448], interpolation: "bilinear", antialias: null, max_size: null },
            { type: "to_tensor" },
            { type: "normalize", mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
        ],
    })
    const preprocessBytes = new TextEncoder().encode(
        preprocessText + " ".repeat(preprocessSize - preprocessText.length),
    )

    const rows: string[][] = [["id", "tag_id", "name", "category", "count", "ips"]]
    for (let index = 0; index < 13_461; index += 1) {
        rows.push([
            String(index), String(index), `tag_${index}`,
            index < 9_741 ? "0" : "4", "1", "0",
        ])
    }
    const render = () => rows.map((row) => row.join(",")).join("\n")
    let text = render()
    let missing = selectedTagsSize - text.length
    for (let index = 1; missing > 0 && index < rows.length; index += 1) {
        const room = 500 - rows[index]![2]!.length
        const added = Math.min(room, missing)
        rows[index]![2] += "x".repeat(added)
        missing -= added
    }
    text = render()
    if (text.length !== selectedTagsSize) throw new Error("invalid sidecar fixture size")
    return {
        preprocess: readable(preprocessBytes),
        selectedTags: readable(new TextEncoder().encode(text)),
    }
}

async function encodedImage(mediaType: "image/jpeg" | "image/png" | "image/webp") {
    const canvas = new OffscreenCanvas(3, 2)
    const context = canvas.getContext("2d")!
    context.fillStyle = "rgb(20, 40, 60)"
    context.fillRect(0, 0, 3, 2)
    const blob = await canvas.convertToBlob({ type: mediaType, quality: 0.9 })
    expect(blob.type).toBe(mediaType)
    return new Uint8Array(await blob.arrayBuffer())
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

    it("decodes JPEG, PNG and WebP in the Worker and returns bounded PixAI results", async () => {
        const client = createClient()
        await client.load(readable(pixaiShapeTestModel()))
        const sidecars = fixedSidecars()
        await client.configurePixaiSidecars(sidecars.preprocess, sidecars.selectedTags)

        for (const mediaType of ["image/jpeg", "image/png", "image/webp"] as const) {
            const result = await client.runPixaiImage({
                data: await encodedImage(mediaType),
                mediaType,
            })
            expect(result).toMatchObject({
                provider: "wasm",
                tags: [],
                thresholds: { general: 0.3, character: 0.85 },
                truncated: false,
                warnings: [],
            })
            expect(Object.values(result.timings).every(Number.isFinite)).toBe(true)
            expect(Object.values(result.timings).every((value) => value >= 0)).toBe(true)
        }
    })

    it("rejects media mismatch before ORT and redacts malformed sidecars", async () => {
        const image = await encodedImage("image/png")
        const first = createClient()
        await first.load(readable(pixaiShapeTestModel()))
        const sidecars = fixedSidecars()
        await first.configurePixaiSidecars(sidecars.preprocess, sidecars.selectedTags)
        await expectCode(
            first.runPixaiImage({ data: image, mediaType: "image/jpeg" }),
            "IMAGE_DECODE_FAILED",
            "PixAI image could not be decoded",
        )
        const headerOnly = new Uint8Array(33)
        headerOnly.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
        new DataView(headerOnly.buffer).setUint32(16, 1)
        new DataView(headerOnly.buffer).setUint32(20, 1)
        await expectCode(
            first.runPixaiImage({ data: headerOnly, mediaType: "image/png" }),
            "IMAGE_DECODE_FAILED",
            "PixAI image could not be decoded",
        )
        await expectCode(
            first.runPixaiImage({
                data: new Uint8Array(33_554_433),
                mediaType: "image/png",
            }),
            "INVALID_ARGUMENT",
            "ORT worker request is invalid",
        )

        const second = createClient()
        await second.load(readable(pixaiShapeTestModel()))
        const bad = new Uint8Array(
            getPixaiArtifact(PIXAI_PROFILE_ID, "preprocess.json").bytes,
        )
        await expectCode(
            second.configurePixaiSidecars(readable(bad), sidecars.selectedTags),
            "MODEL_CONFIG_FAILED",
            "PixAI model configuration is invalid",
        )
        await expectCode(
            second.runPixaiImage({ data: image, mediaType: "image/png" }),
            "DISPOSED",
            "ORT worker is disposed",
        )
    })

    it("aborts sidecar acquisition, calls iterator return and closes the Worker", async () => {
        const client = createClient()
        await client.load(readable(pixaiShapeTestModel()))
        const sidecars = fixedSidecars()
        const selectedBytes = new Uint8Array(
            getPixaiArtifact(PIXAI_PROFILE_ID, "selected_tags.csv").bytes,
        )
        let firstChunk!: () => void
        let release!: () => void
        let cleaned = false
        const first = new Promise<void>((resolve) => { firstChunk = resolve })
        const gate = new Promise<void>((resolve) => { release = resolve })
        const selectedTags: ModelArtifactReadable = {
            size: selectedBytes.byteLength,
            async *chunks() {
                try {
                    yield selectedBytes.slice(0, 64 * 1024)
                    firstChunk()
                    await gate
                    yield selectedBytes.slice(64 * 1024)
                } finally {
                    cleaned = true
                }
            },
        }
        const controller = new AbortController()
        const configuring = client.configurePixaiSidecars(
            sidecars.preprocess,
            selectedTags,
            { signal: controller.signal },
        )
        await first
        controller.abort()
        release()
        await expectCode(configuring, "ABORTED", "ORT worker operation was aborted")
        await expect.poll(() => cleaned).toBe(true)
        await expectCode(
            client.configurePixaiSidecars(sidecars.preprocess, sidecars.selectedTags),
            "DISPOSED",
            "ORT worker is disposed",
        )
    })
})
