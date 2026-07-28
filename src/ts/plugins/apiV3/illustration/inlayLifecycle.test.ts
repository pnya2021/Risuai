import { describe, expect, it, vi } from 'vitest'
import { PluginApiError } from './errors'
import {
    InlayReadRateLimiter,
    InlayLifecycleService,
    type InlayCreateOptions,
    type InlayLifecycleAdapter,
    type InlayLifecycleRecord,
    type InlayReadOptions,
} from './inlayLifecycle'

const context = (
    principalId = '11111111-1111-4111-8111-111111111111',
    signal = new AbortController().signal,
) => ({
    principalId,
    instanceId: `instance-${principalId}`,
    displayName: 'Illustrator',
    signal,
})

const options = (overrides: Partial<InlayCreateOptions> = {}): InlayCreateOptions => ({
    name: 'background.png',
    idempotencyKey: 'pin-background-1',
    context: { kind: 'character', characterId: 'character-1' },
    return: 'descriptor',
    ...overrides,
})

function harness(settings: {
    principalId?: string
    records?: Map<string, InlayLifecycleRecord>
    permissionError?: PluginApiError
    currentCharacterId?: string | null
    referenced?: boolean
    write?: InlayLifecycleAdapter['writeImage']
    read?: InlayLifecycleAdapter['readImage']
    remove?: InlayLifecycleAdapter['removeInlay']
    signal?: AbortSignal
    readRateLimiter?: InlayReadRateLimiter
} = {}) {
    const records = settings.records ?? new Map<string, InlayLifecycleRecord>()
    const permissionService = {
        require: vi.fn(async (_executionContext: unknown, _permission: string) => {
            if (settings.permissionError) throw settings.permissionError
        }),
    }
    const adapter: InlayLifecycleAdapter = {
        getCurrentCharacterId: vi.fn(() => settings.currentCharacterId === undefined
            ? 'character-1'
            : settings.currentCharacterId),
        getInlay: vi.fn(async (id) => records.get(id) ?? null),
        readImage: settings.read ?? vi.fn(async (id) => {
            const record = records.get(id)
            return record ? {
                record: { ...record, lifecycle: record.lifecycle && { ...record.lifecycle } },
                data: new Uint8Array([1, 2, 3]),
                mediaType: 'image/png',
            } : null
        }),
        writeImage: settings.write ?? vi.fn(async (data, request) => {
            await request.beforeMutation()
            records.set(request.id, {
                id: request.id,
                name: request.name,
                revision: request.lifecycle.revision,
                lifecycle: { ...request.lifecycle },
            })
            data.fill(0)
        }),
        hasReference: vi.fn(async () => settings.referenced ?? false),
        removeInlay: settings.remove ?? vi.fn(async (id) => records.delete(id)),
    }
    const service = new InlayLifecycleService(
        context(settings.principalId, settings.signal),
        adapter,
        permissionService,
        { readRateLimiter: settings.readRateLimiter },
    )
    return { adapter, permissionService, records, service }
}

const readOptions = (revision: string, overrides: Partial<InlayReadOptions> = {}): InlayReadOptions => ({
    ifRevision: revision,
    maxBytes: 3,
    ...overrides,
})

const expectCode = async (operation: Promise<unknown>, code: string) => {
    await expect(operation).rejects.toMatchObject({ name: 'PluginApiError', code })
}

describe('owned Inlay create lifecycle', () => {
    it('requires inlayWrite before validation, decode, context lookup, or storage', async () => {
        const denied = new PluginApiError('PERMISSION_DENIED', 'denied')
        const { adapter, permissionService, service } = harness({ permissionError: denied })

        await expect(service.createInlay({} as Uint8Array, {} as InlayCreateOptions)).rejects.toBe(denied)

        expect(permissionService.require).toHaveBeenCalledWith(expect.anything(), 'inlayWrite')
        expect(adapter.getCurrentCharacterId).not.toHaveBeenCalled()
        expect(adapter.getInlay).not.toHaveBeenCalled()
        expect(adapter.writeImage).not.toHaveBeenCalled()
    })

    it('stores host-owned metadata and returns a non-empty descriptor without changing caller bytes', async () => {
        const { records, service } = harness()
        const data = new Uint8Array([1, 2, 3, 4])

        const descriptor = await service.createInlay(data, options())

        expect(descriptor).toEqual({
            id: expect.stringMatching(/^inlay_[0-9a-f]{64}$/),
            revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            name: 'background.png',
        })
        expect(data).toEqual(new Uint8Array([1, 2, 3, 4]))
        expect(records.get(descriptor.id)?.lifecycle).toMatchObject({
            version: 1,
            ownerPrincipalId: context().principalId,
            operation: 'inlay.create.v1',
            idempotencyKey: 'pin-background-1',
            context: { kind: 'character', characterId: 'character-1' },
            revision: descriptor.revision,
        })
        expect(records.get(descriptor.id)?.lifecycle.argumentDigest).toMatch(/^[0-9a-f]{64}$/)
    })

    it('reauthorizes the requested character immediately before storage mutation', async () => {
        const records = new Map<string, InlayLifecycleRecord>()
        const write = vi.fn<InlayLifecycleAdapter['writeImage']>(async (_data, request) => {
            await request.beforeMutation()
            records.set(request.id, {
                id: request.id,
                name: request.name,
                revision: request.lifecycle.revision,
                lifecycle: request.lifecycle,
            })
        })
        const { service } = harness({ currentCharacterId: 'character-2', records, write })

        await expectCode(service.createInlay(new Uint8Array([1]), options()), 'PERMISSION_DENIED')

        expect(write).toHaveBeenCalledOnce()
        expect(records.size).toBe(0)
    })

    it.each([
        ['non-Uint8Array data', new ArrayBuffer(2), options(), 'INVALID_ARGUMENT'],
        ['empty key', new Uint8Array([1]), options({ idempotencyKey: '' }), 'INVALID_ARGUMENT'],
        ['oversized key', new Uint8Array([1]), options({ idempotencyKey: '한'.repeat(86) }), 'RESOURCE_LIMIT'],
        ['empty name', new Uint8Array([1]), options({ name: '' }), 'INVALID_ARGUMENT'],
        ['oversized name', new Uint8Array([1]), options({ name: '한'.repeat(86) }), 'RESOURCE_LIMIT'],
        ['wrong return mode', new Uint8Array([1]), { ...options(), return: 'id' }, 'INVALID_ARGUMENT'],
        ['malformed context', new Uint8Array([1]), { ...options(), context: { kind: 'chat', characterId: 'character-1' } }, 'INVALID_ARGUMENT'],
        ['oversized bytes', new Uint8Array(33_554_433), options(), 'RESOURCE_LIMIT'],
    ])('rejects malformed or over-limit %s', async (_label, data, createOptions, expectedCode) => {
        const { adapter, service } = harness()

        await expectCode(service.createInlay(data as Uint8Array, createOptions as InlayCreateOptions), expectedCode)

        expect(adapter.writeImage).not.toHaveBeenCalled()
    })

    it.each([
        ['decode', new PluginApiError('DECODE_FAILED', 'bad image')],
        ['storage', new Error('storage unavailable')],
    ])('preserves caller bytes when %s fails after the adapter mutates its copy', async (_label, failure) => {
        const data = new Uint8Array([7, 8, 9])
        const write = vi.fn<InlayLifecycleAdapter['writeImage']>(async (copy) => {
            copy.fill(0)
            throw failure
        })
        const { service } = harness({ write })

        await expect(service.createInlay(data, options())).rejects.toBe(failure)

        expect(data).toEqual(new Uint8Array([7, 8, 9]))
    })

    it('joins concurrent identical calls into one stored asset', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const records = new Map<string, InlayLifecycleRecord>()
        const write = vi.fn<InlayLifecycleAdapter['writeImage']>(async (_data, request) => {
            await gate
            await request.beforeMutation()
            records.set(request.id, {
                id: request.id,
                name: request.name,
                revision: request.lifecycle.revision,
                lifecycle: request.lifecycle,
            })
        })
        const { service } = harness({ records, write })
        const data = new Uint8Array([1, 2, 3])

        const first = service.createInlay(data, options())
        const second = service.createInlay(data, options())
        release()

        await expect(Promise.all([first, second])).resolves.toEqual([
            await first,
            await first,
        ])
        expect(write).toHaveBeenCalledOnce()
        expect(records.size).toBe(1)
    })

    it('replays from persisted metadata after service reconstruction without storing twice', async () => {
        const records = new Map<string, InlayLifecycleRecord>()
        const first = harness({ records })
        const descriptor = await first.service.createInlay(new Uint8Array([1, 2]), options())
        const reconstructed = harness({ records })

        await expect(reconstructed.service.createInlay(new Uint8Array([1, 2]), options())).resolves.toEqual(descriptor)

        expect(reconstructed.adapter.writeImage).not.toHaveBeenCalled()
    })

    it('rejects a reused key with different canonical arguments', async () => {
        const { service } = harness()
        await service.createInlay(new Uint8Array([1, 2]), options())

        await expectCode(service.createInlay(new Uint8Array([1, 3]), options()), 'CONFLICT')
        await expectCode(service.createInlay(new Uint8Array([1, 2]), options({ name: 'other.png' })), 'CONFLICT')
    })

    it('scopes deterministic IDs and durable replays to the principal', async () => {
        const records = new Map<string, InlayLifecycleRecord>()
        const alice = harness({ principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', records })
        const bob = harness({ principalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', records })

        const [aliceDescriptor, bobDescriptor] = await Promise.all([
            alice.service.createInlay(new Uint8Array([1]), options()),
            bob.service.createInlay(new Uint8Array([1]), options()),
        ])

        expect(aliceDescriptor.id).not.toBe(bobDescriptor.id)
        expect(records.size).toBe(2)
    })
})

describe('owned Inlay byte read lifecycle', () => {
    it('requires inlayWrite before validation, rate charging, or storage and never requests inlayRead', async () => {
        const denied = new PluginApiError('PERMISSION_DENIED', 'denied')
        const { adapter, permissionService, service } = harness({ permissionError: denied })

        await expect(service.readOwnedInlay('', {} as InlayReadOptions)).rejects.toBe(denied)

        expect(permissionService.require.mock.calls.map((call) => call[1])).toEqual(['inlayWrite'])
        expect(adapter.getInlay).not.toHaveBeenCalled()
        expect(adapter.readImage).not.toHaveBeenCalled()
    })

    it('returns descriptor, normalized media type, and an isolated byte copy for an owned lifecycle record', async () => {
        const source = new Uint8Array([1, 2, 3])
        const read = vi.fn<InlayLifecycleAdapter['readImage']>(async (_id, _maxBytes) => {
            const record = state.records.get(descriptor.id)!
            return { record, data: source, mediaType: 'image/png' }
        })
        const state = harness({ read })
        const descriptor = await state.service.createInlay(source, options())

        const result = await state.service.readOwnedInlay(
            descriptor.id,
            readOptions(descriptor.revision),
        )

        expect(result).toEqual({ ...descriptor, mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) })
        expect(read).toHaveBeenCalledWith(
            descriptor.id,
            3,
            expect.objectContaining({
                ...descriptor,
                lifecycle: expect.objectContaining({ ownerPrincipalId: context().principalId }),
            }),
        )
        expect(result!.data).not.toBe(source)
        result!.data[0] = 9
        expect(source).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('returns null for a missing ID without allocating bytes', async () => {
        const state = harness()

        await expect(state.service.readOwnedInlay(
            'missing',
            readOptions(`sha256:${'0'.repeat(64)}`),
        )).resolves.toBeNull()

        expect(state.adapter.readImage).not.toHaveBeenCalled()
    })

    it.each([
        ['empty id', '', readOptions(`sha256:${'0'.repeat(64)}`)],
        ['short revision', 'inlay-1', readOptions(`sha256:${'0'.repeat(63)}`)],
        ['uppercase revision', 'inlay-1', readOptions(`sha256:${'A'.repeat(64)}`)],
        ['zero maxBytes', 'inlay-1', readOptions(`sha256:${'0'.repeat(64)}`, { maxBytes: 0 })],
        ['fractional maxBytes', 'inlay-1', readOptions(`sha256:${'0'.repeat(64)}`, { maxBytes: 1.5 })],
        ['one-over maxBytes', 'inlay-1', readOptions(`sha256:${'0'.repeat(64)}`, { maxBytes: 33_554_433 })],
        ['unknown option', 'inlay-1', { ...readOptions(`sha256:${'0'.repeat(64)}`), extra: true }],
        ['array options', 'inlay-1', []],
    ])('rejects malformed %s before storage', async (_label, id, value) => {
        const state = harness()

        await expectCode(state.service.readOwnedInlay(id, value as InlayReadOptions), 'INVALID_ARGUMENT')

        expect(state.adapter.getInlay).not.toHaveBeenCalled()
        expect(state.adapter.readImage).not.toHaveBeenCalled()
    })

    it('rejects accessors, symbols, and non-plain option objects before storage', async () => {
        const accessor = Object.defineProperty({ maxBytes: 3 }, 'ifRevision', {
            enumerable: true,
            get() { throw new Error('hostile getter') },
        })
        const symbol = { ...readOptions(`sha256:${'0'.repeat(64)}`), [Symbol('hidden')]: true }
        const inherited = Object.create({ inherited: true })
        Object.assign(inherited, readOptions(`sha256:${'0'.repeat(64)}`))
        const state = harness()

        for (const value of [accessor, symbol, inherited]) {
            await expectCode(state.service.readOwnedInlay('inlay-1', value as InlayReadOptions), 'INVALID_ARGUMENT')
        }
        expect(state.adapter.getInlay).not.toHaveBeenCalled()
    })

    it('rejects stale revision before the byte adapter is called', async () => {
        const state = harness()
        const descriptor = await state.service.createInlay(new Uint8Array([1, 2, 3]), options())

        await expect(state.service.readOwnedInlay(
            descriptor.id,
            readOptions(`sha256:${'0'.repeat(64)}`),
        )).rejects.toMatchObject({
            code: 'CONFLICT', retryable: true,
            details: { expectedRevision: `sha256:${'0'.repeat(64)}`, actualRevision: descriptor.revision },
        })

        expect(state.adapter.readImage).not.toHaveBeenCalled()
    })

    it('fails closed for foreign, legacy, malformed, and relocated lifecycle records', async () => {
        const state = harness()
        const descriptor = await state.service.createInlay(new Uint8Array([1, 2, 3]), options())
        const own = state.records.get(descriptor.id)!
        const foreignId = `inlay_${'b'.repeat(64)}`
        const legacyId = 'legacy-id'
        const malformedId = `inlay_${'c'.repeat(64)}`
        const relocatedId = `inlay_${'d'.repeat(64)}`
        state.records.set(foreignId, {
            ...own, id: foreignId,
            lifecycle: { ...own.lifecycle!, ownerPrincipalId: '22222222-2222-4222-8222-222222222222' },
        })
        state.records.set(legacyId, { id: legacyId, name: 'legacy.png', revision: descriptor.revision })
        state.records.set(malformedId, {
            ...own, id: malformedId, lifecycle: { ...own.lifecycle!, idempotencyKey: '' },
        })
        state.records.set(relocatedId, { ...own, id: relocatedId })

        for (const id of [foreignId, legacyId, malformedId, relocatedId]) {
            await expectCode(state.service.readOwnedInlay(id, readOptions(descriptor.revision)), 'PERMISSION_DENIED')
        }
        expect(state.adapter.readImage).not.toHaveBeenCalled()
    })

    it('accepts Host-normalized bytes whose digest differs from the accepted-input revision', async () => {
        const state = harness()
        const descriptor = await state.service.createInlay(new Uint8Array([1, 2, 3]), options())
        const own = state.records.get(descriptor.id)!
        state.adapter.readImage = vi.fn<InlayLifecycleAdapter['readImage']>(async () => ({
            record: own, data: new Uint8Array([1, 2, 4]), mediaType: 'image/png',
        }))

        await expect(state.service.readOwnedInlay(descriptor.id, readOptions(descriptor.revision)))
            .resolves.toMatchObject({
                ...descriptor,
                data: new Uint8Array([1, 2, 4]),
            })
    })

    it('rejects post-read record races', async () => {
        const state = harness()
        const descriptor = await state.service.createInlay(new Uint8Array([1, 2, 3]), options())
        const own = state.records.get(descriptor.id)!

        state.adapter.readImage = vi.fn(async () => ({
            record: { ...own, name: 'changed.png' },
            data: new Uint8Array([1, 2, 3]),
            mediaType: 'image/png',
        }))
        await expectCode(state.service.readOwnedInlay(descriptor.id, readOptions(descriptor.revision)), 'CONFLICT')
    })

    it('prioritizes abort across permission, record, and byte-read await boundaries', async () => {
        const before = new AbortController()
        before.abort()
        const preAborted = harness({ signal: before.signal })
        await expectCode(preAborted.service.readOwnedInlay(
            'inlay-1', readOptions(`sha256:${'0'.repeat(64)}`),
        ), 'ABORTED')

        const controller = new AbortController()
        const duringRecord = harness({ signal: controller.signal })
        vi.mocked(duringRecord.adapter.getInlay).mockImplementationOnce(async () => {
            controller.abort()
            throw new Error('private storage error')
        })
        await expectCode(duringRecord.service.readOwnedInlay(
            'inlay-1', readOptions(`sha256:${'0'.repeat(64)}`),
        ), 'ABORTED')
    })

    it('sanitizes raw storage failures while preserving typed adapter errors', async () => {
        const raw = harness()
        vi.mocked(raw.adapter.getInlay).mockRejectedValueOnce(new Error('private backend detail'))
        await expect(raw.service.readOwnedInlay(
            'inlay-1', readOptions(`sha256:${'0'.repeat(64)}`),
        )).rejects.toMatchObject({ code: 'INTERNAL', retryable: true })

        const typed = new PluginApiError('RESOURCE_LIMIT', 'bounded failure')
        const state = harness()
        vi.mocked(state.adapter.getInlay).mockRejectedValueOnce(typed)
        await expect(state.service.readOwnedInlay(
            'inlay-1', readOptions(`sha256:${'0'.repeat(64)}`),
        )).rejects.toBe(typed)
    })

    it('allows the 60th principal-wide read and rate-limits the 61st across service instances', async () => {
        const limiter = new InlayReadRateLimiter(() => 1_000)
        const records = new Map<string, InlayLifecycleRecord>()
        const first = harness({ records, readRateLimiter: limiter, principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
        const descriptor = await first.service.createInlay(new Uint8Array([1, 2, 3]), options())
        const second = harness({ records, readRateLimiter: limiter, principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })

        for (let index = 0; index < 60; index++) {
            const service = index % 2 === 0 ? first.service : second.service
            await expect(service.readOwnedInlay(descriptor.id, readOptions(descriptor.revision))).resolves.toBeTruthy()
        }
        await expect(second.service.readOwnedInlay(descriptor.id, readOptions(descriptor.revision)))
            .rejects.toMatchObject({ code: 'RESOURCE_LIMIT', retryable: true, retryAfterMs: 60_000 })
    })
})

describe('owned Inlay delete lifecycle', () => {
    it('returns not-found without reference scanning or mutation', async () => {
        const { adapter, service } = harness()

        await expect(service.deleteInlay('missing')).resolves.toEqual({ deleted: false, reason: 'not-found' })

        expect(adapter.hasReference).not.toHaveBeenCalled()
        expect(adapter.removeInlay).not.toHaveBeenCalled()
    })

    it('deletes its own unreferenced asset and confirms storage removal', async () => {
        const { records, service } = harness()
        const descriptor = await service.createInlay(new Uint8Array([1]), options())

        await expect(service.deleteInlay(descriptor.id, { expectedRevision: descriptor.revision }))
            .resolves.toEqual({ deleted: true })
        expect(records.has(descriptor.id)).toBe(false)
    })

    it('fails closed for stale, foreign, legacy, and malformed ownership without scanning or mutation', async () => {
        const own = harness()
        const descriptor = await own.service.createInlay(new Uint8Array([1]), options())
        const record = own.records.get(descriptor.id)!
        const foreignId = 'inlay_' + 'b'.repeat(64)
        const legacyId = 'legacy-id'
        const malformedId = 'malformed-id'
        own.records.set(foreignId, {
            ...record,
            id: foreignId,
            lifecycle: { ...record.lifecycle!, ownerPrincipalId: 'another-principal' },
        })
        own.records.set(legacyId, { id: legacyId, name: 'legacy.png', revision: 'legacy' })
        own.records.set(malformedId, { ...record, id: malformedId, lifecycle: { ...record.lifecycle!, idempotencyKey: '' } })

        await expectCode(own.service.deleteInlay(descriptor.id, { expectedRevision: 'sha256:' + '0'.repeat(64) }), 'CONFLICT')
        await expectCode(own.service.deleteInlay(foreignId), 'PERMISSION_DENIED')
        await expectCode(own.service.deleteInlay(legacyId), 'PERMISSION_DENIED')
        await expectCode(own.service.deleteInlay(malformedId), 'PERMISSION_DENIED')
        expect(own.adapter.hasReference).not.toHaveBeenCalled()
        expect(own.adapter.removeInlay).not.toHaveBeenCalled()
    })

    it('rejects shape-valid owned lifecycle metadata relocated under a non-deterministic ID', async () => {
        const own = harness()
        const descriptor = await own.service.createInlay(new Uint8Array([1]), options())
        const record = own.records.get(descriptor.id)!
        const relocatedId = 'inlay_' + 'c'.repeat(64)
        own.records.set(relocatedId, { ...record, id: relocatedId })

        await expectCode(own.service.deleteInlay(relocatedId), 'PERMISSION_DENIED')

        expect(own.adapter.hasReference).not.toHaveBeenCalled()
        expect(own.adapter.removeInlay).not.toHaveBeenCalled()
        expect(own.records.has(relocatedId)).toBe(true)
    })

    it('rejects referenced deletion without removing storage', async () => {
        const { adapter, records, service } = harness({ referenced: true })
        const descriptor = await service.createInlay(new Uint8Array([1]), options())

        await expect(service.deleteInlay(descriptor.id)).resolves.toEqual({ deleted: false, reason: 'referenced' })

        expect(records.has(descriptor.id)).toBe(true)
        expect(adapter.removeInlay).not.toHaveBeenCalled()
    })

    it('does not report a failed removal, remains retryable, and allows deterministic recreation after success', async () => {
        const records = new Map<string, InlayLifecycleRecord>()
        let removalAttempts = 0
        const remove = vi.fn(async (id: string) => {
            removalAttempts++
            if (removalAttempts === 1) return false
            return records.delete(id)
        })
        const setup = harness({ records, remove })
        const original = await setup.service.createInlay(new Uint8Array([1]), options())

        await expectCode(setup.service.deleteInlay(original.id), 'INTERNAL')
        expect(records.has(original.id)).toBe(true)
        await expect(setup.service.deleteInlay(original.id)).resolves.toEqual({ deleted: true })
        const recreated = await setup.service.createInlay(new Uint8Array([1]), options())

        expect(recreated.id).toBe(original.id)
        expect(setup.adapter.writeImage).toHaveBeenCalledTimes(2)
    })
})
