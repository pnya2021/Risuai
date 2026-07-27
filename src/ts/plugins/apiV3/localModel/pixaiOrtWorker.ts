import * as ort from "onnxruntime-web/wasm"
import ortWasmModuleUrl from "../../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url"
import ortWasmBinaryUrl from "../../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url"

const MAX_MODEL_BYTES = 1_271_365_854
const MAX_CHUNK_BYTES = 1_048_576
const MAX_INPUT_ELEMENTS = 448 * 448 * 3
const MAX_OUTPUT_ELEMENTS = 13_461

type WorkerErrorCode =
    | "INVALID_ARGUMENT"
    | "RESOURCE_LIMIT"
    | "MODEL_LOAD_FAILED"
    | "INFERENCE_FAILED"
    | "RUNTIME_UNAVAILABLE"
    | "DISPOSED"

const ERROR_MESSAGES: Record<WorkerErrorCode, string> = {
    INVALID_ARGUMENT: "ORT worker request is invalid",
    RESOURCE_LIMIT: "ORT worker resource limit was exceeded",
    MODEL_LOAD_FAILED: "ORT model could not be loaded",
    INFERENCE_FAILED: "ORT inference failed",
    RUNTIME_UNAVAILABLE: "ORT worker runtime is unavailable",
    DISPOSED: "ORT worker is disposed",
}

const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<unknown>) => void) | null
    onmessageerror: (() => void) | null
    postMessage(message: unknown, transfer?: Transferable[]): void
    close(): void
}

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

const validId = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) > 0

const validName = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 128

const dimensions = (
    value: unknown,
    maxElements: number,
): number[] | undefined => {
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
    let product = 1
    for (const entry of value) {
        product *= entry
        if (!Number.isSafeInteger(product) || product > maxElements) {
            return undefined
        }
    }
    return [...value]
}

const postError = (id: number, code: WorkerErrorCode) => {
    scope.postMessage({
        id,
        kind: "error",
        code,
        message: ERROR_MESSAGES[code],
    })
}

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
ort.env.wasm.wasmPaths = {
    mjs: ortWasmModuleUrl,
    wasm: ortWasmBinaryUrl,
}

let session: ort.InferenceSession | undefined
let expectedBytes = 0
let receivedBytes = 0
let modelParts: ArrayBuffer[] = []
let disposed = false

const invalid = (id: number) => postError(id, "INVALID_ARGUMENT")

const handleMessage = async (value: unknown) => {
    if (!plainRecord(value)) {
        postError(1, "INVALID_ARGUMENT")
        return
    }
    if (!validId(value.id) || typeof value.kind !== "string") {
        postError(validId(value.id) ? value.id : 1, "INVALID_ARGUMENT")
        return
    }
    const id = value.id
    if (disposed && value.kind !== "dispose") {
        postError(id, "DISPOSED")
        return
    }

    if (value.kind === "begin") {
        if (
            !exactRecord(value, ["id", "kind", "size"]) ||
            !Number.isSafeInteger(value.size) ||
            (value.size as number) <= 0
        ) {
            invalid(id)
            return
        }
        if ((value.size as number) > MAX_MODEL_BYTES) {
            postError(id, "RESOURCE_LIMIT")
            return
        }
        if (session || expectedBytes !== 0 || modelParts.length !== 0) {
            invalid(id)
            return
        }
        expectedBytes = value.size as number
        scope.postMessage({ id, kind: "ack" })
        return
    }

    if (value.kind === "chunk") {
        if (
            !exactRecord(value, ["id", "kind", "data"]) ||
            !(value.data instanceof ArrayBuffer) ||
            value.data.byteLength < 1
        ) {
            invalid(id)
            return
        }
        if (
            expectedBytes === 0 ||
            value.data.byteLength > MAX_CHUNK_BYTES ||
            receivedBytes + value.data.byteLength > expectedBytes
        ) {
            postError(id, "RESOURCE_LIMIT")
            return
        }
        modelParts.push(value.data)
        receivedBytes += value.data.byteLength
        scope.postMessage({ id, kind: "ack" })
        return
    }

    if (value.kind === "load") {
        if (!exactRecord(value, ["id", "kind"]) || receivedBytes !== expectedBytes) {
            invalid(id)
            return
        }
        const parts = modelParts
        modelParts = []
        expectedBytes = 0
        receivedBytes = 0
        const url = URL.createObjectURL(
            new Blob(parts, { type: "application/octet-stream" }),
        )
        try {
            const loaded = await ort.InferenceSession.create(url, {
                executionProviders: ["wasm"],
            })
            const inputName = loaded.inputNames[0]
            const outputName = loaded.outputNames[0]
            if (!validName(inputName) || !validName(outputName)) {
                await loaded.release().catch(() => undefined)
                postError(id, "MODEL_LOAD_FAILED")
                return
            }
            session = loaded
            scope.postMessage({
                id,
                kind: "loaded",
                provider: "wasm",
                inputName,
                outputName,
            })
        } catch {
            postError(id, "MODEL_LOAD_FAILED")
        } finally {
            URL.revokeObjectURL(url)
            parts.length = 0
        }
        return
    }

    if (value.kind === "run") {
        if (
            !exactRecord(value, ["id", "kind", "data", "dimensions"]) ||
            !(value.data instanceof ArrayBuffer)
        ) {
            invalid(id)
            return
        }
        const inputDimensions = dimensions(value.dimensions, MAX_INPUT_ELEMENTS)
        if (
            !session ||
            !inputDimensions ||
            value.data.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0 ||
            value.data.byteLength / Float32Array.BYTES_PER_ELEMENT !==
                inputDimensions.reduce((product, entry) => product * entry, 1)
        ) {
            invalid(id)
            return
        }
        try {
            const input = new Float32Array(value.data)
            if ([...input].some((entry) => !Number.isFinite(entry))) {
                invalid(id)
                return
            }
            const inputName = session.inputNames[0]
            const outputName = session.outputNames[0]
            const results = await session.run({
                [inputName]: new ort.Tensor("float32", input, inputDimensions),
            })
            const output = results[outputName]
            const outputDimensions = dimensions(
                output?.dims,
                MAX_OUTPUT_ELEMENTS,
            )
            if (
                !output ||
                output.type !== "float32" ||
                !(output.data instanceof Float32Array) ||
                !outputDimensions ||
                output.data.length !==
                    outputDimensions.reduce(
                        (product, entry) => product * entry,
                        1,
                    ) ||
                [...output.data].some((entry) => !Number.isFinite(entry))
            ) {
                postError(id, "INFERENCE_FAILED")
                return
            }
            const copy = Float32Array.from(output.data)
            scope.postMessage(
                {
                    id,
                    kind: "result",
                    data: copy.buffer,
                    dimensions: outputDimensions,
                },
                [copy.buffer],
            )
        } catch {
            postError(id, "INFERENCE_FAILED")
        }
        return
    }

    if (value.kind === "dispose") {
        if (!exactRecord(value, ["id", "kind"])) {
            invalid(id)
            return
        }
        disposed = true
        modelParts = []
        expectedBytes = 0
        receivedBytes = 0
        const active = session
        session = undefined
        if (active) await active.release().catch(() => undefined)
        scope.postMessage({ id, kind: "disposed" })
        scope.close()
        return
    }

    invalid(id)
}

scope.onmessage = (event) => {
    void handleMessage(event.data).catch(() => {
        const value = event.data
        const id = plainRecord(value) && validId(value.id) ? value.id : 1
        postError(id, "RUNTIME_UNAVAILABLE")
    })
}

scope.onmessageerror = () => {
    disposed = true
    scope.close()
}
