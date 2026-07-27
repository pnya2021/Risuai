import { PluginApiError } from "../illustration/errors"
import type { ModelArtifactReadable, ModelArtifactStore } from "./modelArtifactStore"
import { normalizePixaiRunOptions } from "./pixaiInferenceCore"
import {
    getPixaiProfile,
    PIXAI_PROFILE_ID,
} from "./pixaiRegistry"
import {
    PixaiOrtWorkerClient,
    PixaiOrtWorkerError,
    type PixaiImageRunInput,
    type PixaiImageRunOutput,
} from "./pixaiOrtWorkerClient"

const WAITING_PER_PRINCIPAL = 4
const WATCHDOG_MS = 300_000
const IDLE_MS = 60_000
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface PixaiSessionWorkerClient {
    load(
        readable: ModelArtifactReadable,
        options?: { signal?: AbortSignal },
    ): Promise<{ provider: "wasm"; inputName: string; outputName: string }>
    configurePixaiSidecars(
        preprocess: ModelArtifactReadable,
        selectedTags: ModelArtifactReadable,
        options?: { signal?: AbortSignal },
    ): Promise<void>
    runPixaiImage(input: PixaiImageRunInput): Promise<PixaiImageRunOutput>
    dispose(): Promise<void>
}

export interface PixaiSessionOwner {
    principalId: string
    instanceId: string
}

export interface PixaiSessionBrokerOptions {
    store: Pick<ModelArtifactStore, "openVerified">
    createClient?: () => PixaiSessionWorkerClient
    createSessionId?: () => string
    setTimer?: (callback: () => void, milliseconds: number) => unknown
    clearTimer?: (timer: unknown) => void
}

interface Lease extends PixaiSessionOwner {
    readonly key: string
    readonly sessionId: string
}

interface AcquireJoiner {
    settled: boolean
    readonly resolve: (value: { sessionId: string; provider: "wasm" }) => void
    readonly reject: (error: PluginApiError) => void
    readonly signal?: AbortSignal
    abort?: () => void
}

interface AcquireEntry extends PixaiSessionOwner {
    readonly key: string
    readonly joiners: Set<AcquireJoiner>
    started: boolean
}

interface RunEntry extends PixaiSessionOwner {
    readonly sessionId: string
    readonly image: PixaiImageRunInput
    readonly signal?: AbortSignal
    readonly resolve: (value: PixaiImageRunOutput) => void
    readonly reject: (error: PluginApiError) => void
    abort?: () => void
    settled: boolean
    waiting: boolean
    watchdog?: unknown
    generation?: number
}

interface Initialization {
    readonly generation: number
    readonly client: PixaiSessionWorkerClient
    readonly controller: AbortController
    readonly promise: Promise<void>
}

interface RemovalEntry {
    readonly purge: () => Promise<number>
    running: boolean
}

const aborted = () => new PluginApiError(
    "ABORTED",
    "Local model inference was aborted",
)
const notFound = () => new PluginApiError(
    "NOT_FOUND",
    "Local model session was not found",
)
const providerFailed = () => new PluginApiError(
    "PROVIDER_ERROR",
    "Local model provider failed",
    { retryable: true },
)
const removalConflict = () => new PluginApiError(
    "CONFLICT",
    "Local model removal is pending",
    { retryable: true },
)

const stableError = (error: unknown, fallback: "NOT_FOUND" | "PROVIDER_ERROR" = "PROVIDER_ERROR") => {
    if (error instanceof PluginApiError) return error
    if (error instanceof PixaiOrtWorkerError) {
        switch (error.code) {
            case "ABORTED":
                return aborted()
            case "INVALID_ARGUMENT":
                return new PluginApiError("INVALID_ARGUMENT", "Invalid local model request")
            case "RESOURCE_LIMIT":
                return new PluginApiError(
                    "RESOURCE_LIMIT",
                    "Local model resource limit was exceeded",
                    { retryable: true },
                )
            case "IMAGE_DECODE_FAILED":
                return new PluginApiError(
                    "DECODE_FAILED",
                    "Local model image could not be decoded",
                )
            default:
                return providerFailed()
        }
    }
    return fallback === "NOT_FOUND"
        ? new PluginApiError("NOT_FOUND", "Local model is not ready")
        : providerFailed()
}

const assertOwner = (value: PixaiSessionOwner): PixaiSessionOwner => {
    if (
        !value ||
        !UUID_V4.test(value.principalId) ||
        !UUID_V4.test(value.instanceId)
    ) {
        throw notFound()
    }
    return {
        principalId: value.principalId.toLowerCase(),
        instanceId: value.instanceId.toLowerCase(),
    }
}

const ownerKey = (owner: PixaiSessionOwner) =>
    `${owner.principalId}:${owner.instanceId}:${PIXAI_PROFILE_ID}:wasm`

const copyImage = (input: PixaiImageRunInput): PixaiImageRunInput => {
    try {
        if (
            !input ||
            !(input.data instanceof Uint8Array) ||
            Object.getPrototypeOf(input.data) !== Uint8Array.prototype ||
            (input.mediaType !== "image/jpeg" &&
                input.mediaType !== "image/png" &&
                input.mediaType !== "image/webp")
        ) {
            throw new Error()
        }
        return {
            data: Uint8Array.from(input.data),
            mediaType: input.mediaType,
            options: normalizePixaiRunOptions(input.options),
        }
    } catch {
        throw new PluginApiError("INVALID_ARGUMENT", "Invalid local model request")
    }
}

export class PixaiSessionBroker {
    private readonly store: Pick<ModelArtifactStore, "openVerified">
    private readonly createClient: () => PixaiSessionWorkerClient
    private readonly createSessionId: () => string
    private readonly setTimer: (callback: () => void, milliseconds: number) => unknown
    private readonly clearTimer: (timer: unknown) => void
    private readonly leases = new Map<string, Lease>()
    private readonly owners = new Map<string, string>()
    private readonly acquiring = new Map<string, AcquireEntry>()
    private readonly queue: RunEntry[] = []
    private readonly waiting = new Map<string, number>()
    private client?: PixaiSessionWorkerClient
    private initialization?: Initialization
    private active?: RunEntry
    private idleTimer?: unknown
    private removal?: RemovalEntry
    private generation = 0

    constructor(options: PixaiSessionBrokerOptions) {
        this.store = options.store
        this.createClient = options.createClient ?? (() => new PixaiOrtWorkerClient())
        this.createSessionId = options.createSessionId ?? (() => crypto.randomUUID())
        this.setTimer = options.setTimer ?? ((callback, milliseconds) =>
            setTimeout(callback, milliseconds))
        this.clearTimer = options.clearTimer ?? ((timer) =>
            clearTimeout(timer as ReturnType<typeof setTimeout>))
    }

    private cancelIdle() {
        if (this.idleTimer === undefined) return
        this.clearTimer(this.idleTimer)
        this.idleTimer = undefined
    }

    private hasLiveAcquisition() {
        return [...this.acquiring.values()].some((entry) =>
            [...entry.joiners].some((joiner) => !joiner.settled))
    }

    private canPurge() {
        return this.leases.size === 0 &&
            !this.hasLiveAcquisition() &&
            !this.initialization &&
            !this.active &&
            this.queue.length === 0
    }

    private scheduleIdle() {
        if (
            this.removal ||
            this.idleTimer !== undefined ||
            !this.client ||
            !this.canPurge()
        ) {
            return
        }
        const generation = this.generation
        this.idleTimer = this.setTimer(() => {
            this.idleTimer = undefined
            if (generation !== this.generation || !this.client || !this.canPurge()) {
                return
            }
            const client = this.client
            this.client = undefined
            this.generation += 1
            void client.dispose().catch(() => undefined)
        }, IDLE_MS)
    }

    private async openArtifacts() {
        const profile = getPixaiProfile(PIXAI_PROFILE_ID)
        const byName = new Map(profile.artifacts.map((artifact) => [artifact.name, artifact]))
        const open = async (name: "model.onnx" | "preprocess.json" | "selected_tags.csv") => {
            const artifact = byName.get(name)!
            let readable: ModelArtifactReadable
            try {
                readable = await this.store.openVerified(artifact.sha256)
            } catch {
                throw stableError(undefined, "NOT_FOUND")
            }
            if (!readable || readable.size !== artifact.bytes || typeof readable.chunks !== "function") {
                throw stableError(undefined, "NOT_FOUND")
            }
            return readable
        }
        return {
            model: await open("model.onnx"),
            preprocess: await open("preprocess.json"),
            selectedTags: await open("selected_tags.csv"),
        }
    }

    private ensureInitialized(): Promise<void> {
        if (this.client) return Promise.resolve()
        if (this.initialization) return this.initialization.promise
        const generation = ++this.generation
        const client = this.createClient()
        const controller = new AbortController()
        const promise = (async () => {
            try {
                const artifacts = await this.openArtifacts()
                if (controller.signal.aborted) throw aborted()
                await client.load(artifacts.model, { signal: controller.signal })
                await client.configurePixaiSidecars(
                    artifacts.preprocess,
                    artifacts.selectedTags,
                    { signal: controller.signal },
                )
                if (controller.signal.aborted || generation !== this.generation) {
                    throw aborted()
                }
                this.client = client
            } catch (error) {
                await client.dispose().catch(() => undefined)
                throw stableError(error)
            } finally {
                if (this.initialization?.generation === generation) {
                    this.initialization = undefined
                }
            }
        })()
        this.initialization = { generation, client, controller, promise }
        void promise.finally(() => {
            this.maybePurge()
            this.scheduleIdle()
        }).catch(() => undefined)
        return promise
    }

    private maybeAbortInitialization() {
        if (
            this.initialization &&
            this.leases.size === 0 &&
            !this.hasLiveAcquisition() &&
            !this.active &&
            this.queue.length === 0
        ) {
            this.initialization.controller.abort()
        }
    }

    private settleAcquire(entry: AcquireEntry, error?: PluginApiError) {
        for (const joiner of entry.joiners) {
            if (joiner.settled) continue
            joiner.settled = true
            if (joiner.abort && joiner.signal) {
                joiner.signal.removeEventListener("abort", joiner.abort)
            }
            if (error) joiner.reject(error)
        }
    }

    private startAcquire(entry: AcquireEntry) {
        if (entry.started) return
        entry.started = true
        void (async () => {
            try {
                await this.ensureInitialized()
                if (![...entry.joiners].some((joiner) => !joiner.settled)) return
                const existing = this.owners.get(entry.key)
                let sessionId = existing
                if (!sessionId) {
                    sessionId = this.createSessionId()
                    if (!UUID_V4.test(sessionId) || this.leases.has(sessionId.toLowerCase())) {
                        throw providerFailed()
                    }
                    sessionId = sessionId.toLowerCase()
                    const lease: Lease = { ...entry, sessionId }
                    this.leases.set(sessionId, lease)
                    this.owners.set(entry.key, sessionId)
                }
                const result = Object.freeze({ sessionId, provider: "wasm" as const })
                for (const joiner of entry.joiners) {
                    if (joiner.settled) continue
                    joiner.settled = true
                    if (joiner.abort && joiner.signal) {
                        joiner.signal.removeEventListener("abort", joiner.abort)
                    }
                    joiner.resolve(result)
                }
            } catch (error) {
                this.settleAcquire(entry, stableError(error))
            } finally {
                if (this.acquiring.get(entry.key) === entry) {
                    this.acquiring.delete(entry.key)
                }
                this.maybeAbortInitialization()
                this.maybePurge()
                this.scheduleIdle()
            }
        })()
    }

    acquire(input: PixaiSessionOwner & {
        provider?: unknown
        signal?: AbortSignal
    }): Promise<{ sessionId: string; provider: "wasm" }> {
        this.cancelIdle()
        const owner = assertOwner(input)
        if (input.provider !== undefined && input.provider !== "auto" && input.provider !== "wasm") {
            if (input.provider === "webgpu" || input.provider === "node") {
                return Promise.reject(new PluginApiError(
                    "UNSUPPORTED",
                    "Local model provider is unavailable",
                ))
            }
            return Promise.reject(new PluginApiError(
                "INVALID_ARGUMENT",
                "Invalid local model provider",
            ))
        }
        if (input.signal?.aborted) return Promise.reject(aborted())
        if (this.removal) return Promise.reject(removalConflict())
        const key = ownerKey(owner)
        const existing = this.owners.get(key)
        if (existing) return Promise.resolve({ sessionId: existing, provider: "wasm" })
        let entry = this.acquiring.get(key)
        if (!entry) {
            entry = { ...owner, key, joiners: new Set(), started: false }
            this.acquiring.set(key, entry)
        }
        const promise = new Promise<{ sessionId: string; provider: "wasm" }>((resolve, reject) => {
            const joiner: AcquireJoiner = {
                settled: false,
                resolve,
                reject,
                signal: input.signal,
            }
            if (input.signal) {
                joiner.abort = () => {
                    if (joiner.settled) return
                    joiner.settled = true
                    input.signal!.removeEventListener("abort", joiner.abort!)
                    reject(aborted())
                    this.maybeAbortInitialization()
                    this.maybePurge()
                    this.scheduleIdle()
                }
                input.signal.addEventListener("abort", joiner.abort, { once: true })
            }
            entry!.joiners.add(joiner)
        })
        this.startAcquire(entry)
        return promise
    }

    private finishLogical(entry: RunEntry, error?: PluginApiError, value?: PixaiImageRunOutput) {
        if (entry.settled) return
        entry.settled = true
        if (entry.abort && entry.signal) {
            entry.signal.removeEventListener("abort", entry.abort)
        }
        if (error) entry.reject(error)
        else entry.resolve(value!)
    }

    private removeQueued(predicate: (entry: RunEntry) => boolean, error: PluginApiError) {
        for (let index = this.queue.length - 1; index >= 0; index -= 1) {
            const entry = this.queue[index]
            if (!predicate(entry)) continue
            this.queue.splice(index, 1)
            if (entry.waiting) {
                const count = this.waiting.get(entry.principalId) ?? 0
                if (count <= 1) this.waiting.delete(entry.principalId)
                else this.waiting.set(entry.principalId, count - 1)
            }
            this.finishLogical(entry, error)
        }
    }

    private dispatch() {
        if (this.active || this.queue.length === 0) return
        const entry = this.queue.shift()!
        if (entry.waiting) {
            const count = this.waiting.get(entry.principalId) ?? 0
            if (count <= 1) this.waiting.delete(entry.principalId)
            else this.waiting.set(entry.principalId, count - 1)
            entry.waiting = false
        }
        const client = this.client
        if (!client) {
            this.finishLogical(entry, providerFailed())
            this.dispatch()
            return
        }
        this.active = entry
        entry.generation = this.generation
        const generation = this.generation
        entry.watchdog = this.setTimer(() => {
            void this.expireGeneration(generation)
        }, WATCHDOG_MS)
        let physical: Promise<PixaiImageRunOutput>
        try {
            physical = client.runPixaiImage(entry.image)
        } catch (error) {
            physical = Promise.reject(error)
        }
        void physical.then(
            (value) => this.finishLogical(entry, undefined, value),
            (error) => this.finishLogical(entry, stableError(error)),
        ).finally(() => {
            if (entry.watchdog !== undefined) this.clearTimer(entry.watchdog)
            if (this.active === entry && generation === this.generation) {
                this.active = undefined
                this.dispatch()
                this.maybePurge()
                this.scheduleIdle()
            }
        })
    }

    run(input: PixaiSessionOwner & {
        sessionId: string
        image: PixaiImageRunInput
        signal?: AbortSignal
    }): Promise<PixaiImageRunOutput> {
        this.cancelIdle()
        const owner = assertOwner(input)
        const sessionId = typeof input.sessionId === "string"
            ? input.sessionId.toLowerCase()
            : ""
        const lease = this.leases.get(sessionId)
        if (!lease || lease.key !== ownerKey(owner)) return Promise.reject(notFound())
        if (input.signal?.aborted) return Promise.reject(aborted())
        let image: PixaiImageRunInput
        try {
            image = copyImage(input.image)
        } catch (error) {
            return Promise.reject(error)
        }
        if (this.active) {
            const waiting = this.waiting.get(owner.principalId) ?? 0
            if (waiting >= WAITING_PER_PRINCIPAL) {
                return Promise.reject(new PluginApiError(
                    "RESOURCE_LIMIT",
                    "Local model inference queue is full",
                    { retryable: true },
                ))
            }
        }
        return new Promise((resolve, reject) => {
            const entry: RunEntry = {
                ...owner,
                sessionId,
                image,
                signal: input.signal,
                resolve,
                reject,
                settled: false,
                waiting: Boolean(this.active),
            }
            if (entry.waiting) {
                this.waiting.set(
                    owner.principalId,
                    (this.waiting.get(owner.principalId) ?? 0) + 1,
                )
            }
            if (input.signal) {
                entry.abort = () => {
                    if (entry.settled) return
                    if (this.active === entry) {
                        this.finishLogical(entry, aborted())
                    } else {
                        this.removeQueued((candidate) => candidate === entry, aborted())
                        this.maybePurge()
                        this.scheduleIdle()
                    }
                }
                input.signal.addEventListener("abort", entry.abort, { once: true })
            }
            this.queue.push(entry)
            this.dispatch()
        })
    }

    private releaseLease(lease: Lease) {
        this.leases.delete(lease.sessionId)
        if (this.owners.get(lease.key) === lease.sessionId) {
            this.owners.delete(lease.key)
        }
        this.removeQueued(
            (entry) => entry.sessionId === lease.sessionId,
            aborted(),
        )
        if (this.active?.sessionId === lease.sessionId) {
            this.finishLogical(this.active, aborted())
        }
        this.maybePurge()
        this.scheduleIdle()
    }

    async release(input: PixaiSessionOwner & { sessionId: string }): Promise<void> {
        const owner = assertOwner(input)
        const sessionId = typeof input.sessionId === "string"
            ? input.sessionId.toLowerCase()
            : ""
        const lease = this.leases.get(sessionId)
        if (!lease || lease.key !== ownerKey(owner)) throw notFound()
        this.releaseLease(lease)
    }

    async releaseInstance(principalId: string, instanceId: string): Promise<void> {
        const owner = assertOwner({ principalId, instanceId })
        for (const entry of this.acquiring.values()) {
            if (entry.principalId !== owner.principalId || entry.instanceId !== owner.instanceId) continue
            this.settleAcquire(entry, aborted())
        }
        for (const lease of [...this.leases.values()]) {
            if (lease.principalId === owner.principalId && lease.instanceId === owner.instanceId) {
                this.releaseLease(lease)
            }
        }
        this.maybeAbortInitialization()
        this.maybePurge()
        this.scheduleIdle()
    }

    private async expireGeneration(generation: number) {
        if (generation !== this.generation) return
        const error = providerFailed()
        if (this.active) this.finishLogical(this.active, error)
        for (const entry of this.queue) this.finishLogical(entry, error)
        this.queue.length = 0
        this.waiting.clear()
        for (const entry of this.acquiring.values()) this.settleAcquire(entry, error)
        this.acquiring.clear()
        this.leases.clear()
        this.owners.clear()
        this.initialization?.controller.abort()
        const client = this.client ?? this.initialization?.client
        this.client = undefined
        this.initialization = undefined
        this.generation += 1
        await client?.dispose().catch(() => undefined)
        if (this.active?.generation === generation) this.active = undefined
        this.maybePurge()
        this.scheduleIdle()
    }

    isRemovalPending(): boolean {
        return Boolean(this.removal)
    }

    assertInstallAllowed(): void {
        if (this.removal) throw removalConflict()
    }

    private async executePurge(entry: RemovalEntry): Promise<number> {
        if (entry.running) return 0
        entry.running = true
        this.cancelIdle()
        const client = this.client
        this.client = undefined
        if (client) {
            this.generation += 1
            await client.dispose().catch(() => undefined)
        }
        try {
            return await entry.purge()
        } finally {
            if (this.removal === entry) this.removal = undefined
            this.scheduleIdle()
        }
    }

    private maybePurge() {
        const entry = this.removal
        if (!entry || entry.running || !this.canPurge()) return
        void this.executePurge(entry).catch(() => undefined)
    }

    async removeWhenIdle(
        purge: () => Promise<number>,
    ): Promise<{ pending: boolean; purgedBytes: number }> {
        if (this.removal) return { pending: true, purgedBytes: 0 }
        const entry: RemovalEntry = { purge, running: false }
        this.removal = entry
        this.cancelIdle()
        if (!this.canPurge()) return { pending: true, purgedBytes: 0 }
        const purgedBytes = await this.executePurge(entry)
        return { pending: false, purgedBytes }
    }
}
