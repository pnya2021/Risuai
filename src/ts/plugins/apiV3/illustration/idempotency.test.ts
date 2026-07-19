import { describe, expect, it, vi } from 'vitest'
import { IdempotencyLedger, canonicalArgumentsDigest } from './idempotency'

describe('idempotency ledger', () => {
    it('joins in-flight work and replays completed results', async () => {
        const ledger = new IdempotencyLedger()
        let release!: (value: string) => void
        const operation = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
        const first = ledger.run('p', 'create', 'key', { value: 1 }, operation)
        const joined = ledger.run('p', 'create', 'key', { value: 1 }, operation)
        await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1))
        release('done')
        expect(await joined).toBe('done')
        expect(await ledger.run('p', 'create', 'key', { value: 1 }, operation)).toBe('done')
        expect(operation).toHaveBeenCalledTimes(1)
    })

    it('excludes only the transport idempotency key and includes binary bytes', async () => {
        expect(await canonicalArgumentsDigest({ idempotencyKey: 'a', nested: { idempotencyKey: 'kept' }, bytes: new Uint8Array([1]) }))
            .toBe(await canonicalArgumentsDigest({ idempotencyKey: 'b', nested: { idempotencyKey: 'kept' }, bytes: new Uint8Array([1]) }))
        expect(await canonicalArgumentsDigest({ bytes: new Uint8Array([1]) }))
            .not.toBe(await canonicalArgumentsDigest({ bytes: new Uint8Array([2]) }))
    })

    it('domain-separates binary values from crafted plain-object lookalikes', async () => {
        const bytes = new Uint8Array([1, 2, 3])
        const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        const binaryDigest = [...digestBytes].map((value) => value.toString(16).padStart(2, '0')).join('')
        const lookalike = { $binary: binaryDigest, byteLength: bytes.byteLength }

        expect(await canonicalArgumentsDigest(bytes)).not.toBe(await canonicalArgumentsDigest(lookalike))
        const ledger = new IdempotencyLedger()
        await ledger.run('p', 'op', 'binary-key', bytes, async () => 'binary')
        await expect(ledger.run('p', 'op', 'binary-key', lookalike, async () => 'object'))
            .rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('rejects non-plain and sparse inputs while allowing shared acyclic objects', async () => {
        await expect(canonicalArgumentsDigest(new Date())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(canonicalArgumentsDigest(new Map())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(canonicalArgumentsDigest([, 1])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        const shared = { value: 1 }
        await expect(canonicalArgumentsDigest({ left: shared, right: shared })).resolves.toMatch(/^[0-9a-f]{64}$/)
        expect(await canonicalArgumentsDigest({ value: {} })).not.toBe(await canonicalArgumentsDigest({ value: new Uint8Array() }))
        const extended = [1] as unknown[] & { [key: symbol]: unknown }
        Object.defineProperty(extended, Symbol('extra'), { value: 2, enumerable: true })
        await expect(canonicalArgumentsDigest(extended)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        let getterReads = 0
        const accessor: unknown[] = []
        Object.defineProperty(accessor, '0', { enumerable: true, get: () => { getterReads++; return 1 } })
        await expect(canonicalArgumentsDigest(accessor)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        expect(getterReads).toBe(0)
    })

    it('rejects conflicting arguments and 257-byte keys', async () => {
        const ledger = new IdempotencyLedger()
        await expect(ledger.run('p', 'op', 123 as unknown as string, {}, async () => 1))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await ledger.run('p', 'op', 'k', { a: 1 }, async () => 1)
        await expect(ledger.run('p', 'op', 'k', { a: 2 }, async () => 2)).rejects.toMatchObject({ code: 'CONFLICT' })
        await expect(ledger.run('p', 'op', '가'.repeat(86), {}, async () => 1)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(ledger.run('p', 'op', 'a'.repeat(256), {}, async () => 1)).resolves.toBe(1)
    })

    it('keeps the full 24-hour guarantee, then uses LRU capacity, and preserves durable records', async () => {
        let now = 0
        const ledger = new IdempotencyLedger({ maxOrdinaryRecordsPerPrincipal: 2, retentionMs: 86_400_000, now: () => now })
        await ledger.run('p', 'op', 'a', {}, async () => 'a')
        await ledger.run('p', 'op', 'b', {}, async () => 'b')
        await expect(ledger.run('p', 'op', 'c', {}, async () => 'c')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        expect(ledger.size('p', false)).toBe(2)
        now = 86_400_000
        expect(await ledger.run('p', 'op', 'b', {}, async () => 'new')).toBe('b')
        now++
        expect(await ledger.run('p', 'op', 'c', {}, async () => 'c')).toBe('c')
        expect(ledger.size('p', false)).toBe(2)
        expect(await ledger.run('p', 'op', 'b', {}, async () => 'new')).toBe('new')
        await expect(ledger.run('p', 'op', 'a', {}, async () => 'new-a')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await ledger.run('p', 'durable', 'd', {}, async () => 'durable', { durable: true })
        now += 999_999_999
        expect(await ledger.run('p', 'durable', 'd', {}, async () => 'changed', { durable: true })).toBe('durable')
        ledger.releaseDurable('p', 'durable', 'd')
        expect(await ledger.run('p', 'durable', 'd', {}, async () => 'changed', { durable: true })).toBe('changed')
    })

    it('defers durable release until in-flight work settles and cannot delete a successor record', async () => {
        const ledger = new IdempotencyLedger()
        let rejectFirst!: (error: Error) => void
        const execute = vi.fn()
            .mockImplementationOnce(() => new Promise<string>((_, reject) => { rejectFirst = reject }))
            .mockResolvedValueOnce('second')
        const first = ledger.run('p', 'durable', 'key', {}, execute, { durable: true })
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
        ledger.releaseDurable('p', 'durable', 'key')
        const joined = ledger.run('p', 'durable', 'key', {}, execute, { durable: true })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(execute).toHaveBeenCalledOnce()
        rejectFirst(new Error('first failed'))
        await expect(first).rejects.toThrow('first failed')
        await expect(joined).rejects.toThrow('first failed')
        await expect(ledger.run('p', 'durable', 'key', {}, execute, { durable: true })).resolves.toBe('second')
        expect(execute).toHaveBeenCalledTimes(2)
    })

    it('records an invocation-bound durable release before the first digest settles', async () => {
        let resolveFirstDigest!: (value: string) => void
        let digestCalls = 0
        const ledger = new IdempotencyLedger({
            digest: vi.fn(() => {
                digestCalls += 1
                if (digestCalls === 1) return new Promise<string>((resolve) => { resolveFirstDigest = resolve })
                return Promise.resolve('same-digest')
            }),
        })
        const execute = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second')
        const first = ledger.run('p', 'durable', 'key', {}, execute, { durable: true })
        ledger.releaseDurable('p', 'durable', 'key')
        resolveFirstDigest('same-digest')

        await expect(first).resolves.toBe('first')
        expect(ledger.size('p')).toBe(0)
        await expect(ledger.run('p', 'durable', 'key', {}, execute, { durable: true })).resolves.toBe('second')
        expect(execute).toHaveBeenCalledTimes(2)
    })

    it('enforces the real 4,096/4,097 ordinary-record boundary', async () => {
        const ledger = new IdempotencyLedger()
        await Promise.all(Array.from({ length: 4096 }, (_, n) => ledger.run('p', 'op', `key-${n}`, {}, async () => n)))
        expect(ledger.size('p', false)).toBe(4096)
        await expect(ledger.run('p', 'op', 'key-4096', {}, async () => 4096)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    }, 30_000)
})
