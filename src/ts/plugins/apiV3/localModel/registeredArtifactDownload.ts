import { Sha256 } from "@aws-crypto/sha256-js"
import {
    MODEL_ARTIFACT_MAX_CHUNK_BYTES,
    assertArtifactDigest,
    type ArtifactStat,
    type ModelArtifactStore,
    type ModelArtifactWriteHandle,
} from "./modelArtifactStore"
import {
    assertRegisteredArtifactInitialUrl,
    resolveRegisteredArtifactRedirect,
} from "./artifactUrlPolicy"
import {
    assertRegisteredPixaiArtifact,
    type RegisteredModelArtifact,
} from "./pixaiRegistry"

const HASH_CHUNK_BYTES = 1_048_576
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface RegisteredArtifactRequest {
    url: string
    headers: Array<readonly [string, string]>
    signal: AbortSignal
    maxBytes: number
}

export interface RegisteredArtifactResponse {
    status: number
    headers: Array<readonly [string, string]>
    body: ReadableStream<Uint8Array> | null
}

export interface RegisteredArtifactTransport {
    request(
        request: RegisteredArtifactRequest,
    ): Promise<RegisteredArtifactResponse>
}

export interface RegisteredArtifactDownloadOptions {
    artifact: Readonly<RegisteredModelArtifact>
    store: ModelArtifactStore
    transport: RegisteredArtifactTransport
    signal?: AbortSignal
    onProgress?: (progress: RegisteredArtifactDownloadProgress) => unknown
    currentHostOrigin?: string
    assertRegisteredArtifact?: (
        artifact: Readonly<RegisteredModelArtifact>,
    ) => void
}

export interface RegisteredArtifactDownloadProgress {
    phase: "downloading" | "verifying" | "committing"
    loadedBytes: number
    totalBytes: number
}

export interface RegisteredArtifactDownloadResult {
    state: "verified"
    bytes: number
    resumed: boolean
}

interface SharedDownload {
    readonly controller: AbortController
    readonly observers: Map<symbol, NonNullable<RegisteredArtifactDownloadOptions["onProgress"]>>
    promise: Promise<RegisteredArtifactDownloadResult>
    waiters: number
    settled: boolean
    progress?: RegisteredArtifactDownloadProgress
}

class DownloadFailure extends Error {
    constructor(
        message: string,
        readonly keepPartial: boolean,
    ) {
        super(message)
        this.name = "DownloadFailure"
    }
}

const sharedByStore = new WeakMap<
    ModelArtifactStore,
    Map<string, SharedDownload>
>()

function abortReason(signal?: AbortSignal): unknown {
    if (signal?.reason !== undefined) return signal.reason
    return new DOMException("Artifact download aborted", "AbortError")
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal)
}

function notifyProgress(
    observer: RegisteredArtifactDownloadOptions["onProgress"],
    progress: RegisteredArtifactDownloadProgress,
): void {
    if (!observer) return
    try {
        void Promise.resolve(observer({ ...progress })).catch(() => undefined)
    } catch {
        // Progress is advisory and must not affect artifact state.
    }
}

function publishSharedProgress(
    operation: SharedDownload,
    progress: RegisteredArtifactDownloadProgress,
): void {
    operation.progress = { ...progress }
    for (const observer of operation.observers.values()) {
        notifyProgress(observer, progress)
    }
}

function header(
    headers: Array<readonly [string, string]>,
    name: string,
): string | undefined {
    const values = headers
        .filter(([key]) => key.toLowerCase() === name.toLowerCase())
        .map(([, value]) => value.trim())
    if (values.length > 1) throw new Error(`Duplicate ${name} response header`)
    return values[0]
}

async function cancelBody(
    body: ReadableStream<Uint8Array> | null,
    reason?: unknown,
): Promise<void> {
    if (!body || body.locked) return
    await body.cancel(reason).catch(() => undefined)
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    )
}

async function hashPartial(
    store: ModelArtifactStore,
    digest: string,
    expectedBytes: number,
    signal: AbortSignal,
): Promise<{ hasher: Sha256; bytes: number }> {
    const hasher = new Sha256()
    let bytes = 0
    for await (const chunk of store.readPartial(digest, {
        chunkSize: HASH_CHUNK_BYTES,
    })) {
        throwIfAborted(signal)
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
            throw new Error("Artifact store returned an invalid partial chunk")
        }
        bytes += chunk.byteLength
        if (bytes > expectedBytes) {
            throw new DownloadFailure("Partial artifact exceeds registered size", false)
        }
        hasher.update(chunk)
    }
    return { hasher, bytes }
}

function validateContentRange(
    value: string | undefined,
    offset: number,
    total: number,
): boolean {
    if (!value) return false
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value)
    if (!match) return false
    const start = Number(match[1])
    const end = Number(match[2])
    const reportedTotal = Number(match[3])
    return start === offset && end === total - 1 && reportedTotal === total
}

async function preflightQuota(
    store: ModelArtifactStore,
    artifact: Readonly<RegisteredModelArtifact>,
    state: ArtifactStat,
): Promise<void> {
    const estimate = await store.estimate()
    if (
        estimate.usageBytes === undefined ||
        estimate.quotaBytes === undefined
    ) {
        return
    }
    const available = Math.max(0, estimate.quotaBytes - estimate.usageBytes)
    const remaining = Math.max(0, artifact.bytes - state.bytes)
    if (available < remaining) {
        throw new Error("Insufficient model artifact storage quota")
    }
}

async function streamIntoStore(input: {
    response: RegisteredArtifactResponse
    writer: ModelArtifactWriteHandle
    store: ModelArtifactStore
    hasher: Sha256
    offset: number
    artifact: Readonly<RegisteredModelArtifact>
    signal: AbortSignal
    onProgress?: RegisteredArtifactDownloadOptions["onProgress"]
}): Promise<void> {
    if (!input.response.body) throw new Error("Artifact response body is absent")
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let total = input.offset
    let completed = false
    try {
        reader = input.response.body.getReader()
        while (true) {
            throwIfAborted(input.signal)
            const item = await reader.read()
            throwIfAborted(input.signal)
            if (item.done) break
            if (!(item.value instanceof Uint8Array)) {
                throw new DownloadFailure("Artifact stream yielded non-byte data", false)
            }
            if (item.value.byteLength === 0) continue
            if (item.value.byteLength > MODEL_ARTIFACT_MAX_CHUNK_BYTES) {
                throw new DownloadFailure(
                    "Artifact stream chunk exceeds maximum size",
                    false,
                )
            }
            const chunk = item.value.slice()
            total += chunk.byteLength
            if (total > input.artifact.bytes) {
                throw new DownloadFailure("Artifact stream exceeded registered size", false)
            }
            input.hasher.update(chunk)
            await input.writer.write(chunk)
            notifyProgress(input.onProgress, {
                phase: "downloading",
                loadedBytes: total,
                totalBytes: input.artifact.bytes,
            })
        }
        if (total !== input.artifact.bytes) {
            throw new DownloadFailure("Artifact stream ended before registered size", true)
        }
        notifyProgress(input.onProgress, {
            phase: "verifying",
            loadedBytes: total,
            totalBytes: input.artifact.bytes,
        })
        const digest = toHex(await input.hasher.digest())
        if (digest !== input.artifact.sha256) {
            throw new DownloadFailure("Artifact SHA-256 verification failed", false)
        }
        notifyProgress(input.onProgress, {
            phase: "committing",
            loadedBytes: total,
            totalBytes: input.artifact.bytes,
        })
        await commitVerified({
            writer: input.writer,
            store: input.store,
            digest,
            signal: input.signal,
        })
        completed = true
    } catch (error) {
        const keepPartial =
            error instanceof DownloadFailure
                ? error.keepPartial
                : input.signal.aborted
                  ? true
                  : false
        await input.writer.abort({ keepPartial }).catch(() => undefined)
        throw error
    } finally {
        if (reader) {
            if (!completed) await reader.cancel().catch(() => undefined)
            reader.releaseLock()
        }
    }
}

async function commitVerified(input: {
    writer: ModelArtifactWriteHandle
    store: ModelArtifactStore
    digest: string
    signal: AbortSignal
}): Promise<void> {
    throwIfAborted(input.signal)
    await input.writer.commit(input.digest)
    if (!input.signal.aborted) return
    await input.store.remove(input.digest, {
        partial: false,
        verified: true,
    })
    throw abortReason(input.signal)
}

async function executeDownload(
    options: RegisteredArtifactDownloadOptions,
    signal: AbortSignal,
): Promise<RegisteredArtifactDownloadResult> {
    const { artifact, store, transport } = options
    throwIfAborted(signal)
    let state = await store.stat(artifact.sha256)
    if (state.state === "verified") {
        if (state.bytes !== artifact.bytes) {
            throw new Error("Verified artifact size does not match registration")
        }
        return { state: "verified", bytes: artifact.bytes, resumed: false }
    }
    if (state.bytes > artifact.bytes) {
        await store.remove(artifact.sha256, {
            partial: true,
            verified: false,
        })
        state = { state: "absent", bytes: 0 }
    }
    await preflightQuota(store, artifact, state)
    let offset = state.state === "partial" ? state.bytes : 0
    let etag = state.state === "partial" ? state.etag : undefined
    let url = assertRegisteredArtifactInitialUrl(artifact, artifact.url)
    let redirectsFollowed = 0
    let restarted = false

    notifyProgress(options.onProgress, {
        phase: "downloading",
        loadedBytes: offset,
        totalBytes: artifact.bytes,
    })

    if (offset > 0 && offset < artifact.bytes && etag === undefined) {
        await store.remove(artifact.sha256, {
            partial: true,
            verified: false,
        })
        offset = 0
        restarted = true
    }

    while (true) {
        throwIfAborted(signal)
        let hasher = new Sha256()
        if (offset > 0) {
            const partial = await hashPartial(
                store,
                artifact.sha256,
                artifact.bytes,
                signal,
            )
            if (partial.bytes !== offset) {
                if (restarted) throw new Error("Artifact partial changed during resume")
                await store.remove(artifact.sha256, {
                    partial: true,
                    verified: false,
                })
                offset = 0
                etag = undefined
                restarted = true
                url = artifact.url
                redirectsFollowed = 0
                continue
            }
            hasher = partial.hasher
            if (offset === artifact.bytes) {
                notifyProgress(options.onProgress, {
                    phase: "verifying",
                    loadedBytes: offset,
                    totalBytes: artifact.bytes,
                })
                const digest = toHex(await hasher.digest())
                if (digest !== artifact.sha256) {
                    await store.remove(artifact.sha256, {
                        partial: true,
                        verified: false,
                    })
                    offset = 0
                    etag = undefined
                    restarted = true
                    continue
                }
                const writer = await store.beginWrite(artifact.sha256, {
                    expectedBytes: artifact.bytes,
                    ...(etag ? { etag } : {}),
                })
                if (writer.offset !== artifact.bytes) {
                    const mismatch = new Error(
                        "Artifact partial changed before promotion",
                    )
                    await writer.abort({ keepPartial: true }).catch(() => undefined)
                    throw mismatch
                }
                try {
                    notifyProgress(options.onProgress, {
                        phase: "committing",
                        loadedBytes: offset,
                        totalBytes: artifact.bytes,
                    })
                    await commitVerified({ writer, store, digest, signal })
                } catch (error) {
                    await writer.abort({ keepPartial: true }).catch(() => undefined)
                    throw error
                }
                return {
                    state: "verified",
                    bytes: artifact.bytes,
                    resumed: true,
                }
            }
        }

        const requestHeaders: Array<readonly [string, string]> = []
        if (offset > 0) {
            requestHeaders.push(["Range", `bytes=${offset}-`])
            if (etag) requestHeaders.push(["If-Range", etag])
        }
        const response = await transport.request({
            url,
            headers: requestHeaders,
            signal,
            maxBytes: artifact.bytes,
        })
        let responseBodyOwned = response.body !== null
        const releaseResponseBody = async (reason?: unknown) => {
            if (!responseBodyOwned) return
            responseBodyOwned = false
            await cancelBody(response.body, reason)
        }
        try {
            throwIfAborted(signal)

            if (REDIRECT_STATUSES.has(response.status)) {
                const location = header(response.headers, "Location")
                await releaseResponseBody()
                if (!location) throw new Error("Artifact redirect omitted Location")
                url = resolveRegisteredArtifactRedirect({
                    artifact,
                    currentUrl: artifact.url,
                    location,
                    currentHostOrigin: options.currentHostOrigin,
                    redirectsFollowed,
                })
                redirectsFollowed += 1
                continue
            }

            const responseEtag = header(response.headers, "ETag")
            if (offset > 0 && response.status === 206) {
                const contentRange = header(response.headers, "Content-Range")
                const contentLength = header(response.headers, "Content-Length")
                const lengthMatches =
                    contentLength === undefined ||
                    Number(contentLength) === artifact.bytes - offset
                const etagMatches = etag === undefined || responseEtag === etag
                if (
                    !validateContentRange(contentRange, offset, artifact.bytes) ||
                    !lengthMatches ||
                    !etagMatches
                ) {
                    await releaseResponseBody()
                    if (restarted) throw new Error("Artifact resume response is invalid")
                    await store.remove(artifact.sha256, {
                        partial: true,
                        verified: false,
                    })
                    offset = 0
                    etag = undefined
                    restarted = true
                    url = artifact.url
                    redirectsFollowed = 0
                    continue
                }
            } else if (response.status === 200) {
                if (offset > 0) {
                    await store.remove(artifact.sha256, {
                        partial: true,
                        verified: false,
                    })
                    offset = 0
                    etag = undefined
                    restarted = true
                    hasher = new Sha256()
                }
            } else {
                await releaseResponseBody()
                throw new Error(`Artifact transport returned status ${response.status}`)
            }

            if (!response.body) throw new Error("Artifact response body is absent")
            const writer = await store.beginWrite(artifact.sha256, {
                expectedBytes: artifact.bytes,
                ...(responseEtag ? { etag: responseEtag } : etag ? { etag } : {}),
                restart: offset === 0,
            })
            if (writer.offset !== offset) {
                const mismatch = new Error("Artifact partial changed before streaming")
                await writer.abort({ keepPartial: true }).catch(() => undefined)
                throw mismatch
            }
            responseBodyOwned = false
            await streamIntoStore({
                response,
                writer,
                store,
                hasher,
                offset,
                artifact,
                signal,
                onProgress: options.onProgress,
            })
            return {
                state: "verified",
                bytes: artifact.bytes,
                resumed: offset > 0 && !restarted,
            }
        } catch (error) {
            await releaseResponseBody(error)
            throw error
        }
    }
}

function joinShared(
    operation: SharedDownload,
    signal?: AbortSignal,
    observer?: RegisteredArtifactDownloadOptions["onProgress"],
): Promise<RegisteredArtifactDownloadResult> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    const observerId = Symbol("registered-artifact-progress")
    if (observer) {
        operation.observers.set(observerId, observer)
        if (operation.progress) notifyProgress(observer, operation.progress)
    }
    operation.waiters += 1
    return new Promise((resolve, reject) => {
        let detached = false
        const detach = () => {
            if (detached) return
            detached = true
            signal?.removeEventListener("abort", onAbort)
            operation.observers.delete(observerId)
            operation.waiters -= 1
            if (operation.waiters === 0 && !operation.settled) {
                operation.controller.abort()
            }
        }
        const onAbort = () => {
            detach()
            reject(abortReason(signal))
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        operation.promise.then(
            (value) => {
                if (detached) return
                detach()
                resolve(value)
            },
            (error) => {
                if (detached) return
                detach()
                reject(error)
            },
        )
    })
}

export function downloadRegisteredArtifact(
    options: RegisteredArtifactDownloadOptions,
): Promise<RegisteredArtifactDownloadResult> {
    const validator =
        options.assertRegisteredArtifact ?? assertRegisteredPixaiArtifact
    validator(options.artifact)
    assertArtifactDigest(options.artifact.sha256)
    if (
        !Number.isSafeInteger(options.artifact.bytes) ||
        options.artifact.bytes <= 0
    ) {
        return Promise.reject(new Error("Invalid registered artifact size"))
    }
    if (options.signal?.aborted) {
        return Promise.reject(abortReason(options.signal))
    }

    let byDigest = sharedByStore.get(options.store)
    if (!byDigest) {
        byDigest = new Map()
        sharedByStore.set(options.store, byDigest)
    }
    let operation = byDigest.get(options.artifact.sha256)
    if (!operation) {
        operation = {
            controller: new AbortController(),
            observers: new Map(),
            promise: Promise.resolve({
                state: "verified",
                bytes: 0,
                resumed: false,
            }),
            waiters: 0,
            settled: false,
        }
        const current = operation
        current.promise = executeDownload(
            {
                ...options,
                onProgress: (progress) => publishSharedProgress(current, progress),
            },
            current.controller.signal,
        ).finally(() => {
            current.settled = true
            if (byDigest?.get(options.artifact.sha256) === current) {
                byDigest.delete(options.artifact.sha256)
            }
        })
        current.promise.catch(() => undefined)
        byDigest.set(options.artifact.sha256, current)
        operation = current
    }
    return joinShared(operation, options.signal, options.onProgress)
}
