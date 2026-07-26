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

function validateRequest(
    request: RegisteredArtifactRequest,
): Array<readonly [string, string]> {
    if (!request || typeof request !== "object") {
        throw new Error("Invalid artifact request")
    }
    const method = (request as RegisteredArtifactRequest & { method?: unknown })
        .method
    if (method !== undefined && method !== "GET") {
        throw new Error("Artifact transport only permits GET")
    }
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
        throw new Error("Invalid artifact response limit")
    }
    assertRegisteredUrl(request.url, request.maxBytes)
    if (!Array.isArray(request.headers) || request.headers.length > 2) {
        throw new Error("Artifact request headers rejected")
    }
    const seen = new Set<string>()
    const result: Array<readonly [string, string]> = []
    for (const entry of request.headers) {
        if (!Array.isArray(entry) || entry.length !== 2) {
            throw new Error("Artifact request headers rejected")
        }
        const [rawName, value] = entry
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
            if (!Number.isSafeInteger(offset) || offset >= request.maxBytes) {
                throw new Error("Artifact Range header rejected")
            }
        }
        seen.add(name)
        result.push([name === "range" ? "Range" : "If-Range", value])
    }
    return result
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
            const requestHeaders = validateRequest(request)
            throwIfAborted(request.signal)
            const response = await fetchImpl(request.url, {
                method: "GET",
                headers: new Headers(requestHeaders.map(([name, value]) => [name, value])),
                signal: request.signal,
                redirect: "manual",
                credentials: "omit",
                referrerPolicy: "no-referrer",
            })
            try {
                throwIfAborted(request.signal)
                if (
                    response.type === "opaqueredirect" ||
                    response.redirected ||
                    (response.url !== "" && response.url !== request.url)
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
                    body: boundedBody(response, request.signal),
                }
            } catch (error) {
                await discardBody(response, error)
                throw error
            }
        },
    }
}
