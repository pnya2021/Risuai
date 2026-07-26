import { isNodeServer, isTauri } from "src/ts/platform"
import {
    SecurityConfirmationQueue,
    securityConfirmationQueue,
} from "../../securityConfirmationQueue"
import type { PluginApiErrorShape } from "../illustration/contracts"
import {
    PluginApiError,
    serializePluginApiError,
} from "../illustration/errors"
import {
    pluginPermissionService,
    type PluginExecutionContext,
} from "../illustration/permissions"
import type { ArtifactStat, ModelArtifactStore } from "./modelArtifactStore"
import { OpfsModelArtifactStore } from "./opfsModelArtifactStore"
import {
    PIXAI_PROFILE_ID,
    getPixaiProfile,
    type PixaiProfileId,
    type RegisteredModelArtifact,
} from "./pixaiRegistry"
import {
    downloadRegisteredArtifact,
    type RegisteredArtifactDownloadOptions,
    type RegisteredArtifactDownloadResult,
    type RegisteredArtifactTransport,
} from "./registeredArtifactDownload"
import { TauriModelArtifactStore } from "./tauriModelArtifactStore"
import { createTauriRegisteredArtifactTransport } from "./tauriRegisteredArtifactTransport"
import { createWebRegisteredArtifactTransport } from "./webRegisteredArtifactTransport"

export const TERMINAL_OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_TERMINAL_OPERATIONS_PER_PRINCIPAL = 100
const MAX_OPERATION_ID_LENGTH = 128
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export interface LocalModelStatus {
    state:
        | "absent"
        | "partial"
        | "downloading"
        | "verifying"
        | "ready"
        | "corrupt"
        | "evicted"
    revision?: string
    sha256?: string
    storedBytes?: number
    operationId?: string
}

export interface LocalModelProgress {
    phase:
        | "checking-capabilities"
        | "awaiting-consent"
        | "checking-quota"
        | "downloading"
        | "verifying"
        | "committing"
        | "ready"
    loadedBytes?: number
    totalBytes?: number
    bytesPerSecond?: number
    etaMs?: number
}

export interface LocalModelOperationSnapshot {
    state: "queued" | "running" | "succeeded" | "failed" | "cancelled"
    progress?: LocalModelProgress
    error?: PluginApiErrorShape
}

export interface LocalModelRemoveResult {
    releasedPluginReference: boolean
    purgedBytes: number
    retainedForOtherOwners: boolean
    pending: boolean
}

type DownloadRegisteredArtifact = (
    options: RegisteredArtifactDownloadOptions,
) => Promise<RegisteredArtifactDownloadResult>

export interface PixaiInstallLifecycleOptions {
    store: ModelArtifactStore
    transport: RegisteredArtifactTransport
    queue?: SecurityConfirmationQueue
    requirePermission?: (context: PluginExecutionContext) => Promise<void>
    download?: DownloadRegisteredArtifact
    now?: () => number
    createOperationId?: () => string
}

interface ProgressCallbackEntry {
    callback: (progress: LocalModelProgress) => unknown
    signal: AbortSignal
    onAbort: () => void
}

interface LocalModelOperation {
    readonly id: string
    readonly principalId: string
    readonly profile: PixaiProfileId
    readonly sequence: number
    readonly controller: AbortController
    readonly callbacks: Map<string, ProgressCallbackEntry>
    state: LocalModelOperationSnapshot["state"]
    progress?: LocalModelProgress
    error?: PluginApiErrorShape
    terminalAt?: number
    task?: Promise<void>
}

const allowedModelErrorCodes = new Set([
    "INVALID_ARGUMENT",
    "UNSUPPORTED",
    "PERMISSION_DENIED",
    "NOT_FOUND",
    "QUOTA_EXCEEDED",
    "NETWORK",
    "INTEGRITY_MISMATCH",
    "ABORTED",
    "CONFLICT",
    "INTERNAL",
])

function invalid(message: string): never {
    throw new PluginApiError("INVALID_ARGUMENT", message)
}

function assertProfile(value: unknown): PixaiProfileId {
    if (value !== PIXAI_PROFILE_ID) invalid("Unsupported local model profile")
    return value
}

function assertOperationId(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_OPERATION_ID_LENGTH ||
        !OPERATION_ID_PATTERN.test(value)
    ) {
        invalid("Invalid local model operation ID")
    }
    return value
}

function assertProgressCallback(
    value: unknown,
): ((progress: LocalModelProgress) => unknown) | undefined {
    if (value === undefined) return undefined
    if (typeof value !== "function") invalid("Invalid local model progress callback")
    return value as (progress: LocalModelProgress) => unknown
}

function plainOptions(
    value: unknown,
): { scope: "plugin" | "device"; includePartial: boolean } {
    if (value === undefined) return { scope: "plugin", includePartial: true }
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype &&
            Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length > 0
    ) {
        invalid("Invalid local model removal options")
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !("value" in descriptor)) {
            invalid("Local model removal options must be plain data")
        }
        if (key !== "scope" && key !== "includePartial") {
            invalid("Unknown local model removal option")
        }
    }
    const scope = descriptors.scope?.value ?? "plugin"
    const includePartial = descriptors.includePartial?.value ?? true
    if (scope !== "plugin" && scope !== "device") {
        invalid("Invalid local model removal scope")
    }
    if (typeof includePartial !== "boolean") {
        invalid("Invalid includePartial option")
    }
    return { scope, includePartial }
}

function cloneProgress(progress: LocalModelProgress): LocalModelProgress {
    return {
        phase: progress.phase,
        ...(progress.loadedBytes === undefined
            ? {}
            : { loadedBytes: progress.loadedBytes }),
        ...(progress.totalBytes === undefined
            ? {}
            : { totalBytes: progress.totalBytes }),
        ...(progress.bytesPerSecond === undefined
            ? {}
            : { bytesPerSecond: progress.bytesPerSecond }),
        ...(progress.etaMs === undefined ? {} : { etaMs: progress.etaMs }),
    }
}

function cloneError(error: PluginApiErrorShape): PluginApiErrorShape {
    return {
        name: "PluginApiError",
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: error.retryAfterMs }),
        ...(error.details === undefined ? {} : { details: { ...error.details } }),
    }
}

function normalizeOperationError(
    error: unknown,
    aborted: boolean,
): PluginApiErrorShape {
    if (aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return serializePluginApiError(
            new PluginApiError("ABORTED", "Local model operation cancelled"),
        )
    }
    const serialized = serializePluginApiError(error)
    if (serialized.code !== "INTERNAL" && allowedModelErrorCodes.has(serialized.code)) {
        return serialized
    }
    const message = error instanceof Error ? error.message : ""
    if (/quota|insufficient.*(?:space|storage)/i.test(message)) {
        return serializePluginApiError(
            new PluginApiError(
                "QUOTA_EXCEEDED",
                "Insufficient local model storage quota",
            ),
        )
    }
    if (
        /sha-?256|digest|integrity|registered size|stream (?:ended|exceeded)|verified artifact size/i.test(
            message,
        )
    ) {
        return serializePluginApiError(
            new PluginApiError(
                "INTEGRITY_MISMATCH",
                "Local model artifact verification failed",
            ),
        )
    }
    if (/partial changed|offset mismatch/i.test(message)) {
        return serializePluginApiError(
            new PluginApiError("CONFLICT", "Local model artifact state changed"),
        )
    }
    if (
        /network|fetch|transport|response|status \d|redirect|dns|url|host|body/i.test(
            message,
        )
    ) {
        return serializePluginApiError(
            new PluginApiError("NETWORK", "Local model download failed", {
                retryable: true,
            }),
        )
    }
    return serializePluginApiError(new Error("redacted local model failure"))
}

function profileDigest(): string {
    const profile = getPixaiProfile(PIXAI_PROFILE_ID)
    return JSON.stringify([
        profile.id,
        profile.revision,
        profile.totalBytes,
        ...profile.artifacts.flatMap((artifact) => [
            artifact.name,
            artifact.bytes,
            artifact.sha256,
        ]),
    ])
}

function confirmationDescription(
    context: PluginExecutionContext,
    action: "install" | "remove",
): string {
    const profile = getPixaiProfile(PIXAI_PROFILE_ID)
    const identity = `${context.displayName} (${context.internalName ?? context.displayName})`
    const digests = profile.artifacts
        .map((artifact) => `${artifact.name}: ${artifact.sha256}`)
        .join("; ")
    const verb = action === "install" ? "install" : "remove from this device"
    return (
        `${identity} requests to ${verb} ${profile.id}. ` +
        `Source: ${profile.sourceUrl}. License: ${profile.license} (${profile.licenseUrl}). ` +
        `Immutable revision: ${profile.revision}. Total manifest bytes: ${profile.totalBytes}. ` +
        `SHA-256 digests: ${digests}. ` +
        "This uses device-local persistent storage and local compute. " +
        "Local images stay on this device and are processed locally."
    )
}

export class PixaiInstallLifecycle {
    private readonly store: ModelArtifactStore
    private readonly transport: RegisteredArtifactTransport
    private readonly queue: SecurityConfirmationQueue
    private readonly requirePermission: (
        context: PluginExecutionContext,
    ) => Promise<void>
    private readonly download: DownloadRegisteredArtifact
    private readonly now: () => number
    private readonly createOperationId: () => string
    private readonly operations = new Map<string, LocalModelOperation>()
    private readonly active = new Map<string, LocalModelOperation>()
    private readonly owners = new Set<string>()
    private nextSequence = 0
    private lifecycleMutationTail: Promise<void> = Promise.resolve()

    constructor(options: PixaiInstallLifecycleOptions) {
        this.store = options.store
        this.transport = options.transport
        this.queue = options.queue ?? securityConfirmationQueue
        this.requirePermission =
            options.requirePermission ??
            ((context) =>
                pluginPermissionService.require(context, "localModelInference"))
        this.download = options.download ?? downloadRegisteredArtifact
        this.now = options.now ?? Date.now
        this.createOperationId =
            options.createOperationId ??
            (() => `lmo_${crypto.randomUUID().replaceAll("-", "")}`)
    }

    async getLocalModelStatus(
        context: PluginExecutionContext,
        profileValue: unknown,
    ): Promise<LocalModelStatus> {
        const profileId = assertProfile(profileValue)
        const profile = getPixaiProfile(profileId)
        const current = this.active.get(this.activeKey(context.principalId))
        if (current) {
            const progress = current.progress
            const verifying =
                progress?.phase === "verifying" || progress?.phase === "committing"
            return {
                state: verifying ? "verifying" : "downloading",
                revision: profile.revision,
                sha256: profile.artifacts[0].sha256,
                ...(progress?.loadedBytes === undefined
                    ? {}
                    : { storedBytes: progress.loadedBytes }),
                operationId: current.id,
            }
        }

        const states = await this.readStates(profile.artifacts)
        const storedBytes = states.reduce((total, state) => total + state.bytes, 0)
        const corrupt = states.some(
            (state, index) =>
                state.bytes > profile.artifacts[index].bytes ||
                (state.state === "verified" &&
                    state.bytes !== profile.artifacts[index].bytes),
        )
        if (corrupt) {
            return {
                state: "corrupt",
                revision: profile.revision,
                sha256: profile.artifacts[0].sha256,
                storedBytes,
            }
        }
        if (
            states.every(
                (state, index) =>
                    state.state === "verified" &&
                    state.bytes === profile.artifacts[index].bytes,
            )
        ) {
            return {
                state: "ready",
                revision: profile.revision,
                sha256: profile.artifacts[0].sha256,
                storedBytes,
            }
        }
        if (states.every((state) => state.state === "absent")) {
            return this.owners.has(context.principalId)
                ? {
                      state: "evicted",
                      revision: profile.revision,
                      sha256: profile.artifacts[0].sha256,
                      storedBytes: 0,
                  }
                : { state: "absent" }
        }
        return {
            state: "partial",
            revision: profile.revision,
            sha256: profile.artifacts[0].sha256,
            storedBytes,
        }
    }

    async installLocalModel(
        context: PluginExecutionContext,
        profileValue: unknown,
        progressValue?: unknown,
    ): Promise<{ operationId: string }> {
        const profileId = assertProfile(profileValue)
        const callback = assertProgressCallback(progressValue)
        await this.requirePermission(context)
        if (context.signal.aborted) {
            throw new PluginApiError("ABORTED", "Plugin instance unloaded")
        }

        const key = this.activeKey(context.principalId)
        const existing = this.active.get(key)
        if (existing) {
            this.attachCallback(existing, context, callback)
            return { operationId: existing.id }
        }

        const approved = await this.queue.request(
            {
                kind: "model-install",
                principalId: context.principalId,
                instanceId: context.instanceId,
                action: `install:${profileId}`,
                profileDigest: profileDigest(),
                copyVersion: 1,
                displayName: context.displayName,
                internalName: context.internalName ?? context.displayName,
                title: "Install local model",
                description: confirmationDescription(context, "install"),
                allowLabel: "Install",
                denyLabel: "Cancel",
            },
            context.signal,
        )
        if (!approved) {
            if (context.signal.aborted) {
                throw new PluginApiError("ABORTED", "Plugin instance unloaded")
            }
            throw new PluginApiError(
                "PERMISSION_DENIED",
                "Local model installation was denied",
            )
        }
        if (context.signal.aborted) {
            throw new PluginApiError("ABORTED", "Plugin instance unloaded")
        }

        return this.withLifecycleMutation(() => {
            if (context.signal.aborted) {
                throw new PluginApiError("ABORTED", "Plugin instance unloaded")
            }
            const coalesced = this.active.get(key)
            if (coalesced) {
                this.attachCallback(coalesced, context, callback)
                return { operationId: coalesced.id }
            }

            const id = assertOperationId(this.createOperationId())
            if (this.operations.has(id)) {
                throw new PluginApiError(
                    "INTERNAL",
                    "Local model operation ID collision",
                )
            }
            const operation: LocalModelOperation = {
                id,
                principalId: context.principalId,
                profile: profileId,
                sequence: ++this.nextSequence,
                controller: new AbortController(),
                callbacks: new Map(),
                state: "queued",
                progress: {
                    phase: "checking-quota",
                    totalBytes: getPixaiProfile(profileId).totalBytes,
                },
            }
            this.operations.set(id, operation)
            this.active.set(key, operation)
            this.attachCallback(operation, context, callback)
            queueMicrotask(() => {
                operation.task = this.runOperation(operation)
            })
            return { operationId: id }
        })
    }

    async getLocalModelOperation(
        context: PluginExecutionContext,
        operationIdValue: unknown,
    ): Promise<LocalModelOperationSnapshot> {
        const operation = this.ownedOperation(context, operationIdValue)
        return {
            state: operation.state,
            ...(operation.progress === undefined
                ? {}
                : { progress: cloneProgress(operation.progress) }),
            ...(operation.error === undefined
                ? {}
                : { error: cloneError(operation.error) }),
        }
    }

    async cancelLocalModelOperation(
        context: PluginExecutionContext,
        operationIdValue: unknown,
    ): Promise<void> {
        const operation = this.ownedOperation(context, operationIdValue)
        if (operation.state !== "queued" && operation.state !== "running") {
            throw new PluginApiError(
                "CONFLICT",
                "Local model operation is already terminal",
            )
        }
        operation.controller.abort(
            new PluginApiError("ABORTED", "Local model operation cancelled"),
        )
        while (!operation.task) await Promise.resolve()
        await operation.task
    }

    async removeLocalModel(
        context: PluginExecutionContext,
        profileValue: unknown,
        optionsValue?: unknown,
    ): Promise<LocalModelRemoveResult> {
        const profileId = assertProfile(profileValue)
        const options = plainOptions(optionsValue)
        await this.requirePermission(context)
        if (context.signal.aborted) {
            throw new PluginApiError("ABORTED", "Plugin instance unloaded")
        }
        if (this.active.size > 0) {
            throw new PluginApiError(
                "CONFLICT",
                "A local model installation is active",
            )
        }
        if (options.scope === "device") {
            const approved = await this.queue.request(
                {
                    kind: "model-remove",
                    principalId: context.principalId,
                    instanceId: context.instanceId,
                    action: `remove:${profileId}:device`,
                    profileDigest: profileDigest(),
                    copyVersion: 1,
                    displayName: context.displayName,
                    internalName: context.internalName ?? context.displayName,
                    title: "Remove local model",
                    description: confirmationDescription(context, "remove"),
                    allowLabel: "Remove",
                    denyLabel: "Cancel",
                },
                context.signal,
            )
            if (!approved) {
                if (context.signal.aborted) {
                    throw new PluginApiError("ABORTED", "Plugin instance unloaded")
                }
                throw new PluginApiError(
                    "PERMISSION_DENIED",
                    "Device model removal was denied",
                )
            }
        }

        return this.withLifecycleMutation(async () => {
            if (context.signal.aborted) {
                throw new PluginApiError("ABORTED", "Plugin instance unloaded")
            }
            if (this.active.size > 0) {
                throw new PluginApiError(
                    "CONFLICT",
                    "A local model installation is active",
                )
            }

            const profile = getPixaiProfile(profileId)
            const releasedPluginReference = this.owners.delete(
                context.principalId,
            )
            if (options.scope === "plugin" && this.owners.size > 0) {
                return {
                    releasedPluginReference,
                    purgedBytes: 0,
                    retainedForOtherOwners: true,
                    pending: false,
                }
            }
            if (options.scope === "device") this.owners.clear()

            const states = await this.readStates(profile.artifacts)
            let purgedBytes = 0
            for (let index = 0; index < profile.artifacts.length; index += 1) {
                const artifact = profile.artifacts[index]
                const state = states[index]
                const removePartial =
                    options.includePartial && state.state === "partial"
                const removeVerified = state.state === "verified"
                if (!removePartial && !removeVerified) continue
                await this.store.remove(artifact.sha256, {
                    partial: removePartial,
                    verified: removeVerified,
                })
                purgedBytes += state.bytes
            }
            return {
                releasedPluginReference,
                purgedBytes,
                retainedForOtherOwners: false,
                pending: false,
            }
        })
    }

    private activeKey(principalId: string): string {
        return `${principalId}\u0000${PIXAI_PROFILE_ID}`
    }

    private async withLifecycleMutation<T>(
        mutation: () => T | Promise<T>,
    ): Promise<T> {
        let release!: () => void
        const previous = this.lifecycleMutationTail
        this.lifecycleMutationTail = new Promise<void>((resolve) => {
            release = resolve
        })
        await previous
        try {
            return await mutation()
        } finally {
            release()
        }
    }

    private async readStates(
        artifacts: readonly Readonly<RegisteredModelArtifact>[],
    ): Promise<ArtifactStat[]> {
        return Promise.all(
            artifacts.map(async (artifact) => {
                const state = await this.store.stat(artifact.sha256)
                if (
                    !Number.isSafeInteger(state.bytes) ||
                    state.bytes < 0 ||
                    !["absent", "partial", "verified"].includes(state.state)
                ) {
                    throw new PluginApiError(
                        "INTERNAL",
                        "Invalid local model artifact state",
                    )
                }
                return {
                    state: state.state,
                    bytes: state.bytes,
                    ...(state.etag ? { etag: state.etag } : {}),
                }
            }),
        )
    }

    private attachCallback(
        operation: LocalModelOperation,
        context: PluginExecutionContext,
        callback: ((progress: LocalModelProgress) => unknown) | undefined,
    ): void {
        if (!callback || context.signal.aborted) return
        const prior = operation.callbacks.get(context.instanceId)
        if (prior) prior.signal.removeEventListener("abort", prior.onAbort)
        const onAbort = () => {
            const current = operation.callbacks.get(context.instanceId)
            if (current?.onAbort === onAbort) {
                operation.callbacks.delete(context.instanceId)
            }
        }
        operation.callbacks.set(context.instanceId, {
            callback,
            signal: context.signal,
            onAbort,
        })
        context.signal.addEventListener("abort", onAbort, { once: true })
    }

    private publish(
        operation: LocalModelOperation,
        progress: LocalModelProgress,
    ): void {
        operation.progress = cloneProgress(progress)
        for (const [instanceId, entry] of operation.callbacks) {
            if (entry.signal.aborted) {
                operation.callbacks.delete(instanceId)
                continue
            }
            try {
                void Promise.resolve(entry.callback(cloneProgress(progress))).catch(
                    () => undefined,
                )
            } catch {
                // Plugin progress callbacks are advisory.
            }
        }
    }

    private async runOperation(operation: LocalModelOperation): Promise<void> {
        const profile = getPixaiProfile(operation.profile)
        operation.state = "running"
        try {
            const initial = await this.readStates(profile.artifacts)
            this.publish(operation, {
                phase: "checking-quota",
                loadedBytes: initial.reduce((total, state) => total + state.bytes, 0),
                totalBytes: profile.totalBytes,
            })
            let completedBytes = 0
            for (const artifact of profile.artifacts) {
                await this.download({
                    artifact,
                    store: this.store,
                    transport: this.transport,
                    signal: operation.controller.signal,
                    onProgress: (progress) => {
                        this.publish(operation, {
                            phase: progress.phase,
                            loadedBytes: completedBytes + progress.loadedBytes,
                            totalBytes: profile.totalBytes,
                        })
                    },
                })
                completedBytes += artifact.bytes
            }
            this.owners.add(operation.principalId)
            operation.state = "succeeded"
            this.publish(operation, {
                phase: "ready",
                loadedBytes: profile.totalBytes,
                totalBytes: profile.totalBytes,
            })
        } catch (error) {
            operation.error = normalizeOperationError(
                error,
                operation.controller.signal.aborted,
            )
            operation.state =
                operation.error.code === "ABORTED" ? "cancelled" : "failed"
        } finally {
            operation.terminalAt = this.now()
            const key = this.activeKey(operation.principalId)
            if (this.active.get(key) === operation) this.active.delete(key)
            for (const entry of operation.callbacks.values()) {
                entry.signal.removeEventListener("abort", entry.onAbort)
            }
            operation.callbacks.clear()
            this.prune(operation.principalId)
        }
    }

    private ownedOperation(
        context: PluginExecutionContext,
        operationIdValue: unknown,
    ): LocalModelOperation {
        const operationId = assertOperationId(operationIdValue)
        this.prune(context.principalId)
        const operation = this.operations.get(operationId)
        if (!operation || operation.principalId !== context.principalId) {
            throw new PluginApiError("NOT_FOUND", "Local model operation not found")
        }
        return operation
    }

    private prune(principalId: string): void {
        const now = this.now()
        const terminal = [...this.operations.values()]
            .filter(
                (operation) =>
                    operation.principalId === principalId &&
                    operation.terminalAt !== undefined,
            )
            .sort(
                (left, right) =>
                    left.terminalAt! - right.terminalAt! ||
                    left.sequence - right.sequence,
            )
        for (const operation of terminal) {
            if (now - operation.terminalAt! > TERMINAL_OPERATION_TTL_MS) {
                this.operations.delete(operation.id)
            }
        }
        const retained = terminal.filter((operation) =>
            this.operations.has(operation.id),
        )
        const excess = retained.length - MAX_TERMINAL_OPERATIONS_PER_PRINCIPAL
        for (let index = 0; index < excess; index += 1) {
            this.operations.delete(retained[index].id)
        }
    }
}

let defaultLifecycle: PixaiInstallLifecycle | undefined

export function getPixaiInstallLifecycle(): PixaiInstallLifecycle {
    if (defaultLifecycle) return defaultLifecycle
    if (isNodeServer) {
        throw new PluginApiError(
            "UNSUPPORTED",
            "Local model artifact storage is unavailable on this host",
        )
    }
    if (isTauri) {
        defaultLifecycle = new PixaiInstallLifecycle({
            store: new TauriModelArtifactStore(),
            transport: createTauriRegisteredArtifactTransport(),
        })
        return defaultLifecycle
    }
    if (
        typeof navigator === "undefined" ||
        typeof navigator.storage?.getDirectory !== "function" ||
        typeof globalThis.fetch !== "function"
    ) {
        throw new PluginApiError(
            "UNSUPPORTED",
            "Local model artifact storage is unavailable on this host",
        )
    }
    defaultLifecycle = new PixaiInstallLifecycle({
        store: new OpfsModelArtifactStore(),
        transport: createWebRegisteredArtifactTransport(),
    })
    return defaultLifecycle
}
