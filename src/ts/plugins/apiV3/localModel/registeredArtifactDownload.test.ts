import { describe, expect, it, vi } from "vitest"
import type {
    ArtifactStat,
    ModelArtifactStore,
    ModelArtifactWriteHandle,
} from "./modelArtifactStore"
import type { RegisteredModelArtifact } from "./pixaiRegistry"
import {
    downloadRegisteredArtifact,
    type RegisteredArtifactDownloadProgress,
    type RegisteredArtifactRequest,
    type RegisteredArtifactResponse,
    type RegisteredArtifactTransport,
} from "./registeredArtifactDownload"
import {
    TINY_ARTIFACT,
    tinyArtifactBytes,
} from "./fixtures/tinyArtifact"

type Entry = { bytes: Uint8Array; etag?: string; verified: boolean }

class MemoryArtifactStore implements ModelArtifactStore {
    readonly kind = "opfs" as const
    readonly supportsResume = true
    readonly entries = new Map<string, Entry>()
    estimateValue: Awaited<ReturnType<ModelArtifactStore["estimate"]>> = {
        persistent: true,
    }
    readChunkRequests: number[] = []
    maxWrittenChunk = 0
    activeWriters = 0

    estimate() {
        return Promise.resolve(this.estimateValue)
    }

    async stat(digest: string): Promise<ArtifactStat> {
        const entry = this.entries.get(digest)
        if (!entry) return { state: "absent", bytes: 0 }
        return {
            state: entry.verified ? "verified" : "partial",
            bytes: entry.bytes.byteLength,
            ...(entry.etag ? { etag: entry.etag } : {}),
        }
    }

    async beginWrite(
        digest: string,
        metadata: {
            expectedBytes: number
            etag?: string
            restart?: boolean
        },
    ): Promise<ModelArtifactWriteHandle> {
        if (metadata.restart) this.entries.delete(digest)
        const prior = this.entries.get(digest)
        const entry: Entry = {
            bytes: prior?.bytes.slice() ?? new Uint8Array(),
            etag: metadata.etag,
            verified: false,
        }
        this.entries.set(digest, entry)
        this.activeWriters += 1
        let closed = false
        const close = () => {
            if (closed) return
            closed = true
            this.activeWriters -= 1
        }
        return {
            offset: entry.bytes.byteLength,
            write: async (chunk) => {
                this.maxWrittenChunk = Math.max(
                    this.maxWrittenChunk,
                    chunk.byteLength,
                )
                const next = new Uint8Array(
                    entry.bytes.byteLength + chunk.byteLength,
                )
                next.set(entry.bytes)
                next.set(chunk.slice(), entry.bytes.byteLength)
                entry.bytes = next
            },
            commit: async (verifiedSha256) => {
                if (verifiedSha256 !== digest) throw new Error("wrong digest")
                if (entry.bytes.byteLength !== metadata.expectedBytes) {
                    throw new Error("wrong size")
                }
                entry.verified = true
                close()
            },
            abort: async ({ keepPartial }) => {
                if (!keepPartial) this.entries.delete(digest)
                close()
            },
        }
    }

    async *readPartial(
        digest: string,
        options: { chunkSize: number },
    ): AsyncIterable<Uint8Array> {
        this.readChunkRequests.push(options.chunkSize)
        const snapshot = this.entries.get(digest)?.bytes.slice() ?? new Uint8Array()
        for (let offset = 0; offset < snapshot.byteLength; offset += options.chunkSize) {
            yield snapshot.slice(offset, offset + options.chunkSize)
        }
    }

    async openVerified(): Promise<never> {
        throw new Error("not needed by downloader tests")
    }

    async remove(
        digest: string,
        options: { partial: boolean; verified: boolean },
    ): Promise<void> {
        const entry = this.entries.get(digest)
        if (!entry) return
        if ((entry.verified && options.verified) || (!entry.verified && options.partial)) {
            this.entries.delete(digest)
        }
    }

    setPartial(
        artifact: Readonly<RegisteredModelArtifact>,
        bytes: Uint8Array,
        etag?: string,
    ): void {
        this.entries.set(artifact.sha256, {
            bytes: bytes.slice(),
            etag,
            verified: false,
        })
    }
}

function body(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk.slice())
            controller.close()
        },
    })
}

function trackedBody(options: { cancelError?: Error } = {}): {
    body: ReadableStream<Uint8Array>
    cancellations(): number
} {
    let cancellations = 0
    return {
        body: new ReadableStream<Uint8Array>({
            cancel() {
                cancellations += 1
                if (options.cancelError) throw options.cancelError
            },
        }),
        cancellations: () => cancellations,
    }
}

function response(
    status: number,
    chunks: Uint8Array[] | null,
    headers: Array<readonly [string, string]> = [],
): RegisteredArtifactResponse {
    return { status, headers, body: chunks ? body(chunks) : null }
}

function fixtureValidator(candidate: Readonly<RegisteredModelArtifact>): void {
    if (candidate !== TINY_ARTIFACT) throw new Error("unregistered fixture")
}

function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
        chunks.push(bytes.slice(offset, offset + size))
    }
    return chunks
}

function deferred<T>(): {
    promise: Promise<T>
    resolve(value: T | PromiseLike<T>): void
} {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((next) => {
        resolve = next
    })
    return { promise, resolve }
}

class GatedArtifactStore extends MemoryArtifactStore {
    delayBegin = false
    delayCommit = false
    readonly beginStarted = deferred<void>()
    readonly releaseBegin = deferred<void>()
    readonly commitStarted = deferred<void>()
    readonly releaseCommit = deferred<void>()
    readonly terminal = deferred<"committed" | "partial" | "removed">()

    override async beginWrite(
        digest: string,
        metadata: Parameters<ModelArtifactStore["beginWrite"]>[1],
    ): Promise<ModelArtifactWriteHandle> {
        this.beginStarted.resolve(undefined)
        if (this.delayBegin) await this.releaseBegin.promise
        const handle = await super.beginWrite(digest, metadata)
        return {
            offset: handle.offset,
            write: (chunk) => handle.write(chunk),
            commit: async (verifiedSha256) => {
                this.commitStarted.resolve(undefined)
                if (this.delayCommit) await this.releaseCommit.promise
                await handle.commit(verifiedSha256)
                this.terminal.resolve("committed")
            },
            abort: async (abortOptions) => {
                await handle.abort(abortOptions)
                this.terminal.resolve(
                    abortOptions.keepPartial ? "partial" : "removed",
                )
            },
        }
    }
}

class FailingBeginArtifactStore extends MemoryArtifactStore {
    override async beginWrite(): Promise<never> {
        throw new Error("beginWrite failed")
    }
}

class FailingAbortArtifactStore extends MemoryArtifactStore {
    abortCalls = 0

    override async beginWrite(
        digest: string,
        metadata: Parameters<ModelArtifactStore["beginWrite"]>[1],
    ): Promise<ModelArtifactWriteHandle> {
        const handle = await super.beginWrite(digest, metadata)
        return {
            offset: handle.offset,
            write: (chunk) => handle.write(chunk),
            commit: (verifiedSha256) => handle.commit(verifiedSha256),
            abort: async (abortOptions) => {
                this.abortCalls += 1
                await handle.abort(abortOptions)
                throw new Error("writer cleanup failed")
            },
        }
    }
}

class MismatchedOffsetArtifactStore extends FailingAbortArtifactStore {
    override async beginWrite(
        digest: string,
        metadata: Parameters<ModelArtifactStore["beginWrite"]>[1],
    ): Promise<ModelArtifactWriteHandle> {
        const handle = await super.beginWrite(digest, metadata)
        return { ...handle, offset: handle.offset + 1 }
    }
}

function options(
    store: MemoryArtifactStore,
    transport: RegisteredArtifactTransport,
    extra: Record<string, unknown> = {},
) {
    return {
        artifact: TINY_ARTIFACT,
        store,
        transport,
        assertRegisteredArtifact: fixtureValidator,
        ...extra,
    }
}

describe("registered artifact download", () => {
    it("streams and verifies a fresh 200 response", async () => {
        const store = new MemoryArtifactStore()
        const requests: RegisteredArtifactRequest[] = []
        const transport: RegisteredArtifactTransport = {
            request: async (request) => {
                requests.push(request)
                return response(200, chunksOf(tinyArtifactBytes(), 13), [
                    ["ETag", '"tiny"'],
                ])
            },
        }

        expect(await downloadRegisteredArtifact(options(store, transport))).toEqual({
            state: "verified",
            bytes: 130,
            resumed: false,
        })
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
            url: TINY_ARTIFACT.url,
            headers: [],
            maxBytes: 130,
        })
        expect(store.entries.get(TINY_ARTIFACT.sha256)?.bytes).toEqual(
            tinyArtifactBytes(),
        )
        expect(store.maxWrittenChunk).toBe(13)
        expect(store.activeWriters).toBe(0)
    })

    it("reports exact download bytes before verification", async () => {
        const store = new MemoryArtifactStore()
        const progress: Array<{
            phase: "downloading" | "verifying" | "committing"
            loadedBytes: number
            totalBytes: number
        }> = []

        await downloadRegisteredArtifact(
            options(
                store,
                {
                    request: async () =>
                        response(200, chunksOf(tinyArtifactBytes(), 50)),
                },
                {
                    onProgress: (update: (typeof progress)[number]) => {
                        progress.push(update)
                        throw new Error("observer failed")
                    },
                },
            ),
        )

        expect(progress).toContainEqual({
            phase: "downloading",
            loadedBytes: 130,
            totalBytes: 130,
        })
        expect(progress).toContainEqual({
            phase: "verifying",
            loadedBytes: 130,
            totalBytes: 130,
        })
    })

    it("accepts an exact 1 MiB incoming chunk", async () => {
        const store = new MemoryArtifactStore()
        const bytes = new Uint8Array(1_048_576)
        const artifact = Object.freeze({
            ...TINY_ARTIFACT,
            bytes: bytes.byteLength,
            sha256:
                "30e14955ebf1352266dc2ff8067e68104607e750abb9d3b36582b8af909fcb58",
        })

        await expect(
            downloadRegisteredArtifact({
                artifact,
                store,
                assertRegisteredArtifact: () => undefined,
                transport: {
                    request: async () => response(200, [bytes]),
                },
            }),
        ).resolves.toEqual({
            state: "verified",
            bytes: 1_048_576,
            resumed: false,
        })
        expect(store.maxWrittenChunk).toBe(1_048_576)
    })

    it("rejects an oversized incoming chunk before copying or writing it", async () => {
        const store = new MemoryArtifactStore()
        const oversized = new Uint8Array(1_048_577)
        const originalSlice = oversized.slice.bind(oversized)
        let copied = false
        Object.defineProperty(oversized, "slice", {
            value: (start?: number, end?: number) => {
                copied = true
                return originalSlice(start, end)
            },
        })
        const artifact = Object.freeze({
            ...TINY_ARTIFACT,
            bytes: oversized.byteLength,
            sha256: "0".repeat(64),
        })

        await expect(
            downloadRegisteredArtifact({
                artifact,
                store,
                assertRegisteredArtifact: () => undefined,
                transport: {
                    request: async () => ({
                        status: 200,
                        headers: [],
                        body: new ReadableStream<Uint8Array>({
                            start(controller) {
                                controller.enqueue(oversized)
                                controller.close()
                            },
                        }),
                    }),
                },
            }),
        ).rejects.toThrow(/chunk.*maximum/i)
        expect(copied).toBe(false)
        expect(store.maxWrittenChunk).toBe(0)
        expect(store.activeWriters).toBe(0)
    })

    it("rehashes a partial in chunks and resumes with Range and If-Range", async () => {
        const store = new MemoryArtifactStore()
        const bytes = tinyArtifactBytes()
        store.setPartial(TINY_ARTIFACT, bytes.slice(0, 50), '"tiny"')
        const requests: RegisteredArtifactRequest[] = []
        const transport: RegisteredArtifactTransport = {
            request: async (request) => {
                requests.push(request)
                return response(206, chunksOf(bytes.slice(50), 17), [
                    ["Content-Range", "bytes 50-129/130"],
                    ["ETag", '"tiny"'],
                ])
            },
        }

        expect(await downloadRegisteredArtifact(options(store, transport))).toEqual({
            state: "verified",
            bytes: 130,
            resumed: true,
        })
        expect(requests[0].headers).toEqual([
            ["Range", "bytes=50-"],
            ["If-Range", '"tiny"'],
        ])
        expect(requests[0].maxBytes).toBe(130)
        expect(store.readChunkRequests).toEqual([1_048_576])
        expect(store.maxWrittenChunk).toBeLessThanOrEqual(17)
        expect(store.entries.get(TINY_ARTIFACT.sha256)?.bytes).toEqual(bytes)
    })

    it("discards a mismatched range and retries once from zero", async () => {
        const store = new MemoryArtifactStore()
        const bytes = tinyArtifactBytes()
        store.setPartial(TINY_ARTIFACT, bytes.slice(0, 50), '"tiny"')
        const requests: RegisteredArtifactRequest[] = []
        const responses = [
            response(206, [bytes.slice(50)], [
                ["Content-Range", "bytes 49-128/130"],
                ["ETag", '"tiny"'],
            ]),
            response(200, chunksOf(bytes, 29), [["ETag", '"new"']]),
        ]
        const transport: RegisteredArtifactTransport = {
            request: async (request) => {
                requests.push(request)
                return responses.shift()!
            },
        }

        expect(await downloadRegisteredArtifact(options(store, transport))).toEqual({
            state: "verified",
            bytes: 130,
            resumed: false,
        })
        expect(requests).toHaveLength(2)
        expect(requests[0].headers[0]).toEqual(["Range", "bytes=50-"])
        expect(requests[1].headers).toEqual([])
    })

    it("restarts an unvalidated partial instead of sending Range without If-Range", async () => {
        const store = new MemoryArtifactStore()
        const bytes = tinyArtifactBytes()
        store.setPartial(TINY_ARTIFACT, bytes.slice(0, 50))
        const requests: RegisteredArtifactRequest[] = []
        const transport: RegisteredArtifactTransport = {
            request: async (request) => {
                requests.push(request)
                return response(200, [bytes], [["ETag", '"fresh"']])
            },
        }

        await expect(
            downloadRegisteredArtifact(options(store, transport)),
        ).resolves.toEqual({ state: "verified", bytes: 130, resumed: false })
        expect(requests).toHaveLength(1)
        expect(requests[0].headers).toEqual([])
    })

    it("never promotes under-size, over-size, wrong-digest, or invalid responses", async () => {
        const bytes = tinyArtifactBytes()
        const wrong = bytes.slice()
        wrong[0] ^= 1
        const cases: Array<{
            name: string
            response: RegisteredArtifactResponse
            expectedState: "partial" | "absent"
        }> = [
            {
                name: "under-size",
                response: response(200, [bytes.slice(0, 100)], [
                    ["ETag", '"partial"'],
                ]),
                expectedState: "partial",
            },
            {
                name: "over-size",
                response: response(200, [bytes, new Uint8Array([1])]),
                expectedState: "absent",
            },
            {
                name: "wrong digest",
                response: response(200, [wrong]),
                expectedState: "absent",
            },
            {
                name: "absent body",
                response: response(200, null),
                expectedState: "absent",
            },
            {
                name: "error status",
                response: response(503, null),
                expectedState: "absent",
            },
        ]

        for (const item of cases) {
            const store = new MemoryArtifactStore()
            await expect(
                downloadRegisteredArtifact(
                    options(store, {
                        request: async () => item.response,
                    }),
                ),
                item.name,
            ).rejects.toThrow()
            expect((await store.stat(TINY_ARTIFACT.sha256)).state).toBe(
                item.expectedState,
            )
            expect(store.activeWriters).toBe(0)
        }
    })

    it("cancels a response body returned after the last waiter aborts", async () => {
        const store = new MemoryArtifactStore()
        const controller = new AbortController()
        const tracked = trackedBody()
        const download = downloadRegisteredArtifact(
            options(
                store,
                {
                    request: async () => {
                        controller.abort()
                        return { status: 200, headers: [], body: tracked.body }
                    },
                },
                { signal: controller.signal },
            ),
        )

        await expect(download).rejects.toThrow()
        await vi.waitFor(() => expect(tracked.cancellations()).toBe(1))
    })

    it("cancels unclaimed bodies without masking duplicate-header errors", async () => {
        const tracked = trackedBody({
            cancelError: new Error("body cleanup failed"),
        })
        await expect(
            downloadRegisteredArtifact(
                options(new MemoryArtifactStore(), {
                    request: async () => ({
                        status: 200,
                        headers: [
                            ["ETag", '"one"'],
                            ["etag", '"two"'],
                        ],
                        body: tracked.body,
                    }),
                }),
            ),
        ).rejects.toThrow(/duplicate etag/i)
        expect(tracked.cancellations()).toBe(1)
    })

    it("cancels the response body when beginWrite fails without masking that failure", async () => {
        const tracked = trackedBody({
            cancelError: new Error("body cleanup failed"),
        })
        await expect(
            downloadRegisteredArtifact(
                options(new FailingBeginArtifactStore(), {
                    request: async () => ({
                        status: 200,
                        headers: [],
                        body: tracked.body,
                    }),
                }),
            ),
        ).rejects.toThrow(/beginWrite failed/i)
        expect(tracked.cancellations()).toBe(1)
    })

    it("aborts an acquired writer when reader acquisition fails without masking the primary error", async () => {
        const store = new FailingAbortArtifactStore()
        const lockedBody = new ReadableStream<Uint8Array>()
        const externalReader = lockedBody.getReader()
        try {
            await expect(
                downloadRegisteredArtifact(
                    options(store, {
                        request: async () => ({
                            status: 200,
                            headers: [],
                            body: lockedBody,
                        }),
                    }),
                ),
            ).rejects.toThrow(/locked|reader/i)
            expect(store.activeWriters).toBe(0)
            expect(await store.stat(TINY_ARTIFACT.sha256)).toEqual({
                state: "absent",
                bytes: 0,
            })
        } finally {
            externalReader.releaseLock()
            await lockedBody.cancel().catch(() => undefined)
        }
    })

    it("keeps offset mismatch primary while writer and response cleanup fail", async () => {
        const store = new MismatchedOffsetArtifactStore()
        const tracked = trackedBody({
            cancelError: new Error("body cleanup failed"),
        })
        await expect(
            downloadRegisteredArtifact(
                options(store, {
                    request: async () => ({
                        status: 200,
                        headers: [],
                        body: tracked.body,
                    }),
                }),
            ),
        ).rejects.toThrow(/partial changed before streaming/i)
        expect(store.activeWriters).toBe(0)
        expect(tracked.cancellations()).toBe(1)
    })

    it("keeps complete-partial promotion mismatch primary when writer cleanup fails", async () => {
        const store = new MismatchedOffsetArtifactStore()
        store.setPartial(TINY_ARTIFACT, tinyArtifactBytes(), '"tiny"')

        await expect(
            downloadRegisteredArtifact(
                options(store, {
                    request: async () => {
                        throw new Error("transport must not run")
                    },
                }),
            ),
        ).rejects.toThrow(/partial changed before promotion/i)
        expect(store.abortCalls).toBe(1)
        expect(store.activeWriters).toBe(0)
    })

    it("checks every redirect against the reviewed one-hop policy", async () => {
        const store = new MemoryArtifactStore()
        const requests: RegisteredArtifactRequest[] = []
        const accepted = [
            response(302, null, [
                [
                    "Location",
                    "https://chat.example/api/resolve-cache/tiny/model.onnx",
                ],
            ]),
            response(200, [tinyArtifactBytes()]),
        ]
        const transport: RegisteredArtifactTransport = {
            request: async (request) => {
                requests.push(request)
                return accepted.shift()!
            },
        }
        await downloadRegisteredArtifact(
            options(store, transport, {
                currentHostOrigin: "https://chat.example",
            }),
        )
        expect(requests.map((request) => request.url)).toEqual([
            TINY_ARTIFACT.url,
            "https://chat.example/api/resolve-cache/tiny/model.onnx",
        ])

        let calls = 0
        await expect(
            downloadRegisteredArtifact(
                options(new MemoryArtifactStore(), {
                    request: async () => {
                        calls += 1
                        return response(302, null, [
                            ["Location", "https://evil.example/model.onnx"],
                        ])
                    },
                }),
            ),
        ).rejects.toThrow()
        expect(calls).toBe(1)
    })

    it("rejects known insufficient quota before opening transport while unknown quota proceeds", async () => {
        const insufficient = new MemoryArtifactStore()
        insufficient.estimateValue = {
            usageBytes: 900,
            quotaBytes: 1_000,
            persistent: true,
        }
        let calls = 0
        const transport: RegisteredArtifactTransport = {
            request: async () => {
                calls += 1
                return response(200, [tinyArtifactBytes()])
            },
        }
        await expect(
            downloadRegisteredArtifact(options(insufficient, transport)),
        ).rejects.toThrow(/quota/i)
        expect(calls).toBe(0)

        const unknown = new MemoryArtifactStore()
        await expect(
            downloadRegisteredArtifact(options(unknown, transport)),
        ).resolves.toMatchObject({ state: "verified" })
        expect(calls).toBe(1)
    })

    it("deduplicates same-digest work and detaches one cancelled waiter", async () => {
        const store = new MemoryArtifactStore()
        const bytes = tinyArtifactBytes()
        let streamController!: ReadableStreamDefaultController<Uint8Array>
        let underlyingSignal!: AbortSignal
        let calls = 0
        const firstProgress: RegisteredArtifactDownloadProgress[] = []
        const secondProgress: RegisteredArtifactDownloadProgress[] = []
        const started = deferred<void>()
        const transport: RegisteredArtifactTransport = {
            request: async (request) => {
                calls += 1
                underlyingSignal = request.signal
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        streamController = controller
                        controller.enqueue(bytes.slice(0, 20))
                        started.resolve(undefined)
                    },
                })
                return { status: 200, headers: [], body: stream }
            },
        }
        const firstAbort = new AbortController()
        const secondAbort = new AbortController()
        const first = downloadRegisteredArtifact(
            options(store, transport, {
                signal: firstAbort.signal,
                onProgress: (progress: RegisteredArtifactDownloadProgress) =>
                    firstProgress.push(progress),
            }),
        )
        const second = downloadRegisteredArtifact(
            options(store, transport, {
                signal: secondAbort.signal,
                onProgress: (progress: RegisteredArtifactDownloadProgress) =>
                    secondProgress.push(progress),
            }),
        )
        await started.promise
        const firstUpdatesBeforeAbort = firstProgress.length
        firstAbort.abort()
        await expect(first).rejects.toThrow()
        expect(underlyingSignal.aborted).toBe(false)
        streamController.enqueue(bytes.slice(20))
        streamController.close()
        await expect(second).resolves.toMatchObject({ state: "verified" })
        expect(firstProgress).toHaveLength(firstUpdatesBeforeAbort)
        expect(secondProgress).toContainEqual({
            phase: "verifying",
            loadedBytes: 130,
            totalBytes: 130,
        })
        expect(calls).toBe(1)
        expect(store.activeWriters).toBe(0)
    })

    it("aborts underlying work only after the last waiter cancels", async () => {
        const store = new MemoryArtifactStore()
        const started = deferred<void>()
        let underlyingSignal!: AbortSignal
        const transport: RegisteredArtifactTransport = {
            request: async (request) => {
                underlyingSignal = request.signal
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(tinyArtifactBytes().slice(0, 20))
                        request.signal.addEventListener("abort", () => {
                            controller.error(request.signal.reason)
                        })
                        started.resolve(undefined)
                    },
                })
                return { status: 200, headers: [], body: stream }
            },
        }
        const a = new AbortController()
        const b = new AbortController()
        const one = downloadRegisteredArtifact(
            options(store, transport, { signal: a.signal }),
        )
        const two = downloadRegisteredArtifact(
            options(store, transport, { signal: b.signal }),
        )
        await started.promise
        a.abort()
        await expect(one).rejects.toThrow()
        expect(underlyingSignal.aborted).toBe(false)
        b.abort()
        await expect(two).rejects.toThrow()
        expect(underlyingSignal.aborted).toBe(true)
        await vi.waitFor(() => expect(store.activeWriters).toBe(0))
        expect((await store.stat(TINY_ARTIFACT.sha256)).state).toBe("partial")
    })

    it("does not promote a complete partial when the last waiter cancels during beginWrite", async () => {
        const store = new GatedArtifactStore()
        store.delayBegin = true
        store.setPartial(TINY_ARTIFACT, tinyArtifactBytes(), '"tiny"')
        const controller = new AbortController()
        const download = downloadRegisteredArtifact(
            options(
                store,
                {
                    request: async () => {
                        throw new Error("transport must not run")
                    },
                },
                { signal: controller.signal },
            ),
        )

        await store.beginStarted.promise
        controller.abort()
        await expect(download).rejects.toThrow()
        store.releaseBegin.resolve(undefined)

        expect(await store.terminal.promise).toBe("partial")
        expect(await store.stat(TINY_ARTIFACT.sha256)).toMatchObject({
            state: "partial",
            bytes: 130,
        })
        expect(store.activeWriters).toBe(0)
    })

    it("rolls back verification when the last waiter cancels during commit", async () => {
        const store = new GatedArtifactStore()
        store.delayCommit = true
        const controller = new AbortController()
        const download = downloadRegisteredArtifact(
            options(
                store,
                {
                    request: async () =>
                        response(200, chunksOf(tinyArtifactBytes(), 19), [
                            ["ETag", '"tiny"'],
                        ]),
                },
                { signal: controller.signal },
            ),
        )

        await store.commitStarted.promise
        controller.abort()
        await expect(download).rejects.toThrow()
        store.releaseCommit.resolve(undefined)
        expect(await store.terminal.promise).toBe("committed")

        await vi.waitFor(async () => {
            expect(await store.stat(TINY_ARTIFACT.sha256)).toEqual({
                state: "absent",
                bytes: 0,
            })
        })
        expect(store.activeWriters).toBe(0)
    })

    it("keeps different digests independent", async () => {
        const store = new MemoryArtifactStore()
        const second = Object.freeze({
            ...TINY_ARTIFACT,
            sha256: "0".repeat(64),
            url: TINY_ARTIFACT.url.replace("mul_1.onnx", "mul_2.onnx"),
        })
        const accepted = new Set<Readonly<RegisteredModelArtifact>>([
            TINY_ARTIFACT,
            second,
        ])
        const signals = new Map<string, AbortSignal>()
        const started = deferred<void>()
        let starts = 0
        const transport: RegisteredArtifactTransport = {
            request: async (request) => {
                signals.set(request.url, request.signal)
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        request.signal.addEventListener("abort", () =>
                            controller.error(request.signal.reason),
                        )
                        starts += 1
                        if (starts === 2) started.resolve(undefined)
                    },
                })
                return { status: 200, headers: [], body: stream }
            },
        }
        const a = new AbortController()
        const b = new AbortController()
        const one = downloadRegisteredArtifact({
            ...options(store, transport, { signal: a.signal }),
            assertRegisteredArtifact: (candidate) => {
                if (!accepted.has(candidate)) throw new Error("unregistered")
            },
        })
        const two = downloadRegisteredArtifact({
            ...options(store, transport, { signal: b.signal }),
            artifact: second,
            assertRegisteredArtifact: (candidate) => {
                if (!accepted.has(candidate)) throw new Error("unregistered")
            },
        })
        await started.promise
        a.abort()
        await expect(one).rejects.toThrow()
        expect(signals.get(second.url)?.aborted).toBe(false)
        b.abort()
        await expect(two).rejects.toThrow()
        expect(signals.size).toBe(2)
    })
})
