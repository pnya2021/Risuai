import { describe, expect, it, vi } from "vitest"
import type { InlayAssetRecord } from "src/ts/process/files/inlays"
import { PluginApiError } from "../illustration/errors"
import type {
    PluginExecutionContext,
    PluginPermissionId,
} from "../illustration/permissions"
import type { LocalModelStatus } from "./pixaiInstallLifecycle"
import type { PixaiImageRunOutput } from "./pixaiOrtWorkerClient"
import { getPixaiProfile, PIXAI_PROFILE_ID } from "./pixaiRegistry"
import {
    PixaiLocalModel,
    withPixaiInferenceCapability,
    type PixaiLocalModelBroker,
} from "./pixaiLocalModel"

const PRINCIPAL = "11111111-1111-4111-8111-111111111111"
const INSTANCE = "22222222-2222-4222-8222-222222222222"
const SESSION = "33333333-3333-4333-8333-333333333333"
const FOREIGN = "44444444-4444-4444-8444-444444444444"
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const profile = getPixaiProfile(PIXAI_PROFILE_ID)

const context = (controller = new AbortController()): PluginExecutionContext => ({
    principalId: PRINCIPAL,
    instanceId: INSTANCE,
    displayName: "Illustrator",
    internalName: "illustrator",
    signal: controller.signal,
})

const internalResult = (): PixaiImageRunOutput => {
    const result = {
        modelProfileId: profile.id,
        modelRevision: profile.revision,
        modelSha256: profile.artifacts[0]!.sha256,
        preprocessVersion: profile.preprocessing.version,
        provider: "wasm" as const,
        tags: [{ index: 1, name: "1girl", score: 0.9, category: "general" as const }],
        thresholds: { general: 0.3, character: 0.85 },
        truncated: false,
        timings: {
            decodeMs: 1,
            preprocessMs: 2,
            inferenceMs: 3,
            postprocessMs: 4,
            totalMs: 10,
        },
        warnings: [] as const,
        tensor: new Float32Array([123]),
        rawScores: new Float32Array([0.9]),
    }
    return result
}

const broker = (overrides: Partial<PixaiLocalModelBroker> = {}): PixaiLocalModelBroker => ({
    acquire: vi.fn(async () => ({ sessionId: SESSION, provider: "wasm" as const })),
    run: vi.fn(async () => internalResult()),
    release: vi.fn(async () => undefined),
    releaseInstance: vi.fn(async () => undefined),
    ...overrides,
})

function setup(overrides: {
    context?: PluginExecutionContext
    broker?: PixaiLocalModelBroker
    getBroker?: () => PixaiLocalModelBroker
    getStatus?: () => Promise<LocalModelStatus>
    backendHealthy?: () => boolean | Promise<boolean>
    storageBackend?: "opfs" | "cache"
    readContextAsset?: (...args: any[]) => Promise<any>
    getInlayAssetRecord?: (id: string) => Promise<InlayAssetRecord | null>
    getInlayAssetBlob?: (id: string) => Promise<({ data: Blob } & Record<string, unknown>) | null>
    requirePermission?: (permission: PluginPermissionId) => Promise<void>
} = {}) {
    const modelBroker = overrides.broker ?? broker()
    const getBroker = vi.fn(overrides.getBroker ?? (() => modelBroker))
    const permission = vi.fn(overrides.requirePermission ?? (async () => undefined))
    const readContextAsset = vi.fn(overrides.readContextAsset ?? (async () => ({
        data: png.slice(),
        revision: `sha256:${"a".repeat(64)}`,
        name: "card.png",
        mediaType: "image/png",
    })))
    const getInlayAssetRecord = vi.fn(overrides.getInlayAssetRecord ?? (async () => null))
    const getInlayAssetBlob = vi.fn(overrides.getInlayAssetBlob ?? (async () => null))
    const facade = new PixaiLocalModel({
        context: overrides.context ?? context(),
        getBroker,
        getStatus: overrides.getStatus ?? (async () => ({ state: "ready" })),
        backendHealthy: overrides.backendHealthy ?? (() => true),
        storageBackend: overrides.storageBackend ?? "opfs",
        contextResources: { readContextAsset },
        requirePermission: permission,
        getInlayAssetRecord,
        getInlayAssetBlob,
    })
    return {
        facade,
        broker: modelBroker,
        getBroker,
        permission,
        readContextAsset,
        getInlayAssetRecord,
        getInlayAssetBlob,
    }
}

async function revision(data: Uint8Array) {
    const digest = await crypto.subtle.digest("SHA-256", data.slice().buffer)
    return `sha256:${[...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0")).join("")}`
}

async function deterministicInlayId(owner: string, idempotencyKey: string) {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([
            owner,
            "inlay.create.v1",
            idempotencyKey,
        ])),
    )
    return `inlay_${[...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0")).join("")}`
}

async function ownedRecord(owner = PRINCIPAL): Promise<InlayAssetRecord> {
    return {
        data: new Blob([png]),
        ext: "png",
        name: "owned.png",
        type: "image",
        lifecycle: {
            version: 1,
            ownerPrincipalId: owner,
            operation: "inlay.create.v1",
            idempotencyKey: "base-character",
            argumentDigest: "a".repeat(64),
            revision: await revision(png),
            context: { kind: "character", characterId: "card-1" },
        },
    }
}

describe("Risu PixaiLocalModel facade", () => {
    it("health-gates discovery only when PixAI is requested", async () => {
        const unrelatedProbe = vi.fn(async () => true)
        const unrelated = await withPixaiInferenceCapability(
            ["context.current.v1"],
            ["context.current.v1"],
            unrelatedProbe,
        )
        expect(unrelatedProbe).not.toHaveBeenCalled()
        expect(unrelated.has("local-model.pixai-v0.9.v1")).toBe(false)

        const healthy = await withPixaiInferenceCapability(undefined, [], async () => true)
        expect(healthy.has("local-model.pixai-v0.9.v1")).toBe(true)
        await expect(withPixaiInferenceCapability(
            ["local-model.pixai-v0.9.v1"],
            [],
            async () => { throw new Error("native detail") },
        )).resolves.toEqual(new Set())
    })

    it("maps backend and no-prompt model status into fixed capabilities", async () => {
        const ready = setup({ storageBackend: "cache" })
        await expect(ready.facade.getLocalModelCapabilities(PIXAI_PROFILE_ID)).resolves.toEqual({
            supported: true,
            reasons: [],
            providers: {
                wasm: { available: true },
                webgpu: { available: false, reason: "unsupported-provider" },
                node: { available: false, reason: "unsupported-provider" },
            },
            storage: { backend: "cache", persistent: true, resumable: true },
            limits: {
                maxInputBytes: 33_554_432,
                maxInputPixels: 64_000_000,
                maxResultTags: 500,
            },
        })
        expect(ready.permission).not.toHaveBeenCalled()
        expect(ready.getBroker).not.toHaveBeenCalled()

        const absent = setup({ getStatus: async () => ({ state: "absent" }) })
        await expect(absent.facade.getLocalModelCapabilities(PIXAI_PROFILE_ID)).resolves.toMatchObject({
            supported: true,
            reasons: ["model-not-ready"],
            providers: { wasm: { available: false, reason: "model-not-ready" } },
        })
        const unhealthy = setup({ backendHealthy: () => false })
        await expect(unhealthy.facade.getLocalModelCapabilities(PIXAI_PROFILE_ID)).resolves.toMatchObject({
            supported: false,
            reasons: ["runtime-unavailable"],
            providers: { wasm: { available: false, reason: "runtime-unavailable" } },
        })
    })

    it("requires permission for acquire/run, maps a bounded result, and not for release", async () => {
        const h = setup()
        await expect(h.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)).resolves.toEqual({
            sessionId: SESSION,
            provider: "wasm",
        })
        const result = await h.facade.runLocalModel(SESSION, {
            image: { kind: "bytes", data: png, mediaType: "image/png" },
            categories: ["general"],
        })
        expect(result).toEqual({
            model: {
                profile: profile.id,
                revision: profile.revision,
                sha256: profile.artifacts[0]!.sha256,
                preprocessVersion: profile.preprocessing.version,
            },
            execution: { provider: "wasm" },
            tags: [{ index: 1, name: "1girl", score: 0.9, category: "general" }],
            thresholds: { general: 0.3, character: 0.85 },
            truncated: false,
            timingMs: { decode: 1, preprocess: 2, inference: 3, postprocess: 4, total: 10 },
            warnings: [],
        })
        expect(result).not.toHaveProperty("modelProfileId")
        expect(result).not.toHaveProperty("timings")
        expect(result).not.toHaveProperty("tensor")
        expect(result).not.toHaveProperty("rawScores")
        await h.facade.releaseLocalModelSession(SESSION)
        expect(h.permission.mock.calls).toEqual([
            ["localModelInference"],
            ["localModelInference"],
        ])
        expect(h.broker.release).toHaveBeenCalledWith({
            principalId: PRINCIPAL,
            instanceId: INSTANCE,
            sessionId: SESSION,
        })
        await expect(h.facade.runLocalModel(SESSION, {
            image: { kind: "bytes", data: png, mediaType: "image/png" },
        })).rejects.toMatchObject({ code: "NOT_FOUND" })
    })

    it("copies direct bytes before permission awaits and rejects hostile shapes", async () => {
        let allow!: () => void
        const h = setup({
            requirePermission: () => new Promise<void>((resolve) => { allow = resolve }),
        })
        const acquiring = h.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)
        allow()
        await acquiring
        const source = png.slice()
        const expected = source.slice()
        const running = h.facade.runLocalModel(SESSION, {
            image: { kind: "bytes", data: source, mediaType: "image/png" },
        })
        source.fill(0)
        allow()
        await running
        const sent = vi.mocked(h.broker.run).mock.calls[0]![0].image.data
        expect(sent).toEqual(expected)
        expect(sent).not.toBe(source)

        const hostile = Object.defineProperty({}, "image", {
            enumerable: true,
            get() { throw new Error("raw getter") },
        })
        await expect(h.facade.runLocalModel(SESSION, hostile)).rejects.toMatchObject({
            code: "INVALID_ARGUMENT",
        })
        await expect(h.facade.runLocalModel(SESSION, {
            image: { kind: "bytes", data: new Uint8Array([1]), mediaType: "image/png" },
        })).rejects.toMatchObject({ code: "DECODE_FAILED" })
        expect(h.broker.run).toHaveBeenCalledTimes(1)
    })

    it("delegates context assets with exact bounds and validates returned media", async () => {
        const assetRevision = `sha256:${"b".repeat(64)}`
        const h = setup({
            readContextAsset: async () => ({
                data: png.slice(),
                revision: assetRevision,
                name: "portrait.png",
                mediaType: "image/png",
            }),
        })
        await h.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)
        await h.facade.runLocalModel(SESSION, {
            image: {
                kind: "context-asset",
                assetId: `ctxasset_${"a".repeat(64)}`,
                revision: assetRevision,
            },
        })
        expect(h.readContextAsset).toHaveBeenCalledWith(
            `ctxasset_${"a".repeat(64)}`,
            {
                ifRevision: assetRevision,
                variant: "original",
                maxBytes: 33_554_432,
                signal: expect.any(AbortSignal),
            },
        )
        vi.mocked(h.readContextAsset).mockResolvedValueOnce({
            data: png.slice(),
            revision: assetRevision,
            name: "bad.gif",
            mediaType: "image/gif",
        })
        await expect(h.facade.runLocalModel(SESSION, {
            image: { kind: "context-asset", assetId: `ctxasset_${"a".repeat(64)}` },
        })).rejects.toMatchObject({ code: "DECODE_FAILED" })
        expect(h.broker.run).toHaveBeenCalledTimes(1)
    })

    it("uses deterministic lifecycle identity for Inlay source permission", async () => {
        const own = await ownedRecord()
        const foreign = await ownedRecord(FOREIGN)
        const legacy = { ...own, lifecycle: undefined }
        const malformed = { ...own }
        Object.defineProperty(malformed, "lifecycle", {
            enumerable: true,
            get: () => own.lifecycle,
        })
        const records = [own, own, foreign, foreign, legacy, legacy, malformed, malformed]
        const h = setup({
            getInlayAssetRecord: async () => records.shift() ?? null,
            getInlayAssetBlob: async () => ({ data: new Blob([png]) }),
        })
        await h.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)
        for (const inlayId of [
            await deterministicInlayId(PRINCIPAL, own.lifecycle!.idempotencyKey),
            await deterministicInlayId(FOREIGN, foreign.lifecycle!.idempotencyKey),
            "legacy-id",
            "malformed-id",
        ]) {
            await h.facade.runLocalModel(SESSION, {
                image: { kind: "inlay", inlayId, revision: await revision(png) },
            })
        }
        expect(h.permission.mock.calls).toEqual([
            ["localModelInference"],
            ["localModelInference"], ["inlayWrite"],
            ["localModelInference"], ["inlayRead"],
            ["localModelInference"], ["inlayRead"],
            ["localModelInference"], ["inlayRead"],
        ])

        const relocated = setup({
            getInlayAssetRecord: async () => own,
            getInlayAssetBlob: async () => ({ data: new Blob([png]) }),
            requirePermission: async (permission) => {
                if (permission === "inlayRead") {
                    throw new PluginApiError("PERMISSION_DENIED", "Foreign Inlay denied")
                }
            },
        })
        await relocated.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)
        await expect(relocated.facade.runLocalModel(SESSION, {
            image: { kind: "inlay", inlayId: "relocated-id" },
        })).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
        expect(relocated.broker.run).not.toHaveBeenCalled()
    })

    it("rejects Inlay revision, record race, size, and media failures before broker run", async () => {
        const own = await ownedRecord()
        const ownId = await deterministicInlayId(PRINCIPAL, own.lifecycle!.idempotencyKey)
        const changed = {
            ...own,
            lifecycle: { ...own.lifecycle!, revision: `sha256:${"f".repeat(64)}` },
        }
        const records = [own, changed]
        const race = setup({
            getInlayAssetRecord: async () => records.shift() ?? null,
            getInlayAssetBlob: async () => ({ data: new Blob([png]) }),
        })
        await race.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)
        await expect(race.facade.runLocalModel(SESSION, {
            image: { kind: "inlay", inlayId: ownId },
        })).rejects.toMatchObject({ code: "CONFLICT" })
        expect(race.broker.run).not.toHaveBeenCalled()

        for (const entry of [
            { blob: new Blob([png]), requested: `sha256:${"0".repeat(64)}` },
            { blob: new Blob([new Uint8Array(33_554_433)]), requested: undefined },
            { blob: new Blob([new TextEncoder().encode("not-image")]), requested: undefined },
        ]) {
            const record = { ...own, lifecycle: undefined }
            const failure = setup({
                getInlayAssetRecord: async () => record,
                getInlayAssetBlob: async () => ({ data: entry.blob }),
            })
            await failure.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)
            await expect(failure.facade.runLocalModel(SESSION, {
                image: {
                    kind: "inlay",
                    inlayId: "legacy-id",
                    ...(entry.requested ? { revision: entry.requested } : {}),
                },
            })).rejects.toMatchObject({
                code: expect.stringMatching(/CONFLICT|RESOURCE_LIMIT|DECODE_FAILED/),
            })
            expect(failure.broker.run).not.toHaveBeenCalled()
        }
    })

    it("closes pre/during/late abort without an orphan lease", async () => {
        const preController = new AbortController()
        preController.abort()
        const pre = setup({ context: context(preController) })
        await expect(pre.facade.acquireLocalModelSession(PIXAI_PROFILE_ID))
            .rejects.toMatchObject({ code: "ABORTED" })
        expect(pre.permission).not.toHaveBeenCalled()

        const callerController = new AbortController()
        callerController.abort()
        const caller = setup()
        await expect(caller.facade.acquireLocalModelSession(
            PIXAI_PROFILE_ID,
            { signal: callerController.signal },
        )).rejects.toMatchObject({ code: "ABORTED" })
        expect(caller.permission).not.toHaveBeenCalled()

        const duringController = new AbortController()
        let finishPermission!: () => void
        const during = setup({
            context: context(duringController),
            requirePermission: () => new Promise<void>((resolve) => {
                finishPermission = resolve
            }),
        })
        const duringAcquire = during.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)
        duringController.abort()
        finishPermission()
        await expect(duringAcquire).rejects.toMatchObject({ code: "ABORTED" })
        expect(during.broker.acquire).not.toHaveBeenCalled()

        const lateController = new AbortController()
        let finishAcquire!: () => void
        const lateBroker = broker({
            acquire: vi.fn(() => new Promise<{ sessionId: string; provider: "wasm" }>((resolve) => {
                finishAcquire = () => resolve({ sessionId: SESSION, provider: "wasm" })
            })),
        })
        const late = setup({ context: context(lateController), broker: lateBroker })
        const lateAcquire = late.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)
        await Promise.resolve()
        lateController.abort()
        finishAcquire()
        await expect(lateAcquire).rejects.toMatchObject({ code: "ABORTED" })
        expect(lateBroker.release).toHaveBeenCalledWith({
            principalId: PRINCIPAL,
            instanceId: INSTANCE,
            sessionId: SESSION,
        })
    })

    it("releaseAll clears local ownership and calls releaseInstance once after unload", async () => {
        const controller = new AbortController()
        const modelBroker = broker({
            releaseInstance: vi.fn(async () => {
                throw new PluginApiError("PROVIDER_ERROR", "private detail")
            }),
        })
        const h = setup({ context: context(controller), broker: modelBroker })
        await h.facade.acquireLocalModelSession(PIXAI_PROFILE_ID)
        controller.abort()
        await expect(h.facade.releaseAll()).resolves.toBeUndefined()
        expect(modelBroker.releaseInstance).toHaveBeenCalledTimes(1)
        expect(modelBroker.releaseInstance).toHaveBeenCalledWith(PRINCIPAL, INSTANCE)
        expect(h.permission).toHaveBeenCalledTimes(1)
        await expect(h.facade.releaseLocalModelSession(SESSION))
            .rejects.toMatchObject({ code: "NOT_FOUND" })
    })
})
