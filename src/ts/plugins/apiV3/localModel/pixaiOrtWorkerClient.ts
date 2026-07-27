import type { ModelArtifactReadable } from "./modelArtifactStore"
import { MODEL_ARTIFACT_MAX_CHUNK_BYTES } from "./modelArtifactStore"
import { getPixaiArtifact, PIXAI_PROFILE_ID } from "./pixaiRegistry"
import {
    normalizePixaiRunOptions,
    PIXAI_MAX_IMAGE_BYTES,
    PIXAI_MAX_RESULTS,
    PIXAI_RESULT_METADATA,
    type PixaiMediaType,
    type PixaiRunOptions,
    type PixaiTagCategory,
    type PixaiTagResult,
} from "./pixaiInferenceCore"

export type PixaiOrtWorkerErrorCode =
    | "ABORTED"
    | "INVALID_ARGUMENT"
    | "RESOURCE_LIMIT"
    | "MODEL_LOAD_FAILED"
    | "MODEL_CONFIG_FAILED"
    | "IMAGE_DECODE_FAILED"
    | "INFERENCE_FAILED"
    | "RUNTIME_UNAVAILABLE"
    | "DISPOSED"

const ERROR_MESSAGES: Record<PixaiOrtWorkerErrorCode, string> = {
    ABORTED: "ORT worker operation was aborted",
    INVALID_ARGUMENT: "ORT worker request is invalid",
    RESOURCE_LIMIT: "ORT worker resource limit was exceeded",
    MODEL_LOAD_FAILED: "ORT model could not be loaded",
    MODEL_CONFIG_FAILED: "PixAI model configuration is invalid",
    IMAGE_DECODE_FAILED: "PixAI image could not be decoded",
    INFERENCE_FAILED: "ORT inference failed",
    RUNTIME_UNAVAILABLE: "ORT worker runtime is unavailable",
    DISPOSED: "ORT worker is disposed",
}

export class PixaiOrtWorkerError extends Error {
    readonly code: PixaiOrtWorkerErrorCode

    constructor(code: PixaiOrtWorkerErrorCode) {
        super(ERROR_MESSAGES[code])
        this.name = "PixaiOrtWorkerError"
        this.code = code
    }
}

export interface PixaiOrtRunInput {
    data: Float32Array
    dimensions: readonly number[]
}

export interface PixaiOrtRunOutput {
    data: Float32Array
    dimensions: number[]
}

export interface PixaiImageRunInput {
    readonly data: Uint8Array
    readonly mediaType: PixaiMediaType
    readonly options?: PixaiRunOptions
}

export interface PixaiImageRunOutput {
    readonly modelProfileId: string
    readonly modelRevision: string
    readonly modelSha256: string
    readonly preprocessVersion: string
    readonly provider: "wasm"
    readonly tags: readonly Readonly<PixaiTagResult>[]
    readonly thresholds: Readonly<Record<PixaiTagCategory, number>>
    readonly truncated: boolean
    readonly timings: Readonly<{
        decodeMs: number
        preprocessMs: number
        inferenceMs: number
        postprocessMs: number
        totalMs: number
    }>
    readonly warnings: readonly []
}

interface PendingRequest {
    id: number
    expected:
        | "ack"
        | "loaded"
        | "result"
        | "pixaiConfigured"
        | "pixaiResult"
        | "disposed"
    resolve(value: unknown): void
    reject(error: PixaiOrtWorkerError): void
    cleanup(): void
}

const MAX_MODEL_BYTES = getPixaiArtifact(
    PIXAI_PROFILE_ID,
    "model.onnx",
).bytes
const MAX_INPUT_ELEMENTS = 448 * 448 * 3
const MAX_OUTPUT_ELEMENTS = 13_461
const SIDECAR_CHUNK_BYTES = 64 * 1024
const PREPROCESS_BYTES = getPixaiArtifact(
    PIXAI_PROFILE_ID,
    "preprocess.json",
).bytes
const SELECTED_TAGS_BYTES = getPixaiArtifact(
    PIXAI_PROFILE_ID,
    "selected_tags.csv",
).bytes

const plainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object") return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const exactRecord = (
    value: unknown,
    keys: readonly string[],
): value is Record<string, unknown> => {
    if (!plainRecord(value)) return false
    const ownKeys = Reflect.ownKeys(value)
    if (
        ownKeys.length !== keys.length ||
        ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
        return false
    }
    return keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return Boolean(
            descriptor?.enumerable && Object.hasOwn(descriptor, "value"),
        )
    })
}

const validName = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 128

const normalizeDimensions = (
    value: unknown,
    maxElements: number,
): { values: number[]; elements: number } | undefined => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        return undefined
    }
    const keys = Reflect.ownKeys(value)
    if (
        keys.length !== value.length + 1 ||
        !keys.includes("length") ||
        value.some(
            (entry) => !Number.isSafeInteger(entry) || (entry as number) <= 0,
        )
    ) {
        return undefined
    }
    let elements = 1
    for (const entry of value) {
        elements *= entry
        if (!Number.isSafeInteger(elements) || elements > maxElements) {
            return undefined
        }
    }
    return { values: [...value], elements }
}

const knownWorkerError = (
    code: unknown,
    message: unknown,
): PixaiOrtWorkerError | undefined => {
    if (
        typeof code !== "string" ||
        code === "ABORTED" ||
        !(code in ERROR_MESSAGES) ||
        message !== ERROR_MESSAGES[code as PixaiOrtWorkerErrorCode]
    ) {
        return undefined
    }
    return new PixaiOrtWorkerError(code as PixaiOrtWorkerErrorCode)
}

const finiteTiming = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60_000

const decodePixaiResult = (value: Record<string, unknown>): PixaiImageRunOutput | undefined => {
    if (
        !exactRecord(value, [
            "id", "kind", "modelProfileId", "modelRevision", "modelSha256",
            "preprocessVersion", "provider", "tags", "thresholds", "truncated",
            "timings", "warnings",
        ]) ||
        value.kind !== "pixaiResult" ||
        value.modelProfileId !== PIXAI_RESULT_METADATA.modelProfileId ||
        value.modelRevision !== PIXAI_RESULT_METADATA.modelRevision ||
        value.modelSha256 !== PIXAI_RESULT_METADATA.modelSha256 ||
        value.preprocessVersion !== PIXAI_RESULT_METADATA.preprocessVersion ||
        value.provider !== "wasm" ||
        typeof value.truncated !== "boolean" ||
        !Array.isArray(value.tags) ||
        Object.getPrototypeOf(value.tags) !== Array.prototype ||
        value.tags.length > PIXAI_MAX_RESULTS ||
        !plainRecord(value.thresholds) ||
        !exactRecord(value.thresholds, ["general", "character"]) ||
        typeof value.thresholds.general !== "number" ||
        !Number.isFinite(value.thresholds.general) ||
        value.thresholds.general < 0 ||
        value.thresholds.general > 1 ||
        typeof value.thresholds.character !== "number" ||
        !Number.isFinite(value.thresholds.character) ||
        value.thresholds.character < 0 ||
        value.thresholds.character > 1 ||
        !plainRecord(value.timings) ||
        !exactRecord(value.timings, [
            "decodeMs", "preprocessMs", "inferenceMs", "postprocessMs", "totalMs",
        ]) ||
        !finiteTiming(value.timings.decodeMs) ||
        !finiteTiming(value.timings.preprocessMs) ||
        !finiteTiming(value.timings.inferenceMs) ||
        !finiteTiming(value.timings.postprocessMs) ||
        !finiteTiming(value.timings.totalMs) ||
        !Array.isArray(value.warnings) ||
        value.warnings.length !== 0
    ) {
        return undefined
    }
    const tags: Readonly<PixaiTagResult>[] = []
    for (const candidate of value.tags) {
        if (
            !plainRecord(candidate) ||
            !exactRecord(candidate, ["index", "name", "score", "category"]) ||
            !Number.isSafeInteger(candidate.index) ||
            (candidate.index as number) < 0 ||
            (candidate.index as number) >= 13_461 ||
            typeof candidate.name !== "string" ||
            candidate.name.length < 1 ||
            new TextEncoder().encode(candidate.name).byteLength > 512 ||
            typeof candidate.score !== "number" ||
            !Number.isFinite(candidate.score) ||
            (candidate.category !== "general" && candidate.category !== "character")
        ) {
            return undefined
        }
        tags.push(Object.freeze({
            index: candidate.index as number,
            name: candidate.name,
            score: candidate.score,
            category: candidate.category,
        }))
    }
    return Object.freeze({
        ...PIXAI_RESULT_METADATA,
        tags: Object.freeze(tags),
        thresholds: Object.freeze({
            general: value.thresholds.general,
            character: value.thresholds.character,
        }),
        truncated: value.truncated,
        timings: Object.freeze({
            decodeMs: value.timings.decodeMs,
            preprocessMs: value.timings.preprocessMs,
            inferenceMs: value.timings.inferenceMs,
            postprocessMs: value.timings.postprocessMs,
            totalMs: value.timings.totalMs,
        }),
        warnings: Object.freeze([]) as readonly [],
    })
}

export class PixaiOrtWorkerClient {
    private worker: Worker | undefined
    private pending: PendingRequest | undefined
    private nextId = 1
    private busy = false
    private loaded = false
    private pixaiConfigured = false
    private closed = false

    constructor() {
        const worker = new Worker(new URL("./pixaiOrtWorker.ts", import.meta.url), {
            type: "module",
        })
        this.worker = worker
        worker.onmessage = (event) => this.receive(event.data)
        worker.onmessageerror = () =>
            this.shutdown(new PixaiOrtWorkerError("RUNTIME_UNAVAILABLE"))
        worker.onerror = (event) => {
            event.preventDefault()
            this.shutdown(new PixaiOrtWorkerError("RUNTIME_UNAVAILABLE"))
        }
    }

    private ensureOpen() {
        if (this.closed || !this.worker) {
            throw new PixaiOrtWorkerError("DISPOSED")
        }
    }

    private shutdown(error?: PixaiOrtWorkerError) {
        if (this.closed) return
        this.closed = true
        this.loaded = false
        this.pixaiConfigured = false
        const worker = this.worker
        this.worker = undefined
        if (this.pending) {
            const pending = this.pending
            this.pending = undefined
            pending.cleanup()
            pending.reject(error ?? new PixaiOrtWorkerError("DISPOSED"))
        }
        worker?.terminate()
    }

    private protocolFailure() {
        this.shutdown(new PixaiOrtWorkerError("RUNTIME_UNAVAILABLE"))
    }

    private receive(value: unknown) {
        const pending = this.pending
        if (!pending || !plainRecord(value) || value.id !== pending.id) {
            this.protocolFailure()
            return
        }

        if (value.kind === "error") {
            if (!exactRecord(value, ["id", "kind", "code", "message"])) {
                this.protocolFailure()
                return
            }
            const error = knownWorkerError(value.code, value.message)
            if (!error) {
                this.protocolFailure()
                return
            }
            this.pending = undefined
            pending.cleanup()
            pending.reject(error)
            return
        }

        if (
            pending.expected === "ack" &&
            exactRecord(value, ["id", "kind"]) &&
            value.kind === "ack"
        ) {
            this.pending = undefined
            pending.cleanup()
            pending.resolve(undefined)
            return
        }

        if (
            pending.expected === "loaded" &&
            exactRecord(value, [
                "id",
                "kind",
                "provider",
                "inputName",
                "outputName",
            ]) &&
            value.kind === "loaded" &&
            value.provider === "wasm" &&
            validName(value.inputName) &&
            validName(value.outputName)
        ) {
            this.pending = undefined
            pending.cleanup()
            pending.resolve({
                provider: "wasm" as const,
                inputName: value.inputName,
                outputName: value.outputName,
            })
            return
        }

        if (
            pending.expected === "result" &&
            exactRecord(value, ["id", "kind", "data", "dimensions"]) &&
            value.kind === "result" &&
            value.data instanceof ArrayBuffer
        ) {
            const outputDimensions = normalizeDimensions(
                value.dimensions,
                MAX_OUTPUT_ELEMENTS,
            )
            const output = new Float32Array(value.data)
            if (
                !outputDimensions ||
                output.length !== outputDimensions.elements ||
                [...output].some((entry) => !Number.isFinite(entry))
            ) {
                this.protocolFailure()
                return
            }
            this.pending = undefined
            pending.cleanup()
            pending.resolve({
                data: output.slice(),
                dimensions: outputDimensions.values,
            })
            return
        }

        if (
            pending.expected === "pixaiConfigured" &&
            exactRecord(value, ["id", "kind"]) &&
            value.kind === "pixaiConfigured"
        ) {
            this.pending = undefined
            pending.cleanup()
            pending.resolve(undefined)
            return
        }

        if (pending.expected === "pixaiResult") {
            const result = decodePixaiResult(value)
            if (!result) {
                this.protocolFailure()
                return
            }
            this.pending = undefined
            pending.cleanup()
            pending.resolve(result)
            return
        }

        if (
            pending.expected === "disposed" &&
            exactRecord(value, ["id", "kind"]) &&
            value.kind === "disposed"
        ) {
            this.pending = undefined
            pending.cleanup()
            pending.resolve(undefined)
            return
        }

        this.protocolFailure()
    }

    private request(
        kind:
            | "begin"
            | "chunk"
            | "load"
            | "run"
            | "configurePixai"
            | "runPixai"
            | "dispose",
        fields: Record<string, unknown>,
        expected: PendingRequest["expected"],
        transfer: Transferable[] = [],
        signal?: AbortSignal,
    ): Promise<unknown> {
        this.ensureOpen()
        if (this.pending) throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
        if (signal?.aborted) {
            const error = new PixaiOrtWorkerError("ABORTED")
            this.shutdown(error)
            return Promise.reject(error)
        }
        const id = this.nextId++
        return new Promise((resolve, reject) => {
            const abort = () => {
                const error = new PixaiOrtWorkerError("ABORTED")
                this.shutdown(error)
            }
            const cleanup = () => signal?.removeEventListener("abort", abort)
            this.pending = { id, expected, resolve, reject, cleanup }
            signal?.addEventListener("abort", abort, { once: true })
            try {
                this.worker!.postMessage({ id, kind, ...fields }, transfer)
            } catch {
                this.shutdown(
                    new PixaiOrtWorkerError("RUNTIME_UNAVAILABLE"),
                )
            }
        })
    }

    private waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
        if (!signal) return promise
        if (signal.aborted) {
            const error = new PixaiOrtWorkerError("ABORTED")
            this.shutdown(error)
            return Promise.reject(error)
        }
        return new Promise((resolve, reject) => {
            const abort = () => {
                const error = new PixaiOrtWorkerError("ABORTED")
                this.shutdown(error)
                reject(error)
            }
            signal.addEventListener("abort", abort, { once: true })
            promise.then(
                (value) => {
                    signal.removeEventListener("abort", abort)
                    resolve(value)
                },
                (error) => {
                    signal.removeEventListener("abort", abort)
                    reject(error)
                },
            )
        })
    }

    private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        this.ensureOpen()
        if (this.busy) throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
        this.busy = true
        try {
            return await operation()
        } finally {
            this.busy = false
        }
    }

    async load(
        readable: ModelArtifactReadable,
        options: { signal?: AbortSignal } = {},
    ): Promise<{
        provider: "wasm"
        inputName: string
        outputName: string
    }> {
        return this.exclusive(async () => {
            try {
                if (
                    this.loaded ||
                    !readable ||
                    typeof readable.chunks !== "function" ||
                    !Number.isSafeInteger(readable.size) ||
                    readable.size <= 0
                ) {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                if (readable.size > MAX_MODEL_BYTES) {
                    throw new PixaiOrtWorkerError("RESOURCE_LIMIT")
                }
                await this.request(
                    "begin",
                    { size: readable.size },
                    "ack",
                    [],
                    options.signal,
                )
                const iterator = readable
                    .chunks({ chunkSize: MODEL_ARTIFACT_MAX_CHUNK_BYTES })
                    [Symbol.asyncIterator]()
                let received = 0
                while (true) {
                    const next = await this.waitFor(iterator.next(), options.signal)
                    if (next.done) break
                    const chunk = next.value
                    if (
                        !(chunk instanceof Uint8Array) ||
                        Object.getPrototypeOf(chunk) !== Uint8Array.prototype ||
                        chunk.byteLength < 1
                    ) {
                        throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                    }
                    if (
                        chunk.byteLength > MODEL_ARTIFACT_MAX_CHUNK_BYTES ||
                        received + chunk.byteLength > readable.size
                    ) {
                        throw new PixaiOrtWorkerError("RESOURCE_LIMIT")
                    }
                    received += chunk.byteLength
                    const copy = Uint8Array.from(chunk)
                    await this.request(
                        "chunk",
                        { data: copy.buffer },
                        "ack",
                        [copy.buffer],
                        options.signal,
                    )
                }
                if (received !== readable.size) {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                const result = (await this.request(
                    "load",
                    {},
                    "loaded",
                    [],
                    options.signal,
                )) as {
                    provider: "wasm"
                    inputName: string
                    outputName: string
                }
                this.loaded = true
                return result
            } catch (error) {
                const stable =
                    error instanceof PixaiOrtWorkerError
                        ? error
                        : new PixaiOrtWorkerError("MODEL_LOAD_FAILED")
                this.shutdown(stable)
                throw stable
            }
        })
    }

    private async readSidecar(
        readable: ModelArtifactReadable,
        expectedBytes: number,
        signal?: AbortSignal,
    ): Promise<Uint8Array> {
        if (
            !readable ||
            typeof readable.chunks !== "function" ||
            readable.size !== expectedBytes
        ) {
            throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
        }
        const iterator = readable.chunks({ chunkSize: SIDECAR_CHUNK_BYTES })[Symbol.asyncIterator]()
        const output = new Uint8Array(expectedBytes)
        let offset = 0
        let completed = false
        try {
            while (true) {
                const next = await this.waitFor(iterator.next(), signal)
                if (next.done) {
                    completed = true
                    break
                }
                const chunk = next.value
                if (
                    !(chunk instanceof Uint8Array) ||
                    Object.getPrototypeOf(chunk) !== Uint8Array.prototype ||
                    chunk.byteLength < 1
                ) {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                if (
                    chunk.byteLength > SIDECAR_CHUNK_BYTES ||
                    offset + chunk.byteLength > expectedBytes
                ) {
                    throw new PixaiOrtWorkerError("RESOURCE_LIMIT")
                }
                output.set(chunk, offset)
                offset += chunk.byteLength
            }
            if (offset !== expectedBytes) {
                throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
            }
            return output
        } finally {
            if (!completed && typeof iterator.return === "function") {
                try {
                    void iterator.return().catch(() => undefined)
                } catch {
                    // Iterator cleanup is best-effort; the Worker is closed by caller.
                }
            }
        }
    }

    async configurePixaiSidecars(
        preprocess: ModelArtifactReadable,
        selectedTags: ModelArtifactReadable,
        options: { signal?: AbortSignal } = {},
    ): Promise<void> {
        return this.exclusive(async () => {
            try {
                if (!this.loaded || this.pixaiConfigured) {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                const preprocessBytes = await this.readSidecar(
                    preprocess,
                    PREPROCESS_BYTES,
                    options.signal,
                )
                const selectedTagsBytes = await this.readSidecar(
                    selectedTags,
                    SELECTED_TAGS_BYTES,
                    options.signal,
                )
                await this.request(
                    "configurePixai",
                    {
                        preprocess: preprocessBytes.buffer,
                        selectedTags: selectedTagsBytes.buffer,
                    },
                    "pixaiConfigured",
                    [preprocessBytes.buffer, selectedTagsBytes.buffer],
                    options.signal,
                )
                this.pixaiConfigured = true
            } catch (error) {
                const stable = error instanceof PixaiOrtWorkerError
                    ? error
                    : new PixaiOrtWorkerError("MODEL_CONFIG_FAILED")
                this.shutdown(stable)
                throw stable
            }
        })
    }

    async runPixaiImage(
        input: PixaiImageRunInput,
        control: { signal?: AbortSignal } = {},
    ): Promise<PixaiImageRunOutput> {
        return this.exclusive(async () => {
            try {
                if (!this.loaded || !this.pixaiConfigured) {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                if (
                    !input ||
                    !(input.data instanceof Uint8Array) ||
                    Object.getPrototypeOf(input.data) !== Uint8Array.prototype ||
                    input.data.byteLength < 1 ||
                    input.data.byteLength > PIXAI_MAX_IMAGE_BYTES ||
                    (input.mediaType !== "image/jpeg" &&
                        input.mediaType !== "image/png" &&
                        input.mediaType !== "image/webp")
                ) {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                let normalized
                try {
                    normalized = normalizePixaiRunOptions(input.options)
                } catch {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                const data = Uint8Array.from(input.data)
                return await this.request(
                    "runPixai",
                    {
                        data: data.buffer,
                        mediaType: input.mediaType,
                        options: normalized,
                    },
                    "pixaiResult",
                    [data.buffer],
                    control.signal,
                ) as PixaiImageRunOutput
            } catch (error) {
                const stable = error instanceof PixaiOrtWorkerError
                    ? error
                    : new PixaiOrtWorkerError("INFERENCE_FAILED")
                if (stable.code === "ABORTED" || stable.code === "RUNTIME_UNAVAILABLE") {
                    this.shutdown(stable)
                }
                throw stable
            }
        })
    }

    async run(
        input: PixaiOrtRunInput,
        options: { signal?: AbortSignal } = {},
    ): Promise<PixaiOrtRunOutput> {
        return this.exclusive(async () => {
            try {
                if (!this.loaded) {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                if (
                    !input ||
                    !(input.data instanceof Float32Array) ||
                    Object.getPrototypeOf(input.data) !== Float32Array.prototype
                ) {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                const inputDimensions = normalizeDimensions(
                    input.dimensions,
                    MAX_INPUT_ELEMENTS,
                )
                if (
                    !inputDimensions ||
                    input.data.length !== inputDimensions.elements ||
                    [...input.data].some((entry) => !Number.isFinite(entry))
                ) {
                    throw new PixaiOrtWorkerError("INVALID_ARGUMENT")
                }
                const copy = Float32Array.from(input.data)
                return (await this.request(
                    "run",
                    {
                        data: copy.buffer,
                        dimensions: inputDimensions.values,
                    },
                    "result",
                    [copy.buffer],
                    options.signal,
                )) as PixaiOrtRunOutput
            } catch (error) {
                const stable =
                    error instanceof PixaiOrtWorkerError
                        ? error
                        : new PixaiOrtWorkerError("INFERENCE_FAILED")
                if (stable.code === "ABORTED" || stable.code === "RUNTIME_UNAVAILABLE") {
                    this.shutdown(stable)
                }
                throw stable
            }
        })
    }

    async dispose(): Promise<void> {
        if (this.closed) return
        if (this.busy) {
            this.shutdown(new PixaiOrtWorkerError("DISPOSED"))
            return
        }
        this.busy = true
        try {
            await this.request("dispose", {}, "disposed").catch(() => undefined)
        } finally {
            this.busy = false
            this.shutdown()
        }
    }
}
