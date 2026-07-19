import { PluginApiError } from './errors'
import { assertUtf8Limit } from './limits'

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')

const invalidArgument = (message: string): never => {
    throw new PluginApiError('INVALID_ARGUMENT', message)
}

const plainObjectKeys = (value: object) => {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalidArgument('Invalid idempotency argument')
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) invalidArgument('Invalid idempotency argument')
    for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidArgument('Invalid idempotency argument')
    }
    return keys as string[]
}

const assertDenseArray = (value: unknown[]) => {
    const ownKeys = Reflect.ownKeys(value)
    if (Object.getPrototypeOf(value) !== Array.prototype || ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
        invalidArgument('Invalid idempotency argument')
    }
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidArgument('Invalid idempotency argument')
    }
}

const canonicalValue = async (value: unknown, seen = new Set<object>(), excludeTransportKey = false): Promise<string> => {
    if (value === null) return 'null:'
    if (typeof value === 'string') return `string:${JSON.stringify(value)}`
    if (typeof value === 'boolean') return `boolean:${value ? '1' : '0'}`
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new PluginApiError('INVALID_ARGUMENT', 'Invalid idempotency argument')
        return `number:${Object.is(value, -0) ? '0' : JSON.stringify(value)}`
    }
    if (typeof value !== 'object') throw new PluginApiError('INVALID_ARGUMENT', 'Invalid idempotency argument')
    if (ArrayBuffer.isView(value)) {
        const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(view).buffer)
        return `binary:${view.byteLength}:${hex(digest)}`
    }
    if (value instanceof ArrayBuffer) {
        const digest = await crypto.subtle.digest('SHA-256', value)
        return `binary:${value.byteLength}:${hex(digest)}`
    }
    if (seen.has(value)) throw new PluginApiError('INVALID_ARGUMENT', 'Cyclic idempotency argument')
    seen.add(value)
    let result: string
    if (Array.isArray(value)) {
        assertDenseArray(value)
        const values: string[] = []
        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!
            values.push(await canonicalValue(descriptor.value, seen))
        }
        result = `array:[${values.join(',')}]`
    } else {
        const object = value as Record<string, unknown>
        const entries: string[] = []
        for (const key of plainObjectKeys(object).sort()) {
            if (excludeTransportKey && key === 'idempotencyKey') continue
            entries.push(`${JSON.stringify(key)}:${await canonicalValue(object[key], seen)}`)
        }
        result = `object:{${entries.join(',')}}`
    }
    seen.delete(value)
    return result
}

export async function canonicalArgumentsDigest(args: unknown): Promise<string> {
    const excludeTransportKey = !!args && typeof args === 'object' && !Array.isArray(args)
        && !ArrayBuffer.isView(args) && !(args instanceof ArrayBuffer)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(await canonicalValue(args, new Set(), excludeTransportKey)))
    return hex(digest)
}

interface LedgerRecord<T = unknown> {
    digestPromise: Promise<string>
    promise: Promise<T>
    result?: T
    completedAt?: number
    accessedAt: number
    durable: boolean
    releaseRequested?: boolean
}

export class IdempotencyLedger {
    private records = new Map<string, LedgerRecord>()
    private maxOrdinary: number
    private retentionMs: number
    private now: () => number
    private digest: (args: unknown) => Promise<string>

    constructor(options: {
        maxOrdinaryRecordsPerPrincipal?: number
        retentionMs?: number
        now?: () => number
        digest?: (args: unknown) => Promise<string>
    } = {}) {
        this.maxOrdinary = options.maxOrdinaryRecordsPerPrincipal ?? 4096
        this.retentionMs = options.retentionMs ?? 86_400_000
        this.now = options.now ?? Date.now
        this.digest = options.digest ?? canonicalArgumentsDigest
    }

    async run<T>(principalId: string, operation: string, idempotencyKey: string, args: unknown, execute: () => Promise<T>, options: { durable?: boolean } = {}): Promise<T> {
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
            throw new PluginApiError('INVALID_ARGUMENT', 'idempotencyKey is required')
        }
        assertUtf8Limit(idempotencyKey, 256, 'idempotencyKey')
        const key = JSON.stringify([principalId, operation, idempotencyKey])
        let existing = this.records.get(key) as LedgerRecord<T> | undefined
        if (existing && !existing.durable && existing.completedAt !== undefined
            && this.now() - existing.completedAt > this.retentionMs) {
            this.records.delete(key)
            existing = undefined
        }
        if (existing) {
            const [incomingDigest, existingDigest] = await Promise.all([this.digest(args), existing.digestPromise])
            if (existingDigest !== incomingDigest) throw new PluginApiError('CONFLICT', 'Idempotency key arguments conflict')
            existing.accessedAt = this.now()
            return existing.promise
        }
        if (!options.durable) {
            const ordinary = [...this.records.entries()]
                .filter(([recordKey, record]) => JSON.parse(recordKey)[0] === principalId && !record.durable)
                .sort((a, b) => a[1].accessedAt - b[1].accessedAt)
            const requiredEvictions = ordinary.length - this.maxOrdinary + 1
            const eligible = ordinary.filter(([, record]) =>
                record.completedAt !== undefined && this.now() - record.completedAt > this.retentionMs)
            if (requiredEvictions > 0 && eligible.length >= requiredEvictions) {
                for (const [recordKey] of eligible.slice(0, requiredEvictions)) this.records.delete(recordKey)
            }
            if (this.size(principalId, false) >= this.maxOrdinary) {
                throw new PluginApiError('RESOURCE_LIMIT', 'Idempotency ledger retention capacity is full', {
                    retryable: true,
                })
            }
        }
        const digestPromise = this.digest(args)
        const record: LedgerRecord<T> = {
            digestPromise, accessedAt: this.now(), durable: options.durable ?? false,
            promise: Promise.resolve(undefined as T),
        }
        record.promise = digestPromise.then(() => execute()).then((result) => {
            record.result = result
            record.completedAt = this.now()
            record.accessedAt = this.now()
            if (record.releaseRequested && this.records.get(key) === record) this.records.delete(key)
            return result
        }, (error) => {
            if (this.records.get(key) === record) this.records.delete(key)
            throw error
        })
        // Publish this invocation before the first digest await so lifecycle
        // release can mark this exact durable call without a lasting tombstone.
        this.records.set(key, record)
        return record.promise
    }

    releaseDurable(principalId: string, operation: string, idempotencyKey: string) {
        const key = JSON.stringify([principalId, operation, idempotencyKey])
        const record = this.records.get(key)
        if (!record?.durable) return
        if (record.completedAt === undefined) record.releaseRequested = true
        else if (this.records.get(key) === record) this.records.delete(key)
    }

    size(principalId: string, includeDurable = true) {
        return [...this.records.entries()].filter(([key, record]) => JSON.parse(key)[0] === principalId && (includeDurable || !record.durable)).length
    }

}
