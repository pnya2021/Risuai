import { describe, expect, it, vi } from "vitest"
import { SecurityConfirmationQueue } from "../../securityConfirmationQueue"
import { PluginApiError } from "../illustration/errors"
import type { PluginExecutionContext } from "../illustration/permissions"
import type {
    ArtifactStat,
    ModelArtifactStore,
    ModelArtifactWriteHandle,
} from "./modelArtifactStore"
import {
    PIXAI_PROFILE_ID,
    getPixaiProfile,
    type RegisteredModelArtifact,
} from "./pixaiRegistry"
import {
    PixaiInstallLifecycle,
    TERMINAL_OPERATION_TTL_MS,
    type LocalModelProgress,
    type PixaiLifecycleInferenceBarrier,
    type PixaiInstallLifecycleOptions,
} from "./pixaiInstallLifecycle"
import type {
    RegisteredArtifactDownloadOptions,
    RegisteredArtifactDownloadResult,
} from "./registeredArtifactDownload"

const profile = getPixaiProfile(PIXAI_PROFILE_ID)

class MemoryArtifactStore implements ModelArtifactStore {
    readonly kind = "opfs" as const
    readonly supportsResume = true
    readonly states = new Map<string, ArtifactStat>()
    removeCalls = 0

    estimate() {
        return Promise.resolve({
            usageBytes: 0,
            quotaBytes: profile.totalBytes * 2,
            persistent: true,
        })
    }

    stat(digest: string): Promise<ArtifactStat> {
        return Promise.resolve(this.states.get(digest) ?? {
            state: "absent",
            bytes: 0,
        })
    }

    beginWrite(): Promise<ModelArtifactWriteHandle> {
        throw new Error("not used by lifecycle tests")
    }

    async *readPartial(): AsyncIterable<Uint8Array> {
        return
    }

    openVerified(): Promise<never> {
        throw new Error("not used by lifecycle tests")
    }

    async remove(
        digest: string,
        options: { partial: boolean; verified: boolean },
    ): Promise<void> {
        this.removeCalls += 1
        const state = await this.stat(digest)
        if (
            (state.state === "partial" && options.partial) ||
            (state.state === "verified" && options.verified)
        ) {
            this.states.delete(digest)
        }
    }

    set(
        artifact: Readonly<RegisteredModelArtifact>,
        state: "partial" | "verified",
        bytes = artifact.bytes,
    ): void {
        this.states.set(artifact.sha256, { state, bytes })
    }

    setAllReady(): void {
        for (const artifact of profile.artifacts) this.set(artifact, "verified")
    }
}

function execution(
    principalId: string,
    instanceId = `${principalId}-instance`,
): { context: PluginExecutionContext; abort: AbortController } {
    const abort = new AbortController()
    return {
        abort,
        context: {
            principalId,
            instanceId,
            displayName: `Plugin ${principalId}`,
            internalName: `plugin-${principalId}`,
            signal: abort.signal,
        },
    }
}

function decide(queue: SecurityConfirmationQueue, decision: boolean): void {
    const current = queue.current()
    if (!current) throw new Error("confirmation was not presented")
    if (!queue.decide(current.digest, current.presentationId, decision)) {
        throw new Error("confirmation decision was rejected")
    }
}

function immediateDownload(store: MemoryArtifactStore) {
    return async (
        options: RegisteredArtifactDownloadOptions,
    ): Promise<RegisteredArtifactDownloadResult> => {
        options.onProgress?.({
            phase: "downloading",
            loadedBytes: options.artifact.bytes,
            totalBytes: options.artifact.bytes,
        })
        options.onProgress?.({
            phase: "verifying",
            loadedBytes: options.artifact.bytes,
            totalBytes: options.artifact.bytes,
        })
        store.set(options.artifact, "verified")
        options.onProgress?.({
            phase: "committing",
            loadedBytes: options.artifact.bytes,
            totalBytes: options.artifact.bytes,
        })
        return {
            state: "verified",
            bytes: options.artifact.bytes,
            resumed: false,
        }
    }
}

function setup(
    overrides: Partial<PixaiInstallLifecycleOptions> = {},
): {
    lifecycle: PixaiInstallLifecycle
    queue: SecurityConfirmationQueue
    store: MemoryArtifactStore
} {
    const queue = new SecurityConfirmationQueue()
    const store = new MemoryArtifactStore()
    return {
        queue,
        store,
        lifecycle: new PixaiInstallLifecycle({
            store,
            transport: {
                request: async () => {
                    throw new Error("transport must be replaced by the test download")
                },
            },
            queue,
            requirePermission: async () => undefined,
            download: immediateDownload(store),
            ...overrides,
        }),
    }
}

async function approvedInstall(
    lifecycle: PixaiInstallLifecycle,
    queue: SecurityConfirmationQueue,
    context: PluginExecutionContext,
    onProgress?: (progress: LocalModelProgress) => unknown,
): Promise<{ operationId: string }> {
    const installation = lifecycle.installLocalModel(
        context,
        PIXAI_PROFILE_ID,
        onProgress,
    )
    await queue.whenPresented()
    decide(queue, true)
    return installation
}

async function operation(
    lifecycle: PixaiInstallLifecycle,
    context: PluginExecutionContext,
    operationId: string,
) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const snapshot = await lifecycle.getLocalModelOperation(context, operationId)
        if (["succeeded", "failed", "cancelled"].includes(snapshot.state)) {
            return snapshot
        }
        await new Promise<void>((resolve) => queueMicrotask(resolve))
    }
    throw new Error("local model operation did not settle")
}

describe("PixAI install lifecycle", () => {
    it("reports absent, partial, and ready artifact state without prompting", async () => {
        const { lifecycle, queue, store } = setup()
        const owner = execution("owner").context

        await expect(
            lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE_ID),
        ).resolves.toEqual({ state: "absent" })

        store.set(profile.artifacts[0], "partial", 123)
        await expect(
            lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE_ID),
        ).resolves.toEqual({
            state: "partial",
            revision: profile.revision,
            sha256: profile.artifacts[0].sha256,
            storedBytes: 123,
        })

        store.setAllReady()
        await expect(
            lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE_ID),
        ).resolves.toEqual({
            state: "ready",
            revision: profile.revision,
            sha256: profile.artifacts[0].sha256,
            storedBytes: profile.totalBytes,
        })
        expect(queue.current()).toBeNull()
    })

    it("denies installation without creating an operation or artifact bytes", async () => {
        let generatedIds = 0
        const { lifecycle, queue, store } = setup({
            createOperationId: () => `lmo_denied_${++generatedIds}`,
        })
        const owner = execution("owner").context
        const installation = lifecycle.installLocalModel(owner, PIXAI_PROFILE_ID)

        await queue.whenPresented()
        const confirmation = queue.current()
        expect(confirmation?.request).toMatchObject({
            kind: "model-install",
            principalId: "owner",
            profileDigest: expect.any(String),
        })
        expect(confirmation?.copy).toContain(owner.displayName)
        expect(confirmation?.copy).toContain(profile.sourceUrl)
        expect(confirmation?.copy).toContain(profile.license)
        expect(confirmation?.copy).toContain(profile.revision)
        expect(confirmation?.copy).toContain(String(profile.totalBytes))
        expect(confirmation?.copy).toContain(profile.artifacts[0].sha256)
        expect(confirmation?.copy).toMatch(/device-local/i)
        expect(confirmation?.copy).toMatch(/local images/i)
        decide(queue, false)

        await expect(installation).rejects.toMatchObject({
            code: "PERMISSION_DENIED",
        })
        expect(generatedIds).toBe(0)
        await expect(
            lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE_ID),
        ).resolves.toEqual({ state: "absent" })
        expect(store.states.size).toBe(0)
    })

    it("requires localModelInference before model confirmation", async () => {
        const denied = new PluginApiError("PERMISSION_DENIED", "permission denied")
        const { lifecycle, queue } = setup({
            requirePermission: async () => {
                throw denied
            },
        })

        await expect(
            lifecycle.installLocalModel(execution("owner").context, PIXAI_PROFILE_ID),
        ).rejects.toBe(denied)
        expect(queue.current()).toBeNull()
    })

    it("blocks installation before permission and confirmation while removal is pending", async () => {
        const requirePermission = vi.fn(async () => undefined)
        const barrier: PixaiLifecycleInferenceBarrier = {
            assertInstallAllowed: () => {
                throw new PluginApiError(
                    "CONFLICT",
                    "Local model removal is pending",
                    { retryable: true },
                )
            },
            removeWhenIdle: async (purge) => ({
                pending: false,
                purgedBytes: await purge(),
            }),
        }
        const { lifecycle, queue } = setup({ barrier, requirePermission })

        await expect(
            lifecycle.installLocalModel(execution("owner").context, PIXAI_PROFILE_ID),
        ).rejects.toMatchObject({ code: "CONFLICT", retryable: true })
        expect(requirePermission).not.toHaveBeenCalled()
        expect(queue.current()).toBeNull()
    })

    it("rechecks the removal barrier after delayed installation approval", async () => {
        let checks = 0
        const barrier: PixaiLifecycleInferenceBarrier = {
            assertInstallAllowed: () => {
                checks += 1
                if (checks === 2) {
                    throw new PluginApiError(
                        "CONFLICT",
                        "Local model removal is pending",
                        { retryable: true },
                    )
                }
            },
            removeWhenIdle: async (purge) => ({
                pending: false,
                purgedBytes: await purge(),
            }),
        }
        const { lifecycle, queue, store } = setup({ barrier })
        const installation = lifecycle.installLocalModel(
            execution("owner").context,
            PIXAI_PROFILE_ID,
        )

        await queue.whenPresented()
        decide(queue, true)

        await expect(installation).rejects.toMatchObject({
            code: "CONFLICT",
            retryable: true,
        })
        expect(checks).toBe(2)
        expect(store.states.size).toBe(0)
    })

    it("exposes active operationId and aggregate progress through verification", async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const progress: LocalModelProgress[] = []
        const { lifecycle, queue, store } = setup({
            download: async (options) => {
                options.onProgress?.({
                    phase: "downloading",
                    loadedBytes: 17,
                    totalBytes: options.artifact.bytes,
                })
                await gate
                options.onProgress?.({
                    phase: "verifying",
                    loadedBytes: options.artifact.bytes,
                    totalBytes: options.artifact.bytes,
                })
                store.set(options.artifact, "verified")
                return {
                    state: "verified",
                    bytes: options.artifact.bytes,
                    resumed: false,
                }
            },
        })
        const owner = execution("owner").context
        const installed = await approvedInstall(
            lifecycle,
            queue,
            owner,
            (update) => progress.push(update),
        )

        await vi.waitFor(async () => {
            expect(
                await lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE_ID),
            ).toMatchObject({
                state: "downloading",
                operationId: installed.operationId,
            })
        })
        release()
        await expect(operation(lifecycle, owner, installed.operationId)).resolves
            .toMatchObject({ state: "succeeded" })
        expect(progress).toContainEqual({
            phase: "verifying",
            loadedBytes: profile.artifacts[0].bytes,
            totalBytes: profile.totalBytes,
        })
        expect(progress.at(-1)).toEqual({
            phase: "ready",
            loadedBytes: profile.totalBytes,
            totalBytes: profile.totalBytes,
        })
    })

    it("cancels an owned operation as ABORTED and preserves partial state", async () => {
        const { lifecycle, queue, store } = setup({
            download: (options) =>
                new Promise((resolve, reject) => {
                    options.onProgress?.({
                        phase: "downloading",
                        loadedBytes: 64,
                        totalBytes: options.artifact.bytes,
                    })
                    options.signal?.addEventListener(
                        "abort",
                        () => {
                            store.set(options.artifact, "partial", 64)
                            reject(options.signal?.reason)
                        },
                        { once: true },
                    )
                    void resolve
                }),
        })
        const owner = execution("owner").context
        const installed = await approvedInstall(lifecycle, queue, owner)

        await vi.waitFor(async () => {
            expect(
                await lifecycle.getLocalModelOperation(owner, installed.operationId),
            ).toMatchObject({
                state: "running",
                progress: { phase: "downloading", loadedBytes: 64 },
            })
        })

        await lifecycle.cancelLocalModelOperation(owner, installed.operationId)

        await expect(
            lifecycle.getLocalModelOperation(owner, installed.operationId),
        ).resolves.toMatchObject({
            state: "cancelled",
            error: { code: "ABORTED", retryable: false },
        })
        await expect(
            lifecycle.getLocalModelStatus(owner, PIXAI_PROFILE_ID),
        ).resolves.toMatchObject({ state: "partial", storedBytes: 64 })
    })

    it("coalesces one principal while keeping another principal opaque", async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const { lifecycle, queue, store } = setup({
            download: async (options) => {
                await gate
                store.set(options.artifact, "verified")
                return {
                    state: "verified",
                    bytes: options.artifact.bytes,
                    resumed: false,
                }
            },
        })
        const first = execution("first").context
        const firstReload = execution("first", "first-reload").context
        const second = execution("second").context

        const one = await approvedInstall(lifecycle, queue, first)
        await expect(
            lifecycle.installLocalModel(firstReload, PIXAI_PROFILE_ID),
        ).resolves.toEqual(one)
        expect(queue.current()).toBeNull()

        const two = await approvedInstall(lifecycle, queue, second)
        expect(two.operationId).not.toBe(one.operationId)
        await expect(
            lifecycle.getLocalModelOperation(second, one.operationId),
        ).rejects.toMatchObject({ code: "NOT_FOUND" })
        await expect(
            lifecycle.cancelLocalModelOperation(second, one.operationId),
        ).rejects.toMatchObject({ code: "NOT_FOUND" })

        release()
        await Promise.all([
            operation(lifecycle, first, one.operationId),
            operation(lifecycle, second, two.operationId),
        ])
    })

    it("coalesces concurrent confirmed installs for one principal", async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        let modelDownloads = 0
        const { lifecycle, queue, store } = setup({
            download: async (options) => {
                if (options.artifact.name === "model.onnx") {
                    modelDownloads += 1
                    await gate
                }
                store.set(options.artifact, "verified")
                return {
                    state: "verified",
                    bytes: options.artifact.bytes,
                    resumed: false,
                }
            },
        })
        const first = execution("owner", "owner-first").context
        const second = execution("owner", "owner-second").context

        const firstInstall = lifecycle.installLocalModel(first, PIXAI_PROFILE_ID)
        const secondInstall = lifecycle.installLocalModel(second, PIXAI_PROFILE_ID)
        await queue.whenPresented()
        decide(queue, true)
        await queue.whenPresented()
        decide(queue, true)
        const [one, two] = await Promise.all([firstInstall, secondInstall])
        await vi.waitFor(() => expect(modelDownloads).toBeGreaterThan(0))
        release()
        await Promise.all([
            operation(lifecycle, first, one.operationId),
            operation(lifecycle, second, two.operationId),
        ])

        expect(two.operationId).toBe(one.operationId)
        expect(modelDownloads).toBe(1)
    })

    it.each([
        ["quota", "Insufficient model artifact storage quota", "QUOTA_EXCEEDED", false],
        ["network", "Artifact transport returned status 503", "NETWORK", true],
        ["integrity", "Artifact SHA-256 verification failed", "INTEGRITY_MISMATCH", false],
        ["internal", "sensitive backend detail", "INTERNAL", false],
    ] as const)(
        "normalizes %s failures",
        async (_label, message, code, retryable) => {
            const { lifecycle, queue } = setup({
                download: async () => {
                    if (code === "INTERNAL") {
                        throw new PluginApiError("INTERNAL", message)
                    }
                    throw new Error(message)
                },
            })
            const owner = execution(`owner-${code}`).context
            const installed = await approvedInstall(lifecycle, queue, owner)

            const snapshot = await operation(lifecycle, owner, installed.operationId)
            expect(snapshot).toMatchObject({
                    state: "failed",
                    error: { code, retryable },
                })
            if (code === "INTERNAL") {
                expect(snapshot.error?.message).toBe("Internal plugin API error")
            }
        },
    )

    it("keeps an approved Host download alive after its starting instance unloads", async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const progress: LocalModelProgress[] = []
        const { lifecycle, queue, store } = setup({
            download: async (options) => {
                await gate
                options.onProgress?.({
                    phase: "verifying",
                    loadedBytes: options.artifact.bytes,
                    totalBytes: options.artifact.bytes,
                })
                store.set(options.artifact, "verified")
                return {
                    state: "verified",
                    bytes: options.artifact.bytes,
                    resumed: false,
                }
            },
        })
        const owner = execution("owner")
        const installed = await approvedInstall(
            lifecycle,
            queue,
            owner.context,
            (update) => progress.push(update),
        )
        owner.abort.abort()
        const callbacksBeforeRelease = progress.length
        release()

        await expect(
            operation(lifecycle, owner.context, installed.operationId),
        ).resolves.toMatchObject({ state: "succeeded" })
        expect(progress).toHaveLength(callbacksBeforeRelease)
    })

    it("rejects queued device removal when an approved install becomes active", async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const { lifecycle, queue, store } = setup({
            download: async (options) => {
                if (options.artifact.name === "model.onnx") await gate
                store.set(options.artifact, "verified")
                return {
                    state: "verified",
                    bytes: options.artifact.bytes,
                    resumed: false,
                }
            },
        })
        store.set(profile.artifacts[0], "partial", 91)
        const owner = execution("owner").context

        const installation = lifecycle.installLocalModel(owner, PIXAI_PROFILE_ID)
        const removal = lifecycle.removeLocalModel(owner, PIXAI_PROFILE_ID, {
            scope: "device",
        })
        await queue.whenPresented()
        expect(queue.current()?.request.kind).toBe("model-install")
        decide(queue, true)
        const installed = await installation
        await queue.whenPresented()
        expect(queue.current()?.request.kind).toBe("model-remove")
        decide(queue, true)
        const [removalResult] = await Promise.allSettled([removal])
        release()
        await operation(lifecycle, owner, installed.operationId)

        expect(removalResult).toEqual(
            expect.objectContaining({
                status: "rejected",
                reason: expect.objectContaining({ code: "CONFLICT" }),
            }),
        )
        expect(store.removeCalls).toBe(0)
    })

    it("confirms device removal, preserves bytes on denial, and purges on approval", async () => {
        const { lifecycle, queue, store } = setup()
        const owner = execution("owner").context
        const installed = await approvedInstall(lifecycle, queue, owner)
        await operation(lifecycle, owner, installed.operationId)

        const denied = lifecycle.removeLocalModel(owner, PIXAI_PROFILE_ID, {
            scope: "device",
        })
        await queue.whenPresented()
        expect(queue.current()?.request.kind).toBe("model-remove")
        decide(queue, false)
        await expect(denied).rejects.toMatchObject({
            code: "PERMISSION_DENIED",
        })
        expect(store.states.size).toBe(profile.artifacts.length)

        const confirmed = lifecycle.removeLocalModel(owner, PIXAI_PROFILE_ID, {
            scope: "device",
        })
        await queue.whenPresented()
        decide(queue, true)
        await expect(confirmed).resolves.toEqual({
            releasedPluginReference: true,
            purgedBytes: profile.totalBytes,
            retainedForOtherOwners: false,
            pending: false,
        })
        expect(store.states.size).toBe(0)
    })

    it("defers the exact artifact purge through the inference barrier", async () => {
        let deferredPurge: (() => Promise<number>) | undefined
        const barrier: PixaiLifecycleInferenceBarrier = {
            assertInstallAllowed: () => undefined,
            removeWhenIdle: async (purge) => {
                deferredPurge = purge
                return { pending: true, purgedBytes: 0 }
            },
        }
        const { lifecycle, store } = setup({ barrier })
        store.set(profile.artifacts[0], "verified")
        store.set(profile.artifacts[1], "partial", 37)

        await expect(
            lifecycle.removeLocalModel(execution("owner").context, PIXAI_PROFILE_ID),
        ).resolves.toEqual({
            releasedPluginReference: false,
            purgedBytes: 0,
            retainedForOtherOwners: false,
            pending: true,
        })
        expect(store.removeCalls).toBe(0)
        if (!deferredPurge) throw new Error("purge closure was not retained")
        await expect(deferredPurge()).resolves.toBe(
            profile.artifacts[0].bytes + 37,
        )
        expect(store.removeCalls).toBe(2)
        expect(store.states.size).toBe(0)
    })

    it("retains shared artifacts without opening the inference barrier", async () => {
        const removeWhenIdle = vi.fn(async (purge: () => Promise<number>) => ({
            pending: false,
            purgedBytes: await purge(),
        }))
        const barrier: PixaiLifecycleInferenceBarrier = {
            assertInstallAllowed: () => undefined,
            removeWhenIdle,
        }
        const { lifecycle, queue, store } = setup({ barrier })
        const first = execution("first").context
        const second = execution("second").context
        const firstInstall = await approvedInstall(lifecycle, queue, first)
        await operation(lifecycle, first, firstInstall.operationId)
        const secondInstall = await approvedInstall(lifecycle, queue, second)
        await operation(lifecycle, second, secondInstall.operationId)

        await expect(
            lifecycle.removeLocalModel(first, PIXAI_PROFILE_ID),
        ).resolves.toEqual({
            releasedPluginReference: true,
            purgedBytes: 0,
            retainedForOtherOwners: true,
            pending: false,
        })
        expect(removeWhenIdle).not.toHaveBeenCalled()
        expect(store.states.size).toBe(profile.artifacts.length)
    })

    it("defaults plugin removal to include resumable partial bytes", async () => {
        const { lifecycle, store, queue } = setup()
        const owner = execution("owner").context
        store.set(profile.artifacts[0], "partial", 91)

        await expect(
            lifecycle.removeLocalModel(owner, PIXAI_PROFILE_ID),
        ).resolves.toEqual({
            releasedPluginReference: false,
            purgedBytes: 91,
            retainedForOtherOwners: false,
            pending: false,
        })
        expect(store.states.size).toBe(0)
        expect(queue.current()).toBeNull()
    })

    it("evicts the oldest terminal record at 101 and expires after seven days", async () => {
        let now = 0
        let nextId = 0
        const { lifecycle, queue } = setup({
            now: () => now,
            createOperationId: () =>
                `lmo_${String(1_000 - ++nextId).padStart(4, "0")}`,
        })
        const owner = execution("owner").context
        const ids: string[] = []

        for (let index = 0; index < 101; index += 1) {
            const installed = await approvedInstall(lifecycle, queue, owner)
            ids.push(installed.operationId)
            await operation(lifecycle, owner, installed.operationId)
        }

        await expect(
            lifecycle.getLocalModelOperation(owner, ids[0]),
        ).rejects.toMatchObject({ code: "NOT_FOUND" })
        await expect(
            lifecycle.getLocalModelOperation(owner, ids[1]),
        ).resolves.toMatchObject({ state: "succeeded" })

        now += TERMINAL_OPERATION_TTL_MS + 1
        await expect(
            lifecycle.getLocalModelOperation(owner, ids.at(-1)!),
        ).rejects.toMatchObject({ code: "NOT_FOUND" })
    })

    it("rejects unregistered profiles, malformed IDs, and non-exact options", async () => {
        const { lifecycle } = setup()
        const owner = execution("owner").context

        await expect(
            lifecycle.getLocalModelStatus(owner, "other-profile"),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
        await expect(
            lifecycle.getLocalModelOperation(owner, "x".repeat(129)),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
        await expect(
            lifecycle.removeLocalModel(owner, PIXAI_PROFILE_ID, {
                scope: "plugin",
                extra: true,
            } as never),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
    })
})
