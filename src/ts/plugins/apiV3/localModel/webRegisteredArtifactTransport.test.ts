import { describe, expect, it, vi } from "vitest"
import { MODEL_ARTIFACT_MAX_CHUNK_BYTES } from "./modelArtifactStore"
import {
    PIXAI_PROFILE_ID,
    getPixaiArtifact,
} from "./pixaiRegistry"
import type { RegisteredArtifactRequest } from "./registeredArtifactDownload"
import { createWebRegisteredArtifactTransport } from "./webRegisteredArtifactTransport"

const ARTIFACT = getPixaiArtifact(PIXAI_PROFILE_ID, "model.onnx")

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((next) => {
        resolve = next
    })
    return { promise, resolve }
}

function request(
    overrides: Partial<RegisteredArtifactRequest> = {},
): RegisteredArtifactRequest {
    return {
        url: ARTIFACT.url,
        headers: [],
        signal: new AbortController().signal,
        maxBytes: ARTIFACT.bytes,
        ...overrides,
    }
}

function trackedResponse(options: {
    status?: number
    headers?: Array<readonly [string, string]>
    chunks?: unknown[]
    body?: boolean
    type?: ResponseType
    redirected?: boolean
    url?: string
}) {
    let index = 0
    let cancellations = 0
    let releases = 0
    const reader = {
        read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
            if (index >= (options.chunks?.length ?? 0)) {
                return { done: true, value: undefined }
            }
            return {
                done: false,
                value: options.chunks![index++] as Uint8Array,
            }
        },
        cancel: async () => {
            cancellations += 1
        },
        releaseLock: () => {
            releases += 1
        },
    }
    const response = {
        status: options.status ?? 200,
        headers: new Headers(
            options.headers?.map(([name, value]) => [name, value]),
        ),
        body:
            options.body === false
                ? null
                : { getReader: () => reader },
        type: options.type ?? "basic",
        redirected: options.redirected ?? false,
        url: options.url ?? ARTIFACT.url,
    } as unknown as Response
    return {
        response,
        cancellations: () => cancellations,
        releases: () => releases,
    }
}

async function readAll(body: ReadableStream<Uint8Array>) {
    const chunks: Uint8Array[] = []
    const reader = body.getReader()
    while (true) {
        const item = await reader.read()
        if (item.done) break
        chunks.push(item.value)
    }
    return chunks
}

describe("web registered artifact transport", () => {
    it("uses a credential-free manual GET and bounds pull chunks through EOF", async () => {
        const oversized = new Uint8Array(MODEL_ARTIFACT_MAX_CHUNK_BYTES + 3)
        const tracked = trackedResponse({ chunks: [oversized] })
        const fetchImpl = vi.fn(
            async (_url: RequestInfo | URL, _init?: RequestInit) =>
                tracked.response,
        )
        const transport = createWebRegisteredArtifactTransport({
            fetch: fetchImpl as typeof fetch,
        })

        const result = await transport.request(
            request({
                headers: [
                    ["Range", "bytes=10-"],
                    ["If-Range", '"fixed"'],
                ],
            }),
        )
        const chunks = await readAll(result.body!)

        expect(chunks.map((chunk) => chunk.byteLength)).toEqual([
            MODEL_ARTIFACT_MAX_CHUNK_BYTES,
            3,
        ])
        expect(result).toMatchObject({ status: 200, headers: [] })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        const call = fetchImpl.mock.calls[0]
        expect(call).toBeDefined()
        const [url, init] = call!
        expect(init).toBeDefined()
        const requestInit = init!
        expect(url).toBe(ARTIFACT.url)
        expect(requestInit).toMatchObject({
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            referrerPolicy: "no-referrer",
        })
        expect(Array.from(new Headers(requestInit.headers).entries())).toEqual([
            ["Range", "bytes=10-"],
            ["If-Range", '"fixed"'],
        ])
        expect(requestInit.signal).toBeDefined()
        expect(tracked.cancellations()).toBe(0)
        expect(tracked.releases()).toBe(1)
    })

    it("surfaces only visible redirects and rejects opaque or already-followed responses", async () => {
        const visible = trackedResponse({
            status: 302,
            headers: [["Location", "https://us.aws.cdn.hf.co/xet-bridge-us/a"]],
            body: false,
        })
        const visibleTransport = createWebRegisteredArtifactTransport({
            fetch: (async () => visible.response) as typeof fetch,
        })
        await expect(visibleTransport.request(request())).resolves.toEqual({
            status: 302,
            headers: [
                ["Location", "https://us.aws.cdn.hf.co/xet-bridge-us/a"],
            ],
            body: null,
        })

        for (const hostile of [
            trackedResponse({ type: "opaqueredirect" }),
            trackedResponse({ redirected: true, url: "https://evil.example/file" }),
        ]) {
            const transport = createWebRegisteredArtifactTransport({
                fetch: (async () => hostile.response) as typeof fetch,
            })
            await expect(transport.request(request())).rejects.toThrow()
            expect(hostile.cancellations()).toBe(1)
            expect(hostile.releases()).toBe(1)
        }
    })

    it("rejects non-registered URLs, methods, and request headers before fetch", async () => {
        const fetchImpl = vi.fn(async () => trackedResponse({}).response)
        const transport = createWebRegisteredArtifactTransport({
            fetch: fetchImpl as typeof fetch,
        })
        const invalid = [
            { ...request(), url: "https://evil.example/model.onnx" },
            { ...request(), method: "POST" },
            { ...request(), headers: [["Authorization", "secret"]] },
            {
                ...request(),
                headers: [
                    ["Range", "bytes=0-"],
                    ["range", "bytes=1-"],
                ],
            },
            { ...request(), headers: [["If-Range", "x\r\ny"]] },
        ]
        for (const candidate of invalid) {
            await expect(
                transport.request(candidate as RegisteredArtifactRequest),
            ).rejects.toThrow()
        }
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it("rejects an already-aborted request before opening fetch", async () => {
        const controller = new AbortController()
        controller.abort()
        const fetchImpl = vi.fn(async () => trackedResponse({}).response)
        const transport = createWebRegisteredArtifactTransport({
            fetch: fetchImpl as typeof fetch,
        })

        await expect(
            transport.request(request({ signal: controller.signal })),
        ).rejects.toThrow()
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it("fails closed on missing bodies, hostile status, and oversized response headers", async () => {
        for (const tracked of [
            trackedResponse({ status: 200, body: false }),
            trackedResponse({ status: 201 }),
            trackedResponse({ headers: [["ETag", "x".repeat(4_097)]] }),
        ]) {
            const transport = createWebRegisteredArtifactTransport({
                fetch: (async () => tracked.response) as typeof fetch,
            })
            await expect(transport.request(request())).rejects.toThrow()
        }
    })

    it("cancels an owned response exactly once when abort wins open", async () => {
        const gate = deferred<Response>()
        const controller = new AbortController()
        const tracked = trackedResponse({})
        const transport = createWebRegisteredArtifactTransport({
            fetch: (async () => gate.promise) as typeof fetch,
        })
        const pending = transport.request(request({ signal: controller.signal }))

        controller.abort()
        gate.resolve(tracked.response)
        await expect(pending).rejects.toThrow()
        expect(tracked.cancellations()).toBe(1)
        expect(tracked.releases()).toBe(1)
    })

    it("aborts a pending read and ignores repeated stream cancellation", async () => {
        const readGate = deferred<ReadableStreamReadResult<Uint8Array>>()
        let cancellations = 0
        let releases = 0
        const response = {
            status: 206,
            headers: new Headers([
                ["Content-Range", `bytes 1-${ARTIFACT.bytes - 1}/${ARTIFACT.bytes}`],
            ]),
            body: {
                getReader: () => ({
                    read: () => readGate.promise,
                    cancel: async () => {
                        cancellations += 1
                    },
                    releaseLock: () => {
                        releases += 1
                    },
                }),
            },
            type: "basic",
            redirected: false,
            url: ARTIFACT.url,
        } as unknown as Response
        const controller = new AbortController()
        const transport = createWebRegisteredArtifactTransport({
            fetch: (async () => response) as typeof fetch,
        })
        const opened = await transport.request(
            request({
                signal: controller.signal,
                headers: [["Range", "bytes=1-"]],
            }),
        )
        const reader = opened.body!.getReader()
        const pending = reader.read()

        controller.abort()
        readGate.resolve({ done: true, value: undefined })
        await expect(pending).rejects.toThrow()
        await reader.cancel().catch(() => undefined)
        expect(cancellations).toBe(1)
        expect(releases).toBe(1)
    })
})
