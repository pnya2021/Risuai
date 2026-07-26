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

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("Artifact fetch aborted", "AbortError")
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
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

function parseHeaders(value: unknown): Array<readonly [string, string]> {
    if (!Array.isArray(value) || value.length > RESPONSE_HEADER_NAMES.size) {
        throw new Error("Artifact bridge headers rejected")
    }
    const seen = new Set<string>()
    const result: Array<readonly [string, string]> = []
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2) {
            throw new Error("Artifact bridge headers rejected")
        }
        const [rawName, rawValue] = entry
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

function possibleHandle(value: unknown): string | null {
    if (!isRecord(value)) return null
    const handle = value.handle
    return typeof handle === "string" && handle.length <= 128 && !/[\r\n]/.test(handle)
        ? handle
        : null
}

function parseOpen(value: unknown): OpenResult {
    if (!isRecord(value)) throw new Error("Artifact bridge open result rejected")
    const status = value.status
    if (
        !Number.isInteger(status) ||
        (status !== 200 && status !== 206 && !REDIRECT_STATUSES.has(status as number))
    ) {
        throw new Error("Artifact bridge status rejected")
    }
    const headers = parseHeaders(value.headers)
    const handle = value.handle
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
                if (!isRecord(value) || typeof value.done !== "boolean") {
                    throw new Error("Artifact bridge read result rejected")
                }
                const chunk = value.chunk
                if (!Array.isArray(chunk)) {
                    throw new Error("Artifact bridge chunk rejected")
                }
                if (value.done) {
                    if (chunk.length !== 0) {
                        throw new Error("Artifact bridge EOF chunk rejected")
                    }
                    await finish("close")
                    nextController.close()
                    return
                }
                if (
                    chunk.length === 0 ||
                    chunk.length > MODEL_ARTIFACT_MAX_CHUNK_BYTES ||
                    received + chunk.length > input.maxBytes
                ) {
                    throw new Error("Artifact bridge chunk rejected")
                }
                for (let index = 0; index < chunk.length; index += 1) {
                    const byte = chunk[index]
                    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
                        throw new Error("Artifact bridge chunk rejected")
                    }
                }
                received += chunk.length
                nextController.enqueue(Uint8Array.from(chunk))
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
            const headers = validateRequest(request)
            throwIfAborted(request.signal)
            const requestId = createRequestId()
            if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
                throw new Error("Invalid artifact bridge request ID")
            }
            let currentHandle: string | null = null
            const cancelled = new Set<string>()
            const cancel = async (handle: string | null): Promise<void> => {
                const key = handle ?? "<opening>"
                if (cancelled.has(key)) return
                cancelled.add(key)
                await invoke("cancel_model_artifact_fetch", {
                    requestId,
                    handle,
                }).catch(() => undefined)
            }
            const onAbort = () => {
                void cancel(currentHandle)
            }
            request.signal.addEventListener("abort", onAbort, { once: true })
            let raw: unknown
            try {
                raw = await invoke("open_model_artifact_fetch", {
                    requestId,
                    url: request.url,
                    headers,
                    maxBytes: request.maxBytes,
                })
            } catch (error) {
                request.signal.removeEventListener("abort", onAbort)
                if (request.signal.aborted) {
                    await cancel(null)
                    throw abortReason(request.signal)
                }
                throw error
            }
            currentHandle = possibleHandle(raw)
            if (request.signal.aborted) {
                await cancel(currentHandle)
                request.signal.removeEventListener("abort", onAbort)
                throw abortReason(request.signal)
            }
            let opened: OpenResult
            try {
                opened = parseOpen(raw)
            } catch (error) {
                request.signal.removeEventListener("abort", onAbort)
                if (currentHandle) await cancel(currentHandle)
                throw error
            }
            if (opened.handle === null) {
                request.signal.removeEventListener("abort", onAbort)
                return { status: opened.status, headers: opened.headers, body: null }
            }
            request.signal.removeEventListener("abort", onAbort)
            return {
                status: opened.status,
                headers: opened.headers,
                body: createBody({
                    invoke,
                    requestId,
                    handle: opened.handle,
                    signal: request.signal,
                    maxBytes: request.maxBytes,
                }),
            }
        },
    }
}
