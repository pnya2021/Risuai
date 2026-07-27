import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ModelArtifactReadable } from "./modelArtifactStore"
import {
    getPixaiProfile,
    PIXAI_PROFILE_ID,
} from "./pixaiRegistry"
import type {
    PixaiImageRunInput,
    PixaiImageRunOutput,
} from "./pixaiOrtWorkerClient"
import {
    PixaiOrtWorkerError,
} from "./pixaiOrtWorkerClient"
import {
    PixaiSessionBroker,
    type PixaiSessionWorkerClient,
} from "./pixaiSessionBroker"

const PRINCIPAL_A = "11111111-1111-4111-8111-111111111111"
const PRINCIPAL_B = "22222222-2222-4222-8222-222222222222"
const INSTANCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const INSTANCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((accept, decline) => {
        resolve = accept
        reject = decline
    })
    return { promise, resolve, reject }
}

const nextTurn = async () => {
    await Promise.resolve()
    await Promise.resolve()
}

const result: PixaiImageRunOutput = Object.freeze({
    modelProfileId: PIXAI_PROFILE_ID,
    modelRevision: getPixaiProfile(PIXAI_PROFILE_ID).revision,
    modelSha256: getPixaiProfile(PIXAI_PROFILE_ID).artifacts[0].sha256,
    preprocessVersion: getPixaiProfile(PIXAI_PROFILE_ID).preprocessing.version,
    provider: "wasm" as const,
    tags: Object.freeze([]),
    thresholds: Object.freeze({ general: 0.3, character: 0.85 }),
    truncated: false,
    timings: Object.freeze({
        decodeMs: 0,
        preprocessMs: 0,
        inferenceMs: 0,
        postprocessMs: 0,
        totalMs: 0,
    }),
    warnings: Object.freeze([]) as readonly [],
})

class FakeClient implements PixaiSessionWorkerClient {
    readonly loadCalls: ModelArtifactReadable[] = []
    readonly configureCalls: Array<[ModelArtifactReadable, ModelArtifactReadable]> = []
    readonly runCalls: Array<{
        input: PixaiImageRunInput
        operation: ReturnType<typeof deferred<PixaiImageRunOutput>>
    }> = []
    disposeCalls = 0
    loadGate?: ReturnType<typeof deferred<void>>

    async load(readable: ModelArtifactReadable, options: { signal?: AbortSignal } = {}) {
        this.loadCalls.push(readable)
        if (this.loadGate) {
            await new Promise<void>((resolve, reject) => {
                const abort = () => reject(new PixaiOrtWorkerError("ABORTED"))
                options.signal?.addEventListener("abort", abort, { once: true })
                this.loadGate!.promise.then(resolve, reject).finally(() => {
                    options.signal?.removeEventListener("abort", abort)
                })
            })
        }
        return { provider: "wasm" as const, inputName: "input", outputName: "output" }
    }

    async configurePixaiSidecars(
        preprocess: ModelArtifactReadable,
        selectedTags: ModelArtifactReadable,
    ) {
        this.configureCalls.push([preprocess, selectedTags])
    }

    runPixaiImage(input: PixaiImageRunInput) {
        const operation = deferred<PixaiImageRunOutput>()
        this.runCalls.push({ input, operation })
        return operation.promise
    }

    async dispose() {
        this.disposeCalls += 1
        for (const run of this.runCalls) {
            run.operation.reject(new PixaiOrtWorkerError("DISPOSED"))
        }
    }
}

const fakeStore = () => {
    const profile = getPixaiProfile(PIXAI_PROFILE_ID)
    const opened: string[] = []
    return {
        opened,
        async openVerified(digest: string): Promise<ModelArtifactReadable> {
            opened.push(digest)
            const artifact = profile.artifacts.find((entry) => entry.sha256 === digest)
            if (!artifact) throw new Error("missing")
            return {
                size: artifact.bytes,
                async *chunks() {
                    throw new Error("Fake client must not consume artifact bytes")
                },
            }
        },
    }
}

const image = (marker: number): PixaiImageRunInput => ({
    data: new Uint8Array([marker]),
    mediaType: "image/png",
})

const owner = (
    principalId = PRINCIPAL_A,
    instanceId = INSTANCE_A,
) => ({ principalId, instanceId })

const sessionIds = [
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000004",
]

const setup = (clients: FakeClient[] = []) => {
    const store = fakeStore()
    let sessionIndex = 0
    const broker = new PixaiSessionBroker({
        store,
        createClient: () => {
            const client = new FakeClient()
            clients.push(client)
            return client
        },
        createSessionId: () => sessionIds[sessionIndex++],
    })
    return { broker, store, clients }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("Risu PixAI session broker", () => {
    it("coalesces one owner while keeping other instances private", async () => {
        const { broker, clients, store } = setup()
        const [first, same] = await Promise.all([
            broker.acquire({ ...owner(), provider: "auto" }),
            broker.acquire({ ...owner(), provider: "wasm" }),
        ])
        expect(same).toEqual(first)
        expect(first.provider).toBe("wasm")
        expect(clients).toHaveLength(1)
        expect(store.opened).toHaveLength(3)

        const other = await broker.acquire(owner(PRINCIPAL_A, INSTANCE_B))
        expect(other.sessionId).not.toBe(first.sessionId)
        expect(clients).toHaveLength(1)
        await expect(broker.release({
            ...owner(PRINCIPAL_B, INSTANCE_A),
            sessionId: first.sessionId,
        })).rejects.toMatchObject({ code: "NOT_FOUND" })

        await broker.release({ ...owner(), sessionId: first.sessionId })
        const replacement = await broker.acquire(owner())
        expect(replacement.sessionId).not.toBe(first.sessionId)
        await expect(broker.acquire({ ...owner(), provider: "node" }))
            .rejects.toMatchObject({ code: "UNSUPPORTED" })
    })

    it("independently aborts acquire joiners and leaves no orphan when all abort", async () => {
        const clients: FakeClient[] = []
        const store = fakeStore()
        const gate = deferred<void>()
        let sessionIndex = 0
        const broker = new PixaiSessionBroker({
            store,
            createClient: () => {
                const client = new FakeClient()
                if (clients.length === 0) client.loadGate = gate
                clients.push(client)
                return client
            },
            createSessionId: () => sessionIds[sessionIndex++],
        })
        const firstController = new AbortController()
        const secondController = new AbortController()
        const first = broker.acquire({ ...owner(), signal: firstController.signal })
        const second = broker.acquire({ ...owner(), signal: secondController.signal })
        await nextTurn()
        firstController.abort()
        await expect(first).rejects.toMatchObject({ code: "ABORTED" })
        expect(clients[0].disposeCalls).toBe(0)
        secondController.abort()
        await expect(second).rejects.toMatchObject({ code: "ABORTED" })
        await nextTurn()
        expect(clients[0].disposeCalls).toBe(1)

        const later = await broker.acquire(owner())
        expect(later.sessionId).toBe(sessionIds[0])
        expect(clients).toHaveLength(2)
    })

    it("serializes globally, preserves FIFO, and caps waiting per principal at four", async () => {
        const { broker, clients } = setup()
        const leaseA = await broker.acquire(owner())
        const leaseB = await broker.acquire(owner(PRINCIPAL_B, INSTANCE_B))
        const first = broker.run({ ...owner(), sessionId: leaseA.sessionId, image: image(1) })
        const second = broker.run({ ...owner(), sessionId: leaseA.sessionId, image: image(2) })
        const third = broker.run({
            ...owner(PRINCIPAL_B, INSTANCE_B),
            sessionId: leaseB.sessionId,
            image: image(3),
        })
        await nextTurn()
        expect(clients[0].runCalls.map((entry) => entry.input.data[0])).toEqual([1])
        clients[0].runCalls[0].operation.resolve(result)
        await expect(first).resolves.toBe(result)
        await nextTurn()
        expect(clients[0].runCalls.map((entry) => entry.input.data[0])).toEqual([1, 2])
        clients[0].runCalls[1].operation.resolve(result)
        await expect(second).resolves.toBe(result)
        await nextTurn()
        expect(clients[0].runCalls.map((entry) => entry.input.data[0])).toEqual([1, 2, 3])
        clients[0].runCalls[2].operation.resolve(result)
        await expect(third).resolves.toBe(result)

        const active = broker.run({ ...owner(), sessionId: leaseA.sessionId, image: image(10) })
        const controllers = Array.from({ length: 5 }, () => new AbortController())
        const waiting = controllers.slice(0, 4).map((controller, index) => broker.run({
            ...owner(),
            sessionId: leaseA.sessionId,
            image: image(11 + index),
            signal: controller.signal,
        }))
        await expect(broker.run({
            ...owner(),
            sessionId: leaseA.sessionId,
            image: image(20),
        })).rejects.toMatchObject({ code: "RESOURCE_LIMIT", retryable: true })
        controllers[1].abort()
        await expect(waiting[1]).rejects.toMatchObject({ code: "ABORTED" })
        const admitted = broker.run({ ...owner(), sessionId: leaseA.sessionId, image: image(21) })
        await broker.release({ ...owner(), sessionId: leaseA.sessionId })
        for (const promise of [active, waiting[0], waiting[2], waiting[3], admitted]) {
            await expect(promise).rejects.toMatchObject({ code: "ABORTED" })
        }
        clients[0].runCalls.at(-1)!.operation.resolve(result)
    })

    it("holds deferred purge through a logically aborted physical run", async () => {
        const { broker, clients } = setup()
        const lease = await broker.acquire(owner())
        const controller = new AbortController()
        const running = broker.run({
            ...owner(),
            sessionId: lease.sessionId,
            image: image(1),
            signal: controller.signal,
        })
        await nextTurn()
        controller.abort()
        await expect(running).rejects.toMatchObject({ code: "ABORTED" })
        const events: string[] = []
        const purge = vi.fn(async () => {
            events.push("purge")
            return 123
        })
        await expect(broker.removeWhenIdle(purge)).resolves.toEqual({
            pending: true,
            purgedBytes: 0,
        })
        await expect(broker.removeWhenIdle(vi.fn(async () => 999))).resolves.toEqual({
            pending: true,
            purgedBytes: 0,
        })
        await expect(broker.acquire(owner())).rejects.toMatchObject({ code: "CONFLICT" })
        await broker.release({ ...owner(), sessionId: lease.sessionId })
        expect(purge).not.toHaveBeenCalled()
        clients[0].runCalls[0].operation.resolve(result)
        await nextTurn()
        await nextTurn()
        expect(clients[0].disposeCalls).toBe(1)
        expect(purge).toHaveBeenCalledTimes(1)
        expect(events).toEqual(["purge"])
        expect(broker.isRemovalPending()).toBe(false)
    })

    it("invalidates a hung generation at 300 seconds and idles a released replacement at 60 seconds", async () => {
        const { broker, clients } = setup()
        const lease = await broker.acquire(owner())
        const hung = broker.run({ ...owner(), sessionId: lease.sessionId, image: image(1) })
        const hungRejection = expect(hung).rejects.toMatchObject({
            code: "PROVIDER_ERROR",
            retryable: true,
        })
        await nextTurn()
        await vi.advanceTimersByTimeAsync(300_000)
        await hungRejection
        expect(clients[0].disposeCalls).toBe(1)
        await expect(broker.release({ ...owner(), sessionId: lease.sessionId }))
            .rejects.toMatchObject({ code: "NOT_FOUND" })

        const replacement = await broker.acquire(owner())
        expect(clients).toHaveLength(2)
        await broker.release({ ...owner(), sessionId: replacement.sessionId })
        await vi.advanceTimersByTimeAsync(59_999)
        expect(clients[1].disposeCalls).toBe(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(clients[1].disposeCalls).toBe(1)
    })
})
