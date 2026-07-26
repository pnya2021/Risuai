import { describe, expect, it, vi } from "vitest"
import { MODEL_ARTIFACT_MAX_CHUNK_BYTES } from "./modelArtifactStore"
import {
    PIXAI_PROFILE_ID,
    getPixaiArtifact,
} from "./pixaiRegistry"
import type { RegisteredArtifactRequest } from "./registeredArtifactDownload"
import {
    createTauriRegisteredArtifactTransport,
    type TauriArtifactInvoke,
} from "./tauriRegisteredArtifactTransport"

const ARTIFACT = getPixaiArtifact(PIXAI_PROFILE_ID, "preprocess.json")

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

describe("tauri registered artifact transport", () => {
    it("uses only the four fixed commands and validates projected response values", async () => {
        const calls: Array<{ command: string; args: unknown }> = []
        const invoke: TauriArtifactInvoke = async (command, args) => {
            calls.push({ command, args })
            if (command === "open_model_artifact_fetch") {
                return {
                    handle: "opaque-handle",
                    status: 206,
                    headers: [
                        ["ETag", '"fixed"'],
                        ["Content-Length", "3"],
                    ],
                }
            }
            if (command === "read_model_artifact_fetch") {
                return calls.filter(
                    (call) => call.command === "read_model_artifact_fetch",
                ).length === 1
                    ? { done: false, chunk: [1, 2, 3] }
                    : { done: true, chunk: [] }
            }
            if (command === "close_model_artifact_fetch") return true
            throw new Error(`unexpected command: ${command}`)
        }
        const transport = createTauriRegisteredArtifactTransport({
            invoke,
            createRequestId: () => "request-1",
        })

        const opened = await transport.request(
            request({
                headers: [
                    ["Range", "bytes=1-"],
                    ["If-Range", '"fixed"'],
                ],
            }),
        )
        expect(await readAll(opened.body!)).toEqual([new Uint8Array([1, 2, 3])])
        expect(opened).toMatchObject({
            status: 206,
            headers: [
                ["ETag", '"fixed"'],
                ["Content-Length", "3"],
            ],
        })
        expect(calls).toEqual([
            {
                command: "open_model_artifact_fetch",
                args: {
                    requestId: "request-1",
                    url: ARTIFACT.url,
                    headers: [
                        ["Range", "bytes=1-"],
                        ["If-Range", '"fixed"'],
                    ],
                    maxBytes: ARTIFACT.bytes,
                },
            },
            {
                command: "read_model_artifact_fetch",
                args: {
                    handle: "opaque-handle",
                    maxBytes: MODEL_ARTIFACT_MAX_CHUNK_BYTES,
                },
            },
            {
                command: "read_model_artifact_fetch",
                args: {
                    handle: "opaque-handle",
                    maxBytes: MODEL_ARTIFACT_MAX_CHUNK_BYTES,
                },
            },
            {
                command: "close_model_artifact_fetch",
                args: { handle: "opaque-handle" },
            },
        ])
    })

    it("surfaces redirects without allocating a body handle", async () => {
        const invoke = vi.fn(async () => ({
            handle: null,
            status: 302,
            headers: [["Location", "https://us.aws.cdn.hf.co/xet-bridge-us/a"]],
        }))
        const transport = createTauriRegisteredArtifactTransport({
            invoke: invoke as TauriArtifactInvoke,
            createRequestId: () => "request-redirect",
        })

        await expect(transport.request(request())).resolves.toEqual({
            status: 302,
            headers: [
                ["Location", "https://us.aws.cdn.hf.co/xet-bridge-us/a"],
            ],
            body: null,
        })
        expect(invoke).toHaveBeenCalledTimes(1)
    })

    it("rejects an already-aborted request before invoking the bridge", async () => {
        const controller = new AbortController()
        controller.abort()
        const invoke = vi.fn(async () => {
            throw new Error("bridge must not run")
        })
        const transport = createTauriRegisteredArtifactTransport({
            invoke: invoke as TauriArtifactInvoke,
            createRequestId: () => "request-aborted",
        })

        await expect(
            transport.request(request({ signal: controller.signal })),
        ).rejects.toThrow()
        expect(invoke).not.toHaveBeenCalled()
    })

    it("rejects request accessors without reading them or invoking the bridge", async () => {
        let reads = 0
        const candidate = {} as RegisteredArtifactRequest
        for (const [key, value] of Object.entries(request())) {
            Object.defineProperty(candidate, key, {
                enumerable: true,
                get: () => {
                    reads += 1
                    return value
                },
            })
        }
        const invoke = vi.fn(async () => {
            throw new Error("bridge must not run")
        })
        const transport = createTauriRegisteredArtifactTransport({
            invoke: invoke as TauriArtifactInvoke,
            createRequestId: () => "request-accessor",
        })

        await expect(transport.request(candidate)).rejects.toThrow(/request|data|accessor/i)
        expect(reads).toBe(0)
        expect(invoke).not.toHaveBeenCalled()
    })

    it("cancels both sides of an abort racing open without exposing the handle", async () => {
        const gate = deferred<unknown>()
        const calls: Array<{ command: string; args: unknown }> = []
        const invoke: TauriArtifactInvoke = async (command, args) => {
            calls.push({ command, args })
            if (command === "open_model_artifact_fetch") return gate.promise
            if (command === "cancel_model_artifact_fetch") return true
            throw new Error(`unexpected command: ${command}`)
        }
        const controller = new AbortController()
        const transport = createTauriRegisteredArtifactTransport({
            invoke,
            createRequestId: () => "request-race",
        })
        const pending = transport.request(request({ signal: controller.signal }))
        const abortFailure = new Error("open aborted")

        controller.abort(abortFailure)
        gate.resolve({
            handle: "<opening>",
            status: 200,
            headers: [],
        })
        await expect(pending).rejects.toBe(abortFailure)
        expect(calls).toEqual([
            {
                command: "open_model_artifact_fetch",
                args: {
                    requestId: "request-race",
                    url: ARTIFACT.url,
                    headers: [],
                    maxBytes: ARTIFACT.bytes,
                },
            },
            {
                command: "cancel_model_artifact_fetch",
                args: { requestId: "request-race", handle: null },
            },
            {
                command: "cancel_model_artifact_fetch",
                args: { requestId: "request-race", handle: "<opening>" },
            },
        ])
    })

    it("cancels once when abort wins read and ignores repeated stream cancellation", async () => {
        const readGate = deferred<unknown>()
        const calls: string[] = []
        const invoke: TauriArtifactInvoke = async (command) => {
            calls.push(command)
            if (command === "open_model_artifact_fetch") {
                return { handle: "read-handle", status: 200, headers: [] }
            }
            if (command === "read_model_artifact_fetch") return readGate.promise
            if (command === "cancel_model_artifact_fetch") return true
            throw new Error(`unexpected command: ${command}`)
        }
        const controller = new AbortController()
        const transport = createTauriRegisteredArtifactTransport({
            invoke,
            createRequestId: () => "request-read",
        })
        const opened = await transport.request(request({ signal: controller.signal }))
        const reader = opened.body!.getReader()
        const pending = reader.read()

        controller.abort()
        readGate.resolve({ done: false, chunk: [1] })
        await expect(pending).rejects.toThrow()
        await reader.cancel().catch(() => undefined)
        expect(calls.filter((command) => command === "cancel_model_artifact_fetch"))
            .toHaveLength(1)
        expect(calls).not.toContain("close_model_artifact_fetch")
    })

    it("rejects malformed and oversized bridge chunks before copying and cancels ownership", async () => {
        let copied = false
        const oversized = new Proxy(
            new Array(MODEL_ARTIFACT_MAX_CHUNK_BYTES + 1).fill(0),
            {
                get(target, property, receiver) {
                    if (property === Symbol.iterator) copied = true
                    return Reflect.get(target, property, receiver)
                },
            },
        )
        let openCalls = 0
        let cancelCalls = 0
        const invoke: TauriArtifactInvoke = async (command) => {
            if (command === "open_model_artifact_fetch") {
                openCalls += 1
                return { handle: "oversized-handle", status: 200, headers: [] }
            }
            if (command === "read_model_artifact_fetch") {
                return { done: false, chunk: oversized }
            }
            if (command === "cancel_model_artifact_fetch") {
                cancelCalls += 1
                return true
            }
            throw new Error(`unexpected command: ${command}`)
        }
        const transport = createTauriRegisteredArtifactTransport({
            invoke,
            createRequestId: () => "request-oversized",
        })
        const opened = await transport.request(request())

        await expect(opened.body!.getReader().read()).rejects.toThrow(/chunk/i)
        expect(copied).toBe(false)
        expect(openCalls).toBe(1)
        expect(cancelCalls).toBe(1)
    })

    it("rejects non-canonical bridge records and arrays before access or iteration", async () => {
        let headerIterations = 0
        const headers = [["ETag", '"fixed"']]
        Object.defineProperty(headers, Symbol.iterator, {
            value: function () {
                headerIterations += 1
                return Array.prototype[Symbol.iterator].call(this)
            },
        })
        const openCalls: string[] = []
        const openInvoke: TauriArtifactInvoke = async (command) => {
            openCalls.push(command)
            if (command === "open_model_artifact_fetch") {
                return { handle: "header-handle", status: 200, headers }
            }
            if (command === "cancel_model_artifact_fetch") return true
            throw new Error(`unexpected command: ${command}`)
        }
        const openTransport = createTauriRegisteredArtifactTransport({
            invoke: openInvoke,
            createRequestId: () => "request-header-shape",
        })
        await expect(openTransport.request(request())).rejects.toThrow(/bridge|header|array/i)
        expect(headerIterations).toBe(0)
        expect(openCalls).toEqual([
            "open_model_artifact_fetch",
            "cancel_model_artifact_fetch",
        ])

        let chunkReads = 0
        const chunk = [1]
        Object.defineProperty(chunk, "0", {
            enumerable: true,
            get: () => {
                chunkReads += 1
                return 1
            },
        })
        let cancelCalls = 0
        const readInvoke: TauriArtifactInvoke = async (command) => {
            if (command === "open_model_artifact_fetch") {
                return { handle: "chunk-handle", status: 200, headers: [] }
            }
            if (command === "read_model_artifact_fetch") {
                return { done: false, chunk, extra: true }
            }
            if (command === "cancel_model_artifact_fetch") {
                cancelCalls += 1
                return true
            }
            throw new Error(`unexpected command: ${command}`)
        }
        const readTransport = createTauriRegisteredArtifactTransport({
            invoke: readInvoke,
            createRequestId: () => "request-read-shape",
        })
        const opened = await readTransport.request(request())
        await expect(opened.body!.getReader().read()).rejects.toThrow(/bridge|read|chunk/i)
        expect(chunkReads).toBe(0)
        expect(cancelCalls).toBe(1)
    })

    it("preserves every open failure while attempting one matching cleanup", async () => {
        const primary = new Error("primary open failure")
        const controller = new AbortController()
        const calls: Array<{ command: string; args: unknown }> = []
        const invoke: TauriArtifactInvoke = async (command, args) => {
            calls.push({ command, args })
            if (command === "open_model_artifact_fetch") throw primary
            if (command === "cancel_model_artifact_fetch") {
                throw new Error("cleanup failure")
            }
            throw new Error(`unexpected command: ${command}`)
        }
        const transport = createTauriRegisteredArtifactTransport({
            invoke,
            createRequestId: () => "request-open-failure",
        })
        let caught: unknown
        try {
            await transport.request(request({ signal: controller.signal }))
        } catch (error) {
            caught = error
        }
        expect(caught).toBe(primary)
        controller.abort()
        await Promise.resolve()
        expect(calls).toEqual([
            {
                command: "open_model_artifact_fetch",
                args: {
                    requestId: "request-open-failure",
                    url: ARTIFACT.url,
                    headers: [],
                    maxBytes: ARTIFACT.bytes,
                },
            },
            {
                command: "cancel_model_artifact_fetch",
                args: { requestId: "request-open-failure", handle: null },
            },
        ])

        const latePrimary = new Error("late primary open failure")
        const lateAbort = new Error("late abort")
        const lateController = new AbortController()
        const removeListener = vi.spyOn(
            lateController.signal,
            "removeEventListener",
        )
        const cleanupStarted = deferred<void>()
        const cleanupGate = deferred<void>()
        let lateCancelCalls = 0
        const lateInvoke: TauriArtifactInvoke = async (command) => {
            if (command === "open_model_artifact_fetch") throw latePrimary
            if (command === "cancel_model_artifact_fetch") {
                lateCancelCalls += 1
                cleanupStarted.resolve()
                return cleanupGate.promise
            }
            throw new Error(`unexpected command: ${command}`)
        }
        const lateTransport = createTauriRegisteredArtifactTransport({
            invoke: lateInvoke,
            createRequestId: () => "request-late-abort",
        })
        const latePending = lateTransport.request(
            request({ signal: lateController.signal }),
        )

        await cleanupStarted.promise
        lateController.abort(lateAbort)
        cleanupGate.resolve()
        let lateCaught: unknown
        try {
            await latePending
        } catch (error) {
            lateCaught = error
        }
        expect(lateCaught).toBe(latePrimary)
        expect(lateCancelCalls).toBe(1)
        expect(removeListener).toHaveBeenCalledTimes(1)
        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
    })

    it("cleans invalid handles and handle-inspection failures exactly once", async () => {
        const inspectionFailure = new Error("handle inspection failed")
        const values: Array<{ value: unknown; expected: unknown }> = [
            { value: { handle: "", status: 200, headers: [] }, expected: null },
            { value: { handle: "x".repeat(129), status: 200, headers: [] }, expected: null },
            {
                value: new Proxy(
                    { handle: "opaque", status: 200, headers: [] },
                    {
                        getOwnPropertyDescriptor(target, key) {
                            if (key === "handle") throw inspectionFailure
                            return Reflect.getOwnPropertyDescriptor(target, key)
                        },
                    },
                ),
                expected: inspectionFailure,
            },
        ]
        for (const { value, expected } of values) {
            const calls: Array<{ command: string; args: unknown }> = []
            const invoke: TauriArtifactInvoke = async (command, args) => {
                calls.push({ command, args })
                if (command === "open_model_artifact_fetch") return value
                if (command === "cancel_model_artifact_fetch") return true
                throw new Error(`unexpected command: ${command}`)
            }
            const transport = createTauriRegisteredArtifactTransport({
                invoke,
                createRequestId: () => "request-invalid-handle",
            })
            let caught: unknown
            try {
                await transport.request(request())
            } catch (error) {
                caught = error
            }
            if (expected instanceof Error) expect(caught).toBe(expected)
            else expect(caught).toBeInstanceOf(Error)
            expect(calls.filter(({ command }) => command === "cancel_model_artifact_fetch"))
                .toEqual([{
                    command: "cancel_model_artifact_fetch",
                    args: { requestId: "request-invalid-handle", handle: null },
                }])
        }
    })

    it("fails closed on malformed open values without a second allocation", async () => {
        const cases = [
            { handle: "", status: 200, headers: [] },
            { handle: "h", status: 201, headers: [] },
            { handle: "h", status: 200, headers: [["Set-Cookie", "x=1"]] },
            { handle: "h", status: 200, headers: [["ETag", "x".repeat(4_097)]] },
        ]
        for (const value of cases) {
            let openCalls = 0
            const invoke: TauriArtifactInvoke = async (command) => {
                if (command === "open_model_artifact_fetch") {
                    openCalls += 1
                    return value
                }
                if (command === "cancel_model_artifact_fetch") return true
                throw new Error(`unexpected command: ${command}`)
            }
            const transport = createTauriRegisteredArtifactTransport({
                invoke,
                createRequestId: () => "request-malformed",
            })
            await expect(transport.request(request())).rejects.toThrow()
            expect(openCalls).toBe(1)
        }
    })
})
