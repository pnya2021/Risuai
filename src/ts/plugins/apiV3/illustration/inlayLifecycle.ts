import type { PluginExecutionContext } from './permissions'
import { PluginApiError } from './errors'
import { canonicalArgumentsDigest, IdempotencyLedger } from './idempotency'
import { assertLimit, assertUtf8Limit, utf8ByteLength } from './limits'

export const INLAY_LIFECYCLE_CAPABILITY_IDS = [
    'inlay.create.v1',
    'inlay.read.v1',
    'inlay.delete-own.v1',
] as const

const CREATE_OPERATION = INLAY_LIFECYCLE_CAPABILITY_IDS[0]
const MAX_INPUT_BYTES = 33_554_432
const MAX_OUTPUT_BYTES = 33_554_432
const MAX_NAME_BYTES = 255
const READS_PER_MINUTE = 60
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/

export interface InlayCreateOptions {
    name?: string
    idempotencyKey: string
    context: { kind: 'character'; characterId: string }
    return: 'descriptor'
}

export interface InlayDescriptor {
    id: string
    revision: string
    name: string
}

export interface InlayReadOptions {
    ifRevision: string
    maxBytes: number
}

export interface OwnedInlayRead extends InlayDescriptor {
    mediaType: string
    data: Uint8Array
}

export interface InlayLifecycleMetadata {
    version: 1
    ownerPrincipalId: string
    operation: typeof CREATE_OPERATION
    idempotencyKey: string
    argumentDigest: string
    revision: string
    context: { kind: 'character'; characterId: string }
}

export interface InlayLifecycleRecord extends InlayDescriptor {
    lifecycle?: InlayLifecycleMetadata
}

export interface InlayImageRead {
    record: InlayLifecycleRecord
    mediaType: string
    data: Uint8Array
}

export interface InlayLifecycleAdapter {
    getCurrentCharacterId(): string | null
    getInlay(id: string): Promise<InlayLifecycleRecord | null>
    readImage(
        id: string,
        maxBytes: number,
        approvedRecord: InlayLifecycleRecord,
    ): Promise<InlayImageRead | null>
    writeImage(data: Uint8Array, request: {
        id: string
        name: string
        lifecycle: InlayLifecycleMetadata
        beforeMutation(): void | Promise<void>
    }): Promise<void>
    hasReference(id: string): Promise<boolean>
    removeInlay(id: string): Promise<boolean>
}

export interface InlayPermissionService {
    require(context: PluginExecutionContext, permission: 'inlayWrite', options?: unknown): Promise<void>
}

const invalidArgument = (message: string): never => {
    throw new PluginApiError('INVALID_ARGUMENT', message)
}

const plainDataObject = (value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> => {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalidArgument(`Invalid ${label}`)
        const object = value as object
        const prototype = Object.getPrototypeOf(object)
        if (prototype !== Object.prototype && prototype !== null) invalidArgument(`Invalid ${label}`)
        const keys = Reflect.ownKeys(object)
        if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) invalidArgument(`Invalid ${label}`)
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidArgument(`Invalid ${label}`)
        }
        return value as Record<string, unknown>
    } catch (error) {
        if (error instanceof PluginApiError) throw error
        return invalidArgument(`Invalid ${label}`)
    }
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const requiredString = (value: unknown, message: string) => {
    if (!nonEmptyString(value)) invalidArgument(message)
    return value as string
}

function normalizeCreateOptions(value: unknown): InlayCreateOptions {
    const options = plainDataObject(value, ['name', 'idempotencyKey', 'context', 'return'], 'createInlay options')
    const idempotencyKey = requiredString(options.idempotencyKey, 'idempotencyKey is required')
    assertUtf8Limit(idempotencyKey, 256, 'idempotencyKey')
    const name = options.name === undefined
        ? undefined
        : requiredString(options.name, 'Inlay name must be non-empty')
    if (name !== undefined) {
        assertUtf8Limit(name, MAX_NAME_BYTES, 'name')
    }
    if (options.return !== 'descriptor') invalidArgument('createInlay return must be descriptor')
    const context = plainDataObject(options.context, ['kind', 'characterId'], 'Inlay context')
    if (context.kind !== 'character') invalidArgument('Invalid character context')
    const characterId = requiredString(context.characterId, 'Invalid character context')
    return {
        ...(name === undefined ? {} : { name }),
        idempotencyKey,
        return: 'descriptor',
        context: { kind: 'character', characterId },
    }
}

function normalizeReadOptions(value: unknown): InlayReadOptions {
    const options = plainDataObject(value, ['ifRevision', 'maxBytes'], 'readOwnedInlay options')
    if (Reflect.ownKeys(options).length !== 2
        || !Object.hasOwn(options, 'ifRevision')
        || !Object.hasOwn(options, 'maxBytes')) {
        invalidArgument('readOwnedInlay options are required')
    }
    const ifRevision = options.ifRevision
    if (typeof ifRevision !== 'string' || !REVISION_PATTERN.test(ifRevision)) {
        invalidArgument('ifRevision must be a SHA-256 revision')
    }
    if (!Number.isSafeInteger(options.maxBytes)
        || (options.maxBytes as number) < 1
        || (options.maxBytes as number) > MAX_OUTPUT_BYTES) {
        invalidArgument('maxBytes must be an integer within the advertised limit')
    }
    return {
        ifRevision: ifRevision as string,
        maxBytes: options.maxBytes as number,
    }
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0')).join('')

const sha256 = async (data: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', Uint8Array.from(data).buffer))

const deterministicInlayId = async (principalId: string, idempotencyKey: string) => {
    const encoded = new TextEncoder().encode(JSON.stringify([principalId, CREATE_OPERATION, idempotencyKey]))
    return `inlay_${await sha256(encoded)}`
}

const validMetadata = (value: unknown): value is InlayLifecycleMetadata => {
    if (!value || typeof value !== 'object') return false
    const metadata = value as Partial<InlayLifecycleMetadata>
    return metadata.version === 1
        && nonEmptyString(metadata.ownerPrincipalId)
        && metadata.operation === CREATE_OPERATION
        && nonEmptyString(metadata.idempotencyKey)
        && utf8ByteLength(metadata.idempotencyKey) <= 256
        && typeof metadata.argumentDigest === 'string'
        && /^[0-9a-f]{64}$/.test(metadata.argumentDigest)
        && typeof metadata.revision === 'string'
        && /^sha256:[0-9a-f]{64}$/.test(metadata.revision)
        && metadata.context?.kind === 'character'
        && nonEmptyString(metadata.context.characterId)
}

const exactDataObject = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return null
        const ownKeys = Reflect.ownKeys(value)
        if (ownKeys.length !== keys.length
            || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return null
        for (const key of ownKeys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
        }
        return value as Record<string, unknown>
    } catch {
        return null
    }
}

const ownedRecordSnapshot = (value: unknown): InlayLifecycleRecord | null => {
    const record = exactDataObject(value, ['id', 'revision', 'name', 'lifecycle'])
    if (!record
        || !nonEmptyString(record.id)
        || !nonEmptyString(record.name)
        || utf8ByteLength(record.name) > MAX_NAME_BYTES
        || typeof record.revision !== 'string'
        || !REVISION_PATTERN.test(record.revision)) return null
    const lifecycle = exactDataObject(record.lifecycle, [
        'version', 'ownerPrincipalId', 'operation', 'idempotencyKey',
        'argumentDigest', 'revision', 'context',
    ])
    const lifecycleContext = lifecycle
        ? exactDataObject(lifecycle.context, ['kind', 'characterId'])
        : null
    if (!lifecycle
        || lifecycle.version !== 1
        || !nonEmptyString(lifecycle.ownerPrincipalId)
        || lifecycle.operation !== CREATE_OPERATION
        || !nonEmptyString(lifecycle.idempotencyKey)
        || utf8ByteLength(lifecycle.idempotencyKey) > 256
        || typeof lifecycle.argumentDigest !== 'string'
        || !/^[0-9a-f]{64}$/.test(lifecycle.argumentDigest)
        || lifecycle.revision !== record.revision
        || !lifecycleContext
        || lifecycleContext.kind !== 'character'
        || !nonEmptyString(lifecycleContext.characterId)) return null
    return {
        id: record.id,
        name: record.name,
        revision: record.revision,
        lifecycle: {
            version: 1,
            ownerPrincipalId: lifecycle.ownerPrincipalId,
            operation: CREATE_OPERATION,
            idempotencyKey: lifecycle.idempotencyKey,
            argumentDigest: lifecycle.argumentDigest,
            revision: lifecycle.revision,
            context: { kind: 'character', characterId: lifecycleContext.characterId },
        },
    }
}

const sameOwnedRecord = (left: InlayLifecycleRecord, right: InlayLifecycleRecord) => {
    const leftLifecycle = left.lifecycle!
    const rightLifecycle = right.lifecycle!
    return left.id === right.id
        && left.name === right.name
        && left.revision === right.revision
        && leftLifecycle.version === rightLifecycle.version
        && leftLifecycle.ownerPrincipalId === rightLifecycle.ownerPrincipalId
        && leftLifecycle.operation === rightLifecycle.operation
        && leftLifecycle.idempotencyKey === rightLifecycle.idempotencyKey
        && leftLifecycle.argumentDigest === rightLifecycle.argumentDigest
        && leftLifecycle.revision === rightLifecycle.revision
        && leftLifecycle.context.kind === rightLifecycle.context.kind
        && leftLifecycle.context.characterId === rightLifecycle.context.characterId
}

export class InlayReadRateLimiter {
    private readonly reads = new Map<string, number[]>()

    constructor(private readonly now: () => number = Date.now) {}

    consume(principalId: string) {
        const now = this.now()
        const cutoff = now - 60_000
        const retained = (this.reads.get(principalId) ?? []).filter((value) => value > cutoff)
        if (retained.length >= READS_PER_MINUTE) {
            this.reads.set(principalId, retained)
            throw new PluginApiError('RESOURCE_LIMIT', 'Owned Inlay read rate exceeded', {
                retryable: true,
                retryAfterMs: Math.max(1, retained[0] + 60_000 - now),
            })
        }
        retained.push(now)
        this.reads.set(principalId, retained)
    }
}

const sharedReadRateLimiter = new InlayReadRateLimiter()

export class InlayLifecycleService {
    private readonly ledger: IdempotencyLedger
    private readonly readRateLimiter: InlayReadRateLimiter

    constructor(
        private readonly context: PluginExecutionContext,
        private readonly adapter: InlayLifecycleAdapter,
        private readonly permissions: InlayPermissionService,
        options: { ledger?: IdempotencyLedger; readRateLimiter?: InlayReadRateLimiter } = {},
    ) {
        this.ledger = options.ledger ?? new IdempotencyLedger()
        this.readRateLimiter = options.readRateLimiter ?? sharedReadRateLimiter
    }

    private requirePermission() {
        return this.permissions.require(this.context, 'inlayWrite')
    }

    private ensureActive() {
        if (this.context.signal.aborted) {
            throw new PluginApiError('ABORTED', 'Plugin instance is no longer active')
        }
    }

    private async awaitReadBoundary<T>(operation: Promise<T>, label: string): Promise<T> {
        try {
            const result = await operation
            this.ensureActive()
            return result
        } catch (error) {
            this.ensureActive()
            if (error instanceof PluginApiError) throw error
            throw new PluginApiError('INTERNAL', `${label} failed`, { retryable: true })
        }
    }

    async createInlay(data: Uint8Array, rawOptions: InlayCreateOptions): Promise<InlayDescriptor> {
        await this.requirePermission()
        if (!(data instanceof Uint8Array) || Object.getPrototypeOf(data) !== Uint8Array.prototype) {
            invalidArgument('createInlay data must be a Uint8Array')
        }
        const bytes = Uint8Array.from(data)
        assertLimit(bytes.byteLength, MAX_INPUT_BYTES, 'data')
        const options = normalizeCreateOptions(rawOptions)
        const id = await deterministicInlayId(this.context.principalId, options.idempotencyKey)
        const name = options.name ?? `${id}.png`
        const canonicalArgs = {
            data: bytes,
            name,
            context: options.context,
            return: options.return,
        }

        return this.ledger.run(
            this.context.principalId,
            CREATE_OPERATION,
            options.idempotencyKey,
            canonicalArgs,
            async () => {
                const [argumentDigest, contentDigest] = await Promise.all([
                    canonicalArgumentsDigest(canonicalArgs),
                    sha256(bytes),
                ])
                const revision = `sha256:${contentDigest}`
                const descriptor = { id, revision, name }
                const existing = await this.adapter.getInlay(id)
                if (existing) {
                    const metadata = existing.lifecycle
                    if (!validMetadata(metadata)
                        || metadata.ownerPrincipalId !== this.context.principalId
                        || metadata.idempotencyKey !== options.idempotencyKey
                        || metadata.argumentDigest !== argumentDigest
                        || metadata.revision !== revision
                        || metadata.context.characterId !== options.context.characterId
                        || existing.id !== id
                        || existing.revision !== revision
                        || existing.name !== name) {
                        throw new PluginApiError('CONFLICT', 'Stored Inlay conflicts with the idempotent create request')
                    }
                    return descriptor
                }

                const lifecycle: InlayLifecycleMetadata = {
                    version: 1,
                    ownerPrincipalId: this.context.principalId,
                    operation: CREATE_OPERATION,
                    idempotencyKey: options.idempotencyKey,
                    argumentDigest,
                    revision,
                    context: { ...options.context },
                }
                await this.adapter.writeImage(bytes.slice(), {
                    id,
                    name,
                    lifecycle,
                    beforeMutation: async () => {
                        if (this.adapter.getCurrentCharacterId() !== options.context.characterId) {
                            throw new PluginApiError('PERMISSION_DENIED', 'Character context is no longer current')
                        }
                    },
                })
                const stored = await this.adapter.getInlay(id)
                if (!stored || !validMetadata(stored.lifecycle)
                    || stored.lifecycle.ownerPrincipalId !== this.context.principalId
                    || stored.lifecycle.idempotencyKey !== options.idempotencyKey
                    || stored.lifecycle.argumentDigest !== argumentDigest
                    || stored.lifecycle.revision !== revision
                    || stored.lifecycle.context.characterId !== options.context.characterId
                    || stored.id !== id
                    || stored.name !== name
                    || stored.revision !== revision) {
                    throw new PluginApiError('INTERNAL', 'Inlay storage did not confirm the lifecycle record', {
                        retryable: true,
                    })
                }
                return descriptor
            },
            { durable: true },
        )
    }

    async readOwnedInlay(id: string, rawOptions: InlayReadOptions): Promise<OwnedInlayRead | null> {
        try {
            await this.requirePermission()
        } catch (error) {
            this.ensureActive()
            throw error
        }
        this.ensureActive()
        if (!nonEmptyString(id)) invalidArgument('Inlay id must be non-empty')
        const options = normalizeReadOptions(rawOptions)
        this.readRateLimiter.consume(this.context.principalId)

        const rawRecord = await this.awaitReadBoundary(this.adapter.getInlay(id), 'Unable to read Inlay storage')
        if (!rawRecord) return null
        const record = ownedRecordSnapshot(rawRecord)
        if (!record
            || record.id !== id
            || record.lifecycle!.ownerPrincipalId !== this.context.principalId) {
            throw new PluginApiError('PERMISSION_DENIED', 'Inlay is not owned by the current plugin')
        }
        const deterministicId = await this.awaitReadBoundary(
            deterministicInlayId(record.lifecycle!.ownerPrincipalId, record.lifecycle!.idempotencyKey),
            'Unable to validate Inlay ownership',
        )
        if (deterministicId !== id) {
            throw new PluginApiError('PERMISSION_DENIED', 'Inlay lifecycle identity is malformed')
        }
        if (record.revision !== options.ifRevision) {
            throw new PluginApiError('CONFLICT', 'Inlay revision changed', {
                retryable: true,
                details: { expectedRevision: options.ifRevision, actualRevision: record.revision },
            })
        }

        const read = await this.awaitReadBoundary(
            this.adapter.readImage(id, options.maxBytes, record),
            'Unable to read Inlay bytes',
        )
        if (!read) {
            throw new PluginApiError('CONFLICT', 'Inlay changed while it was being read', { retryable: true })
        }
        const confirmed = ownedRecordSnapshot(read.record)
        if (!confirmed || !sameOwnedRecord(record, confirmed)) {
            throw new PluginApiError('CONFLICT', 'Inlay changed while it was being read', { retryable: true })
        }
        if (!(read.data instanceof Uint8Array)
            || Object.getPrototypeOf(read.data) !== Uint8Array.prototype) {
            throw new PluginApiError('INTERNAL', 'Inlay storage returned invalid bytes', { retryable: true })
        }
        if (read.data.byteLength > options.maxBytes || read.data.byteLength > MAX_OUTPUT_BYTES) {
            throw new PluginApiError('RESOURCE_LIMIT', 'Inlay bytes exceed maxBytes')
        }
        const mediaType = typeof read.mediaType === 'string'
            ? read.mediaType.split(';', 1)[0].trim().toLowerCase()
            : ''
        if (!mediaType.startsWith('image/')) {
            throw new PluginApiError('DECODE_FAILED', 'Stored Inlay is not an image')
        }
        this.ensureActive()
        return {
            id: record.id,
            name: record.name,
            revision: record.revision,
            mediaType,
            data: read.data.slice(),
        }
    }

    async deleteInlay(id: string, rawOptions: { expectedRevision?: string } = {}) {
        await this.requirePermission()
        if (!nonEmptyString(id)) invalidArgument('Inlay id must be non-empty')
        const options = plainDataObject(rawOptions, ['expectedRevision'], 'deleteInlay options')
        const expectedRevision = options.expectedRevision === undefined
            ? undefined
            : requiredString(options.expectedRevision, 'expectedRevision must be non-empty')
        const record = await this.adapter.getInlay(id)
        if (!record) return { deleted: false as const, reason: 'not-found' as const }
        const metadata = record.lifecycle
        if (!validMetadata(metadata) || metadata.ownerPrincipalId !== this.context.principalId) {
            throw new PluginApiError('PERMISSION_DENIED', 'Inlay is not owned by the current plugin')
        }
        if (await deterministicInlayId(metadata.ownerPrincipalId, metadata.idempotencyKey) !== id) {
            throw new PluginApiError('PERMISSION_DENIED', 'Inlay lifecycle identity is malformed')
        }
        if (expectedRevision !== undefined && expectedRevision !== record.revision) {
            throw new PluginApiError('CONFLICT', 'Inlay revision changed', {
                details: { expectedRevision, actualRevision: record.revision },
            })
        }
        if (await this.adapter.hasReference(id)) {
            return { deleted: false as const, reason: 'referenced' as const }
        }
        if (!await this.adapter.removeInlay(id)) {
            throw new PluginApiError('INTERNAL', 'Inlay storage did not confirm removal', { retryable: true })
        }
        this.ledger.releaseDurable(metadata.ownerPrincipalId, metadata.operation, metadata.idempotencyKey)
        return { deleted: true as const }
    }
}
