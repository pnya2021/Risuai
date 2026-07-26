import { invoke as tauriInvoke } from "@tauri-apps/api/core"
import { MODEL_ARTIFACT_MAX_CHUNK_BYTES } from "./modelArtifactStore"
import { resolveRegisteredArtifactRedirect } from "./artifactUrlPolicy"
import {
    PIXAI_PROFILE_ID,
    getPixaiProfile,
} from "./pixaiRegistry"
import type {
    RegisteredArtifactRequest,
    RegisteredArtifactResponse,
    RegisteredArtifactTransport,
} from "./registeredArtifactDownload"

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const RESPONSE_HEADER_NAMES = new Map<string, string>([
    ["location", "Location"],
    ["etag", "ETag"],
    ["content-range", "Content-Range"],
    ["content-length", "Content-Length"],
] as const)
const MAX_HEADER_VALUE_BYTES = 4_096

export type TauriArtifactInvoke = (
    command: string,
    args: Record<string, unknown>,
) => Promise<unknown>

interface OpenResult {
    handle: string | null
    status: number
    headers: Array<readonly [string, string]>
}

interface RequestSnapshot {
    url: string
    headers: Array<readonly [string, string]>
    signal: AbortSignal
    maxBytes: number
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("Artifact fetch aborted", "AbortError")
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal)
}

function assertRegisteredUrl(url: string, maxBytes: number): void {
    const profile = getPixaiProfile(PIXAI_PROFILE_ID)
    const direct = profile.artifacts.find((artifact) => artifact.url === url)
    if (direct) {
        if (direct.bytes !== maxBytes) throw new Error("Artifact size is not registered")
        return
    }
    if (!profile.artifacts.some((artifact) => artifact.bytes === maxBytes)) {
        throw new Error("Artifact size is not registered")
    }
    const approved = profile.artifacts.some((artifact) => {
        try {
            return resolveRegisteredArtifactRedirect({
                artifact,
                currentUrl: artifact.url,
                location: url,
                redirectsFollowed: 0,
            }) === url
        } catch {
            return false
        }
    })
    if (!approved) throw new Error("Artifact URL is not registered")
}

function snapshotPlainRecord(
    value: unknown,
    expectedKeys: readonly string[],
    message: string,
    onValue?: (key: string, value: unknown) => void,
): Record<string, unknown> {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new Error(message)
    }
    const keys = Reflect.ownKeys(value)
    const expected = new Set(expectedKeys)
    if (
        keys.length !== expectedKeys.length ||
        keys.some((key) => typeof key !== "string" || !expected.has(key))
    ) {
        throw new Error(message)
    }
    const snapshot: Record<string, unknown> = {}
    for (const key of expectedKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error(message)
        }
        const propertyValue = descriptor.value
        snapshot[key] = propertyValue
        onValue?.(key, propertyValue)
    }
    return snapshot
}

function snapshotDenseArray(
    value: unknown,
    maxLength: number,
    message: string,
): unknown[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(message)
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
    if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.enumerable ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > maxLength
    ) {
        throw new Error(message)
    }
    const length = lengthDescriptor.value as number
    const keys = Reflect.ownKeys(value)
    if (keys.length !== length + 1 || keys[length] !== "length") {
        throw new Error(message)
    }
    const snapshot = new Array<unknown>(length)
    for (let index = 0; index < length; index += 1) {
        const key = String(index)
        if (keys[index] !== key) throw new Error(message)
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error(message)
        }
        snapshot[index] = descriptor.value
    }
    return snapshot
}

function validateRequest(request: RegisteredArtifactRequest): RequestSnapshot {
    const fields = snapshotPlainRecord(
        request,
        ["url", "headers", "signal", "maxBytes"],
        "Invalid artifact request data properties",
    )
    const url = fields.url
    const maxBytes = fields.maxBytes
    const signal = fields.signal
    if (typeof url !== "string") throw new Error("Invalid artifact request URL")
    if (
        typeof maxBytes !== "number" ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0
    ) {
        throw new Error("Invalid artifact response limit")
    }
    if (!(signal instanceof AbortSignal)) {
        throw new Error("Invalid artifact request signal")
    }
    assertRegisteredUrl(url, maxBytes)
    const sourceHeaders = snapshotDenseArray(
        fields.headers,
        2,
        "Artifact request headers rejected",
    )
    const seen = new Set<string>()
    const result: Array<readonly [string, string]> = []
    for (let index = 0; index < sourceHeaders.length; index += 1) {
        const entry = snapshotDenseArray(
            sourceHeaders[index],
            2,
            "Artifact request headers rejected",
        )
        if (entry.length !== 2) {
            throw new Error("Artifact request headers rejected")
        }
        const rawName = entry[0]
        const value = entry[1]
        if (typeof rawName !== "string" || typeof value !== "string") {
            throw new Error("Artifact request headers rejected")
        }
        const name = rawName.toLowerCase()
        if (
            (name !== "range" && name !== "if-range") ||
            seen.has(name) ||
            value.length === 0 ||
            value.length > MAX_HEADER_VALUE_BYTES ||
            /[\r\n]/.test(value)
        ) {
            throw new Error("Artifact request headers rejected")
        }
        if (name === "range") {
            const match = /^bytes=(0|[1-9]\d*)-$/.exec(value)
            const offset = match ? Number(match[1]) : Number.NaN
            if (!Number.isSafeInteger(offset) || offset >= maxBytes) {
                throw new Error("Artifact Range header rejected")
            }
        }
        seen.add(name)
        result.push([name === "range" ? "Range" : "If-Range", value])
    }
    return { url, headers: result, signal, maxBytes }
}

function parseHeaders(value: unknown): Array<readonly [string, string]> {
    const source = snapshotDenseArray(
        value,
        RESPONSE_HEADER_NAMES.size,
        "Artifact bridge headers rejected",
    )
    const seen = new Set<string>()
    const result: Array<readonly [string, string]> = []
    for (let index = 0; index < source.length; index += 1) {
        const entry = snapshotDenseArray(
            source[index],
            2,
            "Artifact bridge headers rejected",
        )
        if (entry.length !== 2) {
            throw new Error("Artifact bridge headers rejected")
        }
        const rawName = entry[0]
        const rawValue = entry[1]
        if (typeof rawName !== "string" || typeof rawValue !== "string") {
            throw new Error("Artifact bridge headers rejected")
        }
        const normalized = rawName.toLowerCase()
        const name = RESPONSE_HEADER_NAMES.get(normalized)
        if (
            !name ||
            seen.has(normalized) ||
            rawValue.length === 0 ||
            rawValue.length > MAX_HEADER_VALUE_BYTES ||
            /[\r\n]/.test(rawValue)
        ) {
            throw new Error("Artifact bridge headers rejected")
        }
        seen.add(normalized)
        result.push([name, rawValue])
    }
    return result
}

function cleanupHandle(value: unknown): string | null {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        !/[\r\n]/.test(value)
        ? value
        : null
}

function parseOpen(
    value: unknown,
    onHandle: (handle: string | null) => void,
): OpenResult {
    const fields = snapshotPlainRecord(
        value,
        ["handle", "status", "headers"],
        "Artifact bridge open result rejected",
        (key, fieldValue) => {
            if (key === "handle") onHandle(cleanupHandle(fieldValue))
        },
    )
    const status = fields.status
    if (
        !Number.isInteger(status) ||
        (status !== 200 && status !== 206 && !REDIRECT_STATUSES.has(status as number))
    ) {
        throw new Error("Artifact bridge status rejected")
    }
    const headers = parseHeaders(fields.headers)
    const handle = fields.handle
    if (REDIRECT_STATUSES.has(status as number)) {
        if (handle !== null || !headers.some(([name]) => name === "Location")) {
            throw new Error("Artifact bridge redirect result rejected")
        }
    } else if (
        typeof handle !== "string" ||
        handle.length === 0 ||
        handle.length > 128 ||
        /[\r\n]/.test(handle)
    ) {
        throw new Error("Artifact bridge handle rejected")
    }
    return { handle: handle as string | null, status: status as number, headers }
}

function createBody(input: {
    invoke: TauriArtifactInvoke
    requestId: string
    handle: string
    signal: AbortSignal
    maxBytes: number
}): ReadableStream<Uint8Array> {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let terminal = false
    let received = 0

    const finish = async (kind: "close" | "cancel"): Promise<void> => {
        if (terminal) return
        terminal = true
        input.signal.removeEventListener("abort", onAbort)
        const command =
            kind === "close"
                ? "close_model_artifact_fetch"
                : "cancel_model_artifact_fetch"
        const args =
            kind === "close"
                ? { handle: input.handle }
                : { requestId: input.requestId, handle: input.handle }
        await input.invoke(command, args).catch(() => undefined)
    }
    const fail = async (error: unknown): Promise<void> => {
        await finish("cancel")
        controller?.error(error)
    }
    const onAbort = () => {
        void fail(abortReason(input.signal))
    }

    return new ReadableStream<Uint8Array>({
        start(nextController) {
            controller = nextController
            input.signal.addEventListener("abort", onAbort, { once: true })
            if (input.signal.aborted) onAbort()
        },
        async pull(nextController) {
            if (terminal) return
            try {
                const value = await input.invoke("read_model_artifact_fetch", {
                    handle: input.handle,
                    maxBytes: MODEL_ARTIFACT_MAX_CHUNK_BYTES,
                })
                if (terminal) return
                throwIfAborted(input.signal)
                const fields = snapshotPlainRecord(
                    value,
                    ["done", "chunk"],
                    "Artifact bridge read result rejected",
                )
                if (typeof fields.done !== "boolean") {
                    throw new Error("Artifact bridge read result rejected")
                }
                const chunkValues = snapshotDenseArray(
                    fields.chunk,
                    MODEL_ARTIFACT_MAX_CHUNK_BYTES,
                    "Artifact bridge chunk rejected",
                )
                if (fields.done) {
                    if (chunkValues.length !== 0) {
                        throw new Error("Artifact bridge EOF chunk rejected")
                    }
                    await finish("close")
                    nextController.close()
                    return
                }
                if (
                    chunkValues.length === 0 ||
                    chunkValues.length > input.maxBytes - received
                ) {
                    throw new Error("Artifact bridge chunk rejected")
                }
                for (let index = 0; index < chunkValues.length; index += 1) {
                    const byte = chunkValues[index]
                    if (
                        typeof byte !== "number" ||
                        !Number.isInteger(byte) ||
                        byte < 0 ||
                        byte > 255
                    ) {
                        throw new Error("Artifact bridge chunk rejected")
                    }
                }
                const chunk = new Uint8Array(chunkValues.length)
                for (let index = 0; index < chunkValues.length; index += 1) {
                    chunk[index] = chunkValues[index] as number
                }
                received += chunk.byteLength
                nextController.enqueue(chunk)
            } catch (error) {
                await fail(error)
            }
        },
        cancel() {
            return finish("cancel")
        },
    })
}

export function createTauriRegisteredArtifactTransport(
    options: {
        invoke?: TauriArtifactInvoke
        createRequestId?: () => string
    } = {},
): RegisteredArtifactTransport {
    const invoke: TauriArtifactInvoke =
        options.invoke ?? ((command, args) => tauriInvoke(command, args))
    const createRequestId =
        options.createRequestId ?? (() => globalThis.crypto.randomUUID())
    return {
        async request(request): Promise<RegisteredArtifactResponse> {
            const snapshot = validateRequest(request)
            throwIfAborted(snapshot.signal)
            const requestId = createRequestId()
            if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
                throw new Error("Invalid artifact bridge request ID")
            }
            let currentHandle: string | null = null
            let openingCancelled = false
            const cancelledHandles = new Set<string>()
            const cancel = async (handle: string | null): Promise<void> => {
                if (handle === null) {
                    if (openingCancelled) return
                    openingCancelled = true
                } else {
                    if (cancelledHandles.has(handle)) return
                    cancelledHandles.add(handle)
                }
                await invoke("cancel_model_artifact_fetch", {
                    requestId,
                    handle,
                }).catch(() => undefined)
            }
            const onAbort = () => {
                void cancel(currentHandle)
            }
            snapshot.signal.addEventListener("abort", onAbort, { once: true })
            try {
                const raw = await invoke("open_model_artifact_fetch", {
                    requestId,
                    url: snapshot.url,
                    headers: snapshot.headers,
                    maxBytes: snapshot.maxBytes,
                })
                const opened = parseOpen(raw, (handle) => {
                    currentHandle = handle
                })
                throwIfAborted(snapshot.signal)
                snapshot.signal.removeEventListener("abort", onAbort)
                if (opened.handle === null) {
                    return {
                        status: opened.status,
                        headers: opened.headers,
                        body: null,
                    }
                }
                return {
                    status: opened.status,
                    headers: opened.headers,
                    body: createBody({
                        invoke,
                        requestId,
                        handle: opened.handle,
                        signal: snapshot.signal,
                        maxBytes: snapshot.maxBytes,
                    }),
                }
            } catch (error) {
                const failure = snapshot.signal.aborted
                    ? abortReason(snapshot.signal)
                    : error
                snapshot.signal.removeEventListener("abort", onAbort)
                await cancel(currentHandle)
                throw failure
            }
        },
    }
}
