import type { ModelArtifactReadable } from "./modelArtifactStore"
import { MODEL_ARTIFACT_MAX_CHUNK_BYTES } from "./modelArtifactStore"
import { getPixaiArtifact, PIXAI_PROFILE_ID } from "./pixaiRegistry"

export type PixaiOrtWorkerErrorCode =
    | "ABORTED"
    | "INVALID_ARGUMENT"
    | "RESOURCE_LIMIT"
    | "MODEL_LOAD_FAILED"
    | "INFERENCE_FAILED"
    | "RUNTIME_UNAVAILABLE"
    | "DISPOSED"

const ERROR_MESSAGES: Record<PixaiOrtWorkerErrorCode, string> = {
    ABORTED: "ORT worker operation was aborted",
    INVALID_ARGUMENT: "ORT worker request is invalid",
    RESOURCE_LIMIT: "ORT worker resource limit was exceeded",
    MODEL_LOAD_FAILED: "ORT model could not be loaded",
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

interface PendingRequest {
    id: number
    expected: "ack" | "loaded" | "result" | "disposed"
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

export class PixaiOrtWorkerClient {
    private worker: Worker | undefined
    private pending: PendingRequest | undefined
    private nextId = 1
    private busy = false
    private loaded = false
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
        kind: "begin" | "chunk" | "load" | "run" | "dispose",
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
