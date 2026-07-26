import { MODEL_ARTIFACT_MAX_CHUNK_BYTES } from "./modelArtifactStore"
import {
    resolveRegisteredArtifactRedirect,
} from "./artifactUrlPolicy"
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
const RESPONSE_HEADERS = [
    "Location",
    "ETag",
    "Content-Range",
    "Content-Length",
] as const
const MAX_HEADER_VALUE_BYTES = 4_096

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
        snapshot[key] = descriptor.value
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

function projectHeaders(response: Response): Array<readonly [string, string]> {
    const projected: Array<readonly [string, string]> = []
    for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name)
        if (value === null) continue
        if (
            value.length === 0 ||
            value.length > MAX_HEADER_VALUE_BYTES ||
            /[\r\n]/.test(value)
        ) {
            throw new Error("Artifact response headers rejected")
        }
        projected.push([name, value])
    }
    return projected
}

async function discardBody(response: Response, reason?: unknown): Promise<void> {
    if (!response.body) return
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
        reader = response.body.getReader()
        await reader.cancel(reason).catch(() => undefined)
    } catch {
        await response.body.cancel(reason).catch(() => undefined)
    } finally {
        reader?.releaseLock()
    }
}

function boundedBody(
    response: Response,
    signal: AbortSignal,
): ReadableStream<Uint8Array> {
    const reader = response.body!.getReader()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let buffered: Uint8Array | undefined
    let bufferedOffset = 0
    let terminal = false

    const finish = async (cancel: boolean, reason?: unknown): Promise<void> => {
        if (terminal) return
        terminal = true
        signal.removeEventListener("abort", onAbort)
        try {
            if (cancel) await reader.cancel(reason).catch(() => undefined)
        } finally {
            reader.releaseLock()
        }
    }
    const fail = async (error: unknown) => {
        await finish(true, error)
        controller?.error(error)
    }
    const onAbort = () => {
        const reason = abortReason(signal)
        void fail(reason)
    }

    return new ReadableStream<Uint8Array>({
        start(nextController) {
            controller = nextController
            signal.addEventListener("abort", onAbort, { once: true })
            if (signal.aborted) onAbort()
        },
        async pull(nextController) {
            if (terminal) return
            try {
                if (buffered) {
                    const end = Math.min(
                        buffered.byteLength,
                        bufferedOffset + MODEL_ARTIFACT_MAX_CHUNK_BYTES,
                    )
                    nextController.enqueue(buffered.slice(bufferedOffset, end))
                    bufferedOffset = end
                    if (bufferedOffset === buffered.byteLength) {
                        buffered = undefined
                        bufferedOffset = 0
                    }
                    return
                }
                const item = await reader.read()
                if (terminal) return
                throwIfAborted(signal)
                if (item.done) {
                    await finish(false)
                    nextController.close()
                    return
                }
                if (!(item.value instanceof Uint8Array) || item.value.byteLength === 0) {
                    throw new Error("Artifact response yielded invalid bytes")
                }
                buffered = item.value
                const end = Math.min(
                    buffered.byteLength,
                    MODEL_ARTIFACT_MAX_CHUNK_BYTES,
                )
                nextController.enqueue(buffered.slice(0, end))
                if (end === buffered.byteLength) buffered = undefined
                else bufferedOffset = end
            } catch (error) {
                await fail(error)
            }
        },
        cancel(reason) {
            return finish(true, reason)
        },
    })
}

export function createWebRegisteredArtifactTransport(
    options: { fetch?: typeof fetch } = {},
): RegisteredArtifactTransport {
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== "function") {
        throw new Error("Web artifact transport is unavailable")
    }
    return {
        async request(request): Promise<RegisteredArtifactResponse> {
            const snapshot = validateRequest(request)
            throwIfAborted(snapshot.signal)
            const response = await fetchImpl(snapshot.url, {
                method: "GET",
                headers: new Headers(
                    snapshot.headers.map(([name, value]) => [name, value]),
                ),
                signal: snapshot.signal,
                redirect: "manual",
                credentials: "omit",
                referrerPolicy: "no-referrer",
            })
            try {
                throwIfAborted(snapshot.signal)
                if (
                    response.type === "opaqueredirect" ||
                    response.redirected ||
                    (response.url !== "" && response.url !== snapshot.url)
                ) {
                    throw new Error("Artifact redirect was not manually observable")
                }
                const headers = projectHeaders(response)
                if (REDIRECT_STATUSES.has(response.status)) {
                    if (!headers.some(([name]) => name === "Location")) {
                        throw new Error("Artifact redirect omitted Location")
                    }
                    await discardBody(response)
                    return { status: response.status, headers, body: null }
                }
                if (response.status !== 200 && response.status !== 206) {
                    throw new Error("Artifact response status rejected")
                }
                if (!response.body) throw new Error("Artifact response body is absent")
                return {
                    status: response.status,
                    headers,
                    body: boundedBody(response, snapshot.signal),
                }
            } catch (error) {
                await discardBody(response, error)
                throw error
            }
        },
    }
}
