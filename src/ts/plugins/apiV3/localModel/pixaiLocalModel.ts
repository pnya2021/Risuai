import type { InlayAssetRecord } from "src/ts/process/files/inlays"
import type { ContextResourceService } from "../illustration/contextResources"
import { PluginApiError } from "../illustration/errors"
import type {
    PluginExecutionContext,
    PluginPermissionId,
} from "../illustration/permissions"
import type { LocalModelStatus } from "./pixaiInstallLifecycle"
import type {
    PixaiImageRunInput,
    PixaiImageRunOutput,
} from "./pixaiOrtWorkerClient"
import { getPixaiProfile, PIXAI_PROFILE_ID } from "./pixaiRegistry"

const MAX_INPUT_BYTES = 33_554_432
const MAX_INPUT_PIXELS = 64_000_000
const MAX_RESULT_TAGS = 500
const MAX_WARNINGS = 16
const MAX_TEXT_BYTES = 512
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REVISION = /^sha256:[0-9a-f]{64}$/
const CONTEXT_ASSET_ID = /^ctxasset_[0-9a-f]{64}$/
const INLAY_ID = /^[A-Za-z0-9_-]{1,128}$/
const DIGEST = /^[0-9a-f]{64}$/

export const PIXAI_INFERENCE_CAPABILITY_ID = "local-model.pixai-v0.9.v1"

export type LocalModelProvider = "auto" | "webgpu" | "wasm" | "node"
export type LocalModelMediaType = "image/jpeg" | "image/png" | "image/webp"
export type LocalModelCategory = "general" | "character"
export type LocalModelStorageBackend = "opfs" | "cache"

export type LocalImageSource =
    | { kind: "context-asset"; assetId: string; revision?: string }
    | { kind: "inlay"; inlayId: string; revision?: string }
    | { kind: "bytes"; data: Uint8Array; mediaType: LocalModelMediaType }

export interface LocalModelCapabilities {
    supported: boolean
    reasons: string[]
    providers: Record<
        "webgpu" | "wasm" | "node",
        { available: boolean; reason?: string }
    >
    storage: {
        backend: LocalModelStorageBackend
        persistent: boolean
        resumable: boolean
    }
    limits: {
        maxInputBytes: number
        maxInputPixels: number
        maxResultTags: number
    }
}

export interface PixaiLocalModelBroker {
    acquire(input: {
        principalId: string
        instanceId: string
        provider?: unknown
        signal?: AbortSignal
    }): Promise<{ sessionId: string; provider: "wasm" }>
    run(input: {
        principalId: string
        instanceId: string
        sessionId: string
        image: PixaiImageRunInput
        signal?: AbortSignal
    }): Promise<PixaiImageRunOutput>
    release(input: {
        principalId: string
        instanceId: string
        sessionId: string
    }): Promise<void>
    releaseInstance(principalId: string, instanceId: string): Promise<void>
}

export interface PixaiLocalModelOptions {
    context: PluginExecutionContext
    getBroker(): PixaiLocalModelBroker
    getStatus(profile: string): Promise<LocalModelStatus>
    contextResources: Pick<ContextResourceService, "readContextAsset">
    requirePermission(permission: PluginPermissionId): Promise<void>
    getInlayAssetRecord(id: string): Promise<InlayAssetRecord | null>
    getInlayAssetBlob(
        id: string,
    ): Promise<({ data: Blob } & Record<string, unknown>) | null>
    backendHealthy(): boolean | Promise<boolean>
    storageBackend: LocalModelStorageBackend
}

type NormalizedImageSource =
    | { kind: "context-asset"; assetId: string; revision?: string }
    | { kind: "inlay"; inlayId: string; revision?: string }
    | { kind: "bytes"; data: Uint8Array; mediaType: LocalModelMediaType }

interface NormalizedRunRequest {
    image: NormalizedImageSource
    thresholds?: Partial<Record<LocalModelCategory, number>>
    categories?: LocalModelCategory[]
    maxResults?: number
}

export async function withPixaiInferenceCapability(
    ids: readonly string[] | undefined,
    registeredServices: Iterable<string>,
    backendHealthy: () => Promise<boolean>,
): Promise<Set<string>> {
    const result = new Set(registeredServices)
    if (ids !== undefined && !ids.includes(PIXAI_INFERENCE_CAPABILITY_ID)) {
        return result
    }
    try {
        if (await backendHealthy()) result.add(PIXAI_INFERENCE_CAPABILITY_ID)
    } catch {
        // An unsupported or unhealthy runtime remains unavailable.
    }
    return result
}

const invalid = (message = "Invalid local model inference request"): never => {
    throw new PluginApiError("INVALID_ARGUMENT", message)
}

const aborted = (): never => {
    throw new PluginApiError("ABORTED", "Local model inference aborted")
}

const internal = (): never => {
    throw new PluginApiError("INTERNAL", "Internal plugin API error")
}

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

function exactObject(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
    label = "local model value",
): Record<string, unknown> {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            invalid(`Invalid ${label}`)
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
            invalid(`Invalid ${label}`)
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            invalid(`Invalid ${label}`)
        }
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const allowed = new Set([...required, ...optional])
        const keys = Object.keys(descriptors)
        if (
            required.some((key) => !Object.hasOwn(descriptors, key)) ||
            keys.some((key) => !allowed.has(key)) ||
            keys.length < required.length ||
            keys.length > required.length + optional.length
        ) {
            invalid(`Invalid ${label}`)
        }
        const result: Record<string, unknown> = Object.create(null)
        for (const key of keys) {
            const descriptor = descriptors[key]!
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
                invalid(`Invalid ${label}`)
            }
            result[key] = descriptor.value
        }
        return result
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        return invalid(`Invalid ${label}`)
    }
}

function exactArray(value: unknown, label: string): unknown[] {
    try {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
            invalid(`Invalid ${label}`)
        }
        const array = value as unknown[]
        const keys = Reflect.ownKeys(array)
        if (
            keys.length !== array.length + 1 ||
            !keys.includes("length") ||
            keys.some((key) =>
                typeof key === "symbol" ||
                (key !== "length" && !/^\d+$/.test(key)))
        ) {
            invalid(`Invalid ${label}`)
        }
        for (let index = 0; index < array.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(array, String(index))
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
                invalid(`Invalid ${label}`)
            }
        }
        return array
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        return invalid(`Invalid ${label}`)
    }
}

const assertProfile = (value: unknown) => {
    if (value !== PIXAI_PROFILE_ID) invalid("Unsupported local model profile")
    return PIXAI_PROFILE_ID
}

const assertRevision = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== "string" || !REVISION.test(value)) {
        invalid("Invalid image revision")
    }
    return value as string
}

const assertSessionId = (value: unknown): string => {
    if (typeof value !== "string" || !UUID_V4.test(value)) {
        invalid("Invalid local model session ID")
    }
    return (value as string).toLowerCase()
}

const sniffMediaType = (data: Uint8Array): LocalModelMediaType | undefined => {
    if (
        data.byteLength >= 8 &&
        data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
        data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
    ) return "image/png"
    if (
        data.byteLength >= 3 &&
        data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    ) return "image/jpeg"
    if (
        data.byteLength >= 12 &&
        String.fromCharCode(...data.subarray(0, 4)) === "RIFF" &&
        String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
    ) return "image/webp"
    return undefined
}

function validateImageBytes(
    value: unknown,
    expectedMediaType?: unknown,
): { data: Uint8Array; mediaType: LocalModelMediaType } {
    if (
        !(value instanceof Uint8Array) ||
        Object.getPrototypeOf(value) !== Uint8Array.prototype
    ) {
        invalid("Image data must be a Uint8Array")
    }
    const bytes = value as Uint8Array
    if (bytes.byteLength < 1) {
        throw new PluginApiError("DECODE_FAILED", "Image data is empty")
    }
    if (bytes.byteLength > MAX_INPUT_BYTES) {
        throw new PluginApiError(
            "RESOURCE_LIMIT",
            "Image data exceeds the advertised limit",
        )
    }
    const data = bytes.slice()
    const actual = sniffMediaType(data)
    if (!actual) {
        throw new PluginApiError("DECODE_FAILED", "Unsupported or invalid local image")
    }
    if (expectedMediaType !== undefined) {
        if (
            expectedMediaType !== "image/jpeg" &&
            expectedMediaType !== "image/png" &&
            expectedMediaType !== "image/webp"
        ) {
            throw new PluginApiError(
                "DECODE_FAILED",
                "Unsupported local image media type",
            )
        }
        if (actual !== expectedMediaType) {
            throw new PluginApiError(
                "DECODE_FAILED",
                "Local image media type does not match its bytes",
            )
        }
    }
    return { data, mediaType: actual }
}

function normalizeImageSource(value: unknown): NormalizedImageSource {
    const source = exactObject(
        value,
        ["kind"],
        ["assetId", "inlayId", "revision", "data", "mediaType"],
        "image source",
    )
    if (source.kind === "context-asset") {
        const exact = exactObject(
            value,
            ["kind", "assetId"],
            ["revision"],
            "context asset source",
        )
        if (
            typeof exact.assetId !== "string" ||
            !CONTEXT_ASSET_ID.test(exact.assetId)
        ) {
            invalid("Invalid context asset handle")
        }
        const revision = assertRevision(exact.revision)
        return {
            kind: "context-asset",
            assetId: exact.assetId as string,
            ...(revision === undefined ? {} : { revision }),
        }
    }
    if (source.kind === "inlay") {
        const exact = exactObject(
            value,
            ["kind", "inlayId"],
            ["revision"],
            "Inlay source",
        )
        if (typeof exact.inlayId !== "string" || !INLAY_ID.test(exact.inlayId)) {
            invalid("Invalid Inlay ID")
        }
        const revision = assertRevision(exact.revision)
        return {
            kind: "inlay",
            inlayId: exact.inlayId as string,
            ...(revision === undefined ? {} : { revision }),
        }
    }
    if (source.kind === "bytes") {
        const exact = exactObject(
            value,
            ["kind", "data", "mediaType"],
            [],
            "byte image source",
        )
        const image = validateImageBytes(exact.data, exact.mediaType)
        return { kind: "bytes", ...image }
    }
    return invalid("Invalid image source kind")
}

const normalizeThresholds = (value: unknown) => {
    if (value === undefined) return undefined
    const data = exactObject(
        value,
        [],
        ["general", "character"],
        "local model thresholds",
    )
    const result: Partial<Record<LocalModelCategory, number>> = {}
    for (const category of ["general", "character"] as const) {
        const threshold = data[category]
        if (threshold === undefined) continue
        if (
            typeof threshold !== "number" ||
            !Number.isFinite(threshold) ||
            threshold < 0 ||
            threshold > 1
        ) {
            invalid("Invalid local model threshold")
        }
        result[category] = threshold as number
    }
    return result
}

const normalizeCategories = (value: unknown) => {
    if (value === undefined) return undefined
    const categories = exactArray(value, "local model categories")
    if (categories.length < 1 || categories.length > 2) {
        invalid("Invalid local model categories")
    }
    const result: LocalModelCategory[] = []
    for (const category of categories) {
        if (
            (category !== "general" && category !== "character") ||
            result.includes(category)
        ) {
            invalid("Invalid local model categories")
        }
        result.push(category as LocalModelCategory)
    }
    return result
}

function normalizeRunRequest(value: unknown): NormalizedRunRequest {
    const data = exactObject(
        value,
        ["image"],
        ["thresholds", "categories", "maxResults"],
        "local model run request",
    )
    const thresholds = normalizeThresholds(data.thresholds)
    const categories = normalizeCategories(data.categories)
    if (
        data.maxResults !== undefined &&
        (
            !Number.isSafeInteger(data.maxResults) ||
            (data.maxResults as number) < 1 ||
            (data.maxResults as number) > MAX_RESULT_TAGS
        )
    ) {
        invalid("Invalid local model result limit")
    }
    return {
        image: normalizeImageSource(data.image),
        ...(thresholds === undefined ? {} : { thresholds }),
        ...(categories === undefined ? {} : { categories }),
        ...(data.maxResults === undefined
            ? {}
            : { maxResults: data.maxResults as number }),
    }
}

function normalizeSignalOptions(value: unknown, allowProvider: boolean) {
    if (value === undefined) {
        return { provider: "auto" as LocalModelProvider, signal: undefined }
    }
    const data = exactObject(
        value,
        [],
        allowProvider ? ["provider", "signal"] : ["signal"],
        "local model options",
    )
    const provider = data.provider === undefined ? "auto" : data.provider
    if (
        provider !== "auto" &&
        provider !== "webgpu" &&
        provider !== "wasm" &&
        provider !== "node"
    ) {
        invalid("Invalid local model provider")
    }
    if (data.signal !== undefined && !(data.signal instanceof AbortSignal)) {
        invalid("Invalid abort signal")
    }
    return {
        provider: provider as LocalModelProvider,
        signal: data.signal as AbortSignal | undefined,
    }
}

function combinedSignal(contextSignal: AbortSignal, callerSignal?: AbortSignal) {
    const controller = new AbortController()
    const signals = [...new Set(
        [contextSignal, callerSignal].filter(
            (value): value is AbortSignal => Boolean(value),
        ),
    )]
    const onAbort = () => controller.abort()
    for (const signal of signals) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener("abort", onAbort, { once: true })
    }
    return {
        signal: controller.signal,
        dispose: () => {
            for (const signal of signals) {
                signal.removeEventListener("abort", onAbort)
            }
        },
    }
}

const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) aborted()
}

function sanitize(error: unknown, signal?: AbortSignal): never {
    if (
        signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
    ) {
        aborted()
    }
    if (error instanceof PluginApiError) throw error
    return internal()
}

function lifecycleValue(value: unknown): Record<string, unknown> | undefined {
    try {
        const data = exactObject(
            value,
            [
                "version", "ownerPrincipalId", "operation", "idempotencyKey",
                "argumentDigest", "revision", "context",
            ],
            [],
            "Inlay lifecycle",
        )
        const lifecycleContext = exactObject(
            data.context,
            ["kind", "characterId"],
            [],
            "Inlay lifecycle context",
        )
        if (
            data.version !== 1 ||
            typeof data.ownerPrincipalId !== "string" ||
            !UUID_V4.test(data.ownerPrincipalId) ||
            data.operation !== "inlay.create.v1" ||
            typeof data.idempotencyKey !== "string" ||
            data.idempotencyKey.length < 1 ||
            utf8Bytes(data.idempotencyKey) > 256 ||
            typeof data.argumentDigest !== "string" ||
            !DIGEST.test(data.argumentDigest) ||
            typeof data.revision !== "string" ||
            !REVISION.test(data.revision) ||
            lifecycleContext.kind !== "character" ||
            typeof lifecycleContext.characterId !== "string" ||
            lifecycleContext.characterId.length < 1 ||
            utf8Bytes(lifecycleContext.characterId) > MAX_TEXT_BYTES
        ) return undefined
        return {
            version: 1,
            ownerPrincipalId: data.ownerPrincipalId.toLowerCase(),
            operation: "inlay.create.v1",
            idempotencyKey: data.idempotencyKey,
            argumentDigest: data.argumentDigest,
            revision: data.revision,
            context: {
                kind: "character",
                characterId: lifecycleContext.characterId,
            },
        }
    } catch {
        return undefined
    }
}

function boundedFingerprint(value: unknown, depth = 0): unknown {
    if (depth > 4) return "[depth]"
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        return value
    }
    if (!value || typeof value !== "object") return `[${typeof value}]`
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const keys = Object.keys(descriptors).sort().slice(0, 32)
        const result: Record<string, unknown> = {}
        for (const key of keys) {
            const descriptor = descriptors[key]
            result[key] = descriptor && Object.hasOwn(descriptor, "value")
                ? boundedFingerprint(descriptor.value, depth + 1)
                : "[accessor]"
        }
        return result
    } catch {
        return "[unreadable]"
    }
}

async function sha256Revision(data: Uint8Array) {
    const digest = await crypto.subtle.digest("SHA-256", data.slice().buffer)
    return `sha256:${[...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0")).join("")}`
}

async function deterministicLifecycleInlayId(
    ownerPrincipalId: string,
    idempotencyKey: string,
) {
    const encoded = new TextEncoder().encode(JSON.stringify([
        ownerPrincipalId,
        "inlay.create.v1",
        idempotencyKey,
    ]))
    const revision = await sha256Revision(encoded)
    return `inlay_${revision.slice("sha256:".length)}`
}

async function lifecycleSnapshot(record: InlayAssetRecord, inlayId: string): Promise<{
    key: string
    owner?: string
    revision?: string
}> {
    let descriptor: PropertyDescriptor | undefined
    try {
        descriptor = Object.getOwnPropertyDescriptor(record, "lifecycle")
    } catch {
        return { key: "malformed:[unreadable]" }
    }
    if (!descriptor || (Object.hasOwn(descriptor, "value") && descriptor.value === undefined)) {
        return { key: "legacy" }
    }
    if (!Object.hasOwn(descriptor, "value")) return { key: "malformed:[accessor]" }
    const valid = lifecycleValue(descriptor.value)
    if (valid) {
        const expectedId = await deterministicLifecycleInlayId(
            valid.ownerPrincipalId as string,
            valid.idempotencyKey as string,
        )
        if (expectedId !== inlayId) {
            return { key: `relocated:${JSON.stringify(valid)}` }
        }
        return {
            key: `valid:${JSON.stringify(valid)}`,
            owner: valid.ownerPrincipalId as string,
            revision: valid.revision as string,
        }
    }
    return {
        key: `malformed:${JSON.stringify(boundedFingerprint(descriptor.value))}`,
    }
}

const finiteTiming = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 60_000

function mapResult(value: unknown) {
    try {
        if (!value || typeof value !== "object") internal()
        const result = value as Partial<PixaiImageRunOutput>
        const expected = getPixaiProfile(PIXAI_PROFILE_ID)
        if (
            result.modelProfileId !== expected.id ||
            result.modelRevision !== expected.revision ||
            result.modelSha256 !== expected.artifacts[0]!.sha256 ||
            result.preprocessVersion !== expected.preprocessing.version ||
            result.provider !== "wasm" ||
            typeof result.truncated !== "boolean" ||
            !Array.isArray(result.tags) ||
            result.tags.length > MAX_RESULT_TAGS ||
            !result.thresholds ||
            typeof result.thresholds !== "object" ||
            typeof result.thresholds.general !== "number" ||
            !Number.isFinite(result.thresholds.general) ||
            result.thresholds.general < 0 ||
            result.thresholds.general > 1 ||
            typeof result.thresholds.character !== "number" ||
            !Number.isFinite(result.thresholds.character) ||
            result.thresholds.character < 0 ||
            result.thresholds.character > 1 ||
            !result.timings ||
            !finiteTiming(result.timings.decodeMs) ||
            !finiteTiming(result.timings.preprocessMs) ||
            !finiteTiming(result.timings.inferenceMs) ||
            !finiteTiming(result.timings.postprocessMs) ||
            !finiteTiming(result.timings.totalMs) ||
            !Array.isArray(result.warnings) ||
            result.warnings.length > MAX_WARNINGS
        ) internal()
        const seen = new Set<number>()
        const tags = result.tags.map((tag) => {
            if (
                !tag ||
                !Number.isSafeInteger(tag.index) ||
                tag.index < 0 ||
                tag.index >= 13_461 ||
                seen.has(tag.index) ||
                typeof tag.name !== "string" ||
                tag.name.length < 1 ||
                utf8Bytes(tag.name) > MAX_TEXT_BYTES ||
                typeof tag.score !== "number" ||
                !Number.isFinite(tag.score) ||
                (tag.category !== "general" && tag.category !== "character")
            ) internal()
            seen.add(tag.index)
            return {
                index: tag.index,
                name: tag.name,
                score: tag.score,
                category: tag.category,
            }
        })
        const warnings = result.warnings.map((warning) => {
            if (typeof warning !== "string" || utf8Bytes(warning) > MAX_TEXT_BYTES) {
                internal()
            }
            return warning
        })
        return {
            model: {
                profile: expected.id,
                revision: expected.revision,
                sha256: expected.artifacts[0]!.sha256,
                preprocessVersion: expected.preprocessing.version,
            },
            execution: { provider: "wasm" as const },
            tags,
            thresholds: {
                general: result.thresholds.general,
                character: result.thresholds.character,
            },
            truncated: result.truncated,
            timingMs: {
                decode: result.timings.decodeMs,
                preprocess: result.timings.preprocessMs,
                inference: result.timings.inferenceMs,
                postprocess: result.timings.postprocessMs,
                total: result.timings.totalMs,
            },
            warnings,
        }
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        return internal()
    }
}

export class PixaiLocalModel {
    private readonly context: PluginExecutionContext
    private readonly getBrokerCallback: () => PixaiLocalModelBroker
    private readonly getStatus: (profile: string) => Promise<LocalModelStatus>
    private readonly contextResources: Pick<ContextResourceService, "readContextAsset">
    private readonly requirePermission: (permission: PluginPermissionId) => Promise<void>
    private readonly getInlayAssetRecord: (id: string) => Promise<InlayAssetRecord | null>
    private readonly getInlayAssetBlob: PixaiLocalModelOptions["getInlayAssetBlob"]
    private readonly probeBackend: () => boolean | Promise<boolean>
    private readonly storageBackend: LocalModelStorageBackend
    private readonly sessions = new Set<string>()
    private brokerValue?: PixaiLocalModelBroker
    private releasedAll = false

    constructor(options: PixaiLocalModelOptions) {
        this.context = options.context
        this.getBrokerCallback = options.getBroker
        this.getStatus = options.getStatus
        this.contextResources = options.contextResources
        this.requirePermission = options.requirePermission
        this.getInlayAssetRecord = options.getInlayAssetRecord
        this.getInlayAssetBlob = options.getInlayAssetBlob
        this.probeBackend = options.backendHealthy
        this.storageBackend = options.storageBackend
    }

    private broker() {
        if (!this.brokerValue) this.brokerValue = this.getBrokerCallback()
        return this.brokerValue
    }

    async backendHealthy(): Promise<boolean> {
        try {
            return (await this.probeBackend()) === true
        } catch {
            return false
        }
    }

    async getLocalModelCapabilities(profileValue: unknown): Promise<LocalModelCapabilities> {
        const profileId = assertProfile(profileValue)
        const healthy = await this.backendHealthy()
        let status: LocalModelStatus | undefined
        try {
            status = await this.getStatus(profileId)
        } catch {
            status = undefined
        }
        const ready = healthy && status?.state === "ready"
        return {
            supported: healthy,
            reasons: healthy
                ? (ready ? [] : ["model-not-ready"])
                : ["runtime-unavailable"],
            providers: {
                wasm: ready
                    ? { available: true }
                    : {
                        available: false,
                        reason: healthy ? "model-not-ready" : "runtime-unavailable",
                    },
                webgpu: { available: false, reason: "unsupported-provider" },
                node: { available: false, reason: "unsupported-provider" },
            },
            storage: {
                backend: this.storageBackend,
                persistent: true,
                resumable: true,
            },
            limits: {
                maxInputBytes: MAX_INPUT_BYTES,
                maxInputPixels: MAX_INPUT_PIXELS,
                maxResultTags: MAX_RESULT_TAGS,
            },
        }
    }

    async acquireLocalModelSession(profileValue: unknown, optionsValue?: unknown) {
        assertProfile(profileValue)
        const options = normalizeSignalOptions(optionsValue, true)
        const combined = combinedSignal(this.context.signal, options.signal)
        let acquired: { sessionId: string; provider: "wasm" } | undefined
        try {
            throwIfAborted(combined.signal)
            await this.requirePermission("localModelInference")
            throwIfAborted(combined.signal)
            const broker = this.broker()
            acquired = await broker.acquire({
                principalId: this.context.principalId,
                instanceId: this.context.instanceId,
                provider: options.provider,
                signal: combined.signal,
            })
            if (
                !acquired ||
                !UUID_V4.test(acquired.sessionId) ||
                acquired.provider !== "wasm"
            ) internal()
            const sessionId = acquired.sessionId.toLowerCase()
            if (combined.signal.aborted) {
                try {
                    await broker.release({
                        principalId: this.context.principalId,
                        instanceId: this.context.instanceId,
                        sessionId,
                    })
                } catch {
                    // Broker release after a late abort is best-effort.
                }
                aborted()
            }
            this.sessions.add(sessionId)
            return { sessionId, provider: "wasm" as const }
        } catch (error) {
            return sanitize(error, combined.signal)
        } finally {
            combined.dispose()
        }
    }

    private async resolveContextAsset(
        source: Extract<NormalizedImageSource, { kind: "context-asset" }>,
        signal: AbortSignal,
    ) {
        const value = await this.contextResources.readContextAsset(source.assetId, {
            ifRevision: source.revision,
            variant: "original",
            maxBytes: MAX_INPUT_BYTES,
            signal,
        })
        return validateImageBytes(value.data, value.mediaType)
    }

    private async resolveInlay(
        source: Extract<NormalizedImageSource, { kind: "inlay" }>,
        signal: AbortSignal,
    ) {
        const before = await this.getInlayAssetRecord(source.inlayId)
        throwIfAborted(signal)
        if (!before) throw new PluginApiError("NOT_FOUND", "Inlay was not found")
        const beforeLifecycle = await lifecycleSnapshot(before, source.inlayId)
        throwIfAborted(signal)
        await this.requirePermission(
            beforeLifecycle.owner === this.context.principalId
                ? "inlayWrite"
                : "inlayRead",
        )
        throwIfAborted(signal)
        const blobRecord = await this.getInlayAssetBlob(source.inlayId)
        throwIfAborted(signal)
        if (!blobRecord) {
            throw new PluginApiError(
                "CONFLICT",
                "Inlay changed while it was being read",
                { retryable: true },
            )
        }
        const descriptor = Object.getOwnPropertyDescriptor(blobRecord, "data")
        if (
            !descriptor?.enumerable ||
            !Object.hasOwn(descriptor, "value") ||
            !(descriptor.value instanceof Blob)
        ) internal()
        const blob = descriptor.value
        if (blob.size < 1) {
            throw new PluginApiError("DECODE_FAILED", "Inlay image is empty")
        }
        if (blob.size > MAX_INPUT_BYTES) {
            throw new PluginApiError(
                "RESOURCE_LIMIT",
                "Inlay image exceeds the advertised limit",
            )
        }
        let data: Uint8Array
        try {
            data = new Uint8Array(await blob.arrayBuffer()).slice()
        } catch (error) {
            return sanitize(error, signal)
        }
        throwIfAborted(signal)
        const actualRevision = await sha256Revision(data)
        throwIfAborted(signal)
        if (source.revision !== undefined && source.revision !== actualRevision) {
            throw new PluginApiError(
                "CONFLICT",
                "Inlay revision changed",
                { retryable: true },
            )
        }
        if (
            beforeLifecycle.revision !== undefined &&
            beforeLifecycle.revision !== actualRevision
        ) {
            throw new PluginApiError(
                "CONFLICT",
                "Inlay lifecycle revision does not match its bytes",
                { retryable: true },
            )
        }
        const image = validateImageBytes(data)
        const after = await this.getInlayAssetRecord(source.inlayId)
        throwIfAborted(signal)
        if (
            !after ||
            (await lifecycleSnapshot(after, source.inlayId)).key !== beforeLifecycle.key
        ) {
            throw new PluginApiError(
                "CONFLICT",
                "Inlay changed while it was being read",
                { retryable: true },
            )
        }
        throwIfAborted(signal)
        return image
    }

    private async resolveImage(source: NormalizedImageSource, signal: AbortSignal) {
        if (source.kind === "bytes") {
            return { data: source.data.slice(), mediaType: source.mediaType }
        }
        if (source.kind === "context-asset") {
            return this.resolveContextAsset(source, signal)
        }
        return this.resolveInlay(source, signal)
    }

    async runLocalModel(
        sessionIdValue: unknown,
        requestValue: unknown,
        optionsValue?: unknown,
    ) {
        const sessionId = assertSessionId(sessionIdValue)
        if (!this.sessions.has(sessionId)) {
            throw new PluginApiError("NOT_FOUND", "Local model session was not found")
        }
        const request = normalizeRunRequest(requestValue)
        const options = normalizeSignalOptions(optionsValue, false)
        const combined = combinedSignal(this.context.signal, options.signal)
        try {
            throwIfAborted(combined.signal)
            await this.requirePermission("localModelInference")
            throwIfAborted(combined.signal)
            const image = await this.resolveImage(request.image, combined.signal)
            throwIfAborted(combined.signal)
            const runOptions = {
                ...(request.thresholds === undefined
                    ? {}
                    : { thresholds: request.thresholds }),
                ...(request.categories === undefined
                    ? {}
                    : { categories: request.categories }),
                ...(request.maxResults === undefined
                    ? {}
                    : { maxResults: request.maxResults }),
            }
            const result = await this.broker().run({
                principalId: this.context.principalId,
                instanceId: this.context.instanceId,
                sessionId,
                image: {
                    data: image.data,
                    mediaType: image.mediaType,
                    options: runOptions,
                },
                signal: combined.signal,
            })
            throwIfAborted(combined.signal)
            return mapResult(result)
        } catch (error) {
            return sanitize(error, combined.signal)
        } finally {
            combined.dispose()
        }
    }

    async releaseLocalModelSession(sessionIdValue: unknown): Promise<void> {
        const sessionId = assertSessionId(sessionIdValue)
        if (!this.sessions.has(sessionId)) {
            throw new PluginApiError("NOT_FOUND", "Local model session was not found")
        }
        try {
            await this.broker().release({
                principalId: this.context.principalId,
                instanceId: this.context.instanceId,
                sessionId,
            })
            this.sessions.delete(sessionId)
        } catch (error) {
            return sanitize(error)
        }
    }

    async releaseAll(): Promise<void> {
        if (this.releasedAll) return
        this.releasedAll = true
        this.sessions.clear()
        try {
            await this.broker().releaseInstance(
                this.context.principalId,
                this.context.instanceId,
            )
        } catch {
            // Plugin unload cleanup must not block other instance cleanup.
        }
    }
}
