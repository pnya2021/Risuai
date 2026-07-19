import { describe, expect, it, vi } from 'vitest'
import { PluginApiError } from './errors'
import { PluginPermissionService, MemoryPermissionPersistence, createPluginExecutionContext } from './permissions'
import { canonicalizePluginSecretPolicy } from './secretPolicy'
import {
    MemoryPluginSecretBackend,
    type PluginSecretBackend,
    PluginSecretService,
    PluginSecretRetentionRegistry,
    ProtectedWebPluginSecretBackend,
    registerPluginSecretLifecycle,
} from './pluginSecretStore'
import { SecurityConfirmationQueue } from '../../securityConfirmationQueue'
import { PluginDataLifecycleRegistry } from '../../pluginDataLifecycle'

const errorCode = (operation: () => unknown) => {
    try {
        operation()
        return undefined
    } catch (error) {
        return (error as PluginApiError).code
    }
}

describe('plugin secret policy', () => {
    it('canonicalizes exact HTTPS origins, IDNs, default ports, headers, and RFC 6901 pointers', () => {
        expect(canonicalizePluginSecretPolicy({
            allowedOrigins: ['https://EXAMPLE.com:443', 'https://BÜCHER.example'],
            uses: [
                { kind: 'header', name: 'Authorization', prefix: 'Bearer ' },
                { kind: 'json-body', pointer: '/auth/~0token/~1value' },
            ],
        })).toEqual({
            allowedOrigins: ['https://example.com', 'https://xn--bcher-kva.example'],
            uses: [
                { kind: 'header', name: 'authorization', prefix: 'Bearer ' },
                { kind: 'json-body', pointer: '/auth/~0token/~1value' },
            ],
        })
    })

    it.each([
        'http://example.com',
        'https://example.com/path',
        'https://example.com/?query=1',
        'https://example.com/#fragment',
        'https://user:pass@example.com',
        'https://*.example.com',
        'https://localhost',
        'https://sub.localhost',
        'https://printer.local',
        'https://home.arpa',
        'https://127.1',
        'https://[::1]',
        'https://[::127.0.0.1]',
        'https://[::ffff:8.8.8.8]',
        'https://[fec0::1]',
        'https://[64:ff9b:1::8.8.8.8]',
        'https://[64:ff9b:1::127.0.0.1]',
        'https://[64:ff9b::127.0.0.1]',
        'file:///tmp/secret',
        'data:text/plain,no',
        'blob:https://example.com/id',
    ])('rejects a non-public or non-exact origin: %s', (origin) => {
        expect(errorCode(() => canonicalizePluginSecretPolicy({
            allowedOrigins: [origin], uses: [{ kind: 'header', name: 'authorization' }],
        }))).toBe('INVALID_ARGUMENT')
    })

    it('does not over-block public neighbors of reserved IPv4 ranges', () => {
        for (const origin of [
            'https://192.88.98.1', 'https://198.51.101.1', 'https://203.0.114.1',
            'https://[64:ff9b::8.8.8.8]', 'https://[64:ff9b:2::8.8.8.8]',
        ]) {
            expect(canonicalizePluginSecretPolicy({
                allowedOrigins: [origin], uses: [{ kind: 'header', name: 'authorization' }],
            }).allowedOrigins).toEqual([new URL(origin).origin])
        }
    })

    it.each([
        { kind: 'header', name: '' },
        { kind: 'header', name: 'bad header' },
        { kind: 'header', name: 'x-test\r\ninjected' },
        { kind: 'header', name: 'host' },
        { kind: 'header', name: 'content-length' },
        { kind: 'header', name: 'proxy-authorization' },
        { kind: 'header', name: 'x-test', prefix: 'ok\nno' },
        { kind: 'json-body', pointer: 'not/a/pointer' },
        { kind: 'json-body', pointer: '/bad/~2escape' },
        { kind: 'json-body', pointer: '/ok', prefix: 'ok\rno' },
    ])('rejects an invalid placement %#', (use) => {
        expect(errorCode(() => canonicalizePluginSecretPolicy({
            allowedOrigins: ['https://example.com'], uses: [use] as never,
        }))).toBe('INVALID_ARGUMENT')
    })

    it('rejects empty and duplicate origins or uses', () => {
        expect(errorCode(() => canonicalizePluginSecretPolicy({
            allowedOrigins: [], uses: [{ kind: 'header', name: 'authorization' }],
        }))).toBe('INVALID_ARGUMENT')
        expect(errorCode(() => canonicalizePluginSecretPolicy({
            allowedOrigins: ['https://example.com'], uses: [],
        }))).toBe('INVALID_ARGUMENT')
        expect(errorCode(() => canonicalizePluginSecretPolicy({
            allowedOrigins: ['https://example.com', 'https://EXAMPLE.com:443'],
            uses: [{ kind: 'header', name: 'authorization' }],
        }))).toBe('INVALID_ARGUMENT')
        expect(errorCode(() => canonicalizePluginSecretPolicy({
            allowedOrigins: ['https://example.com'],
            uses: [
                { kind: 'header', name: 'Authorization' },
                { kind: 'header', name: 'authorization' },
            ],
        }))).toBe('INVALID_ARGUMENT')
        expect(errorCode(() => canonicalizePluginSecretPolicy({
            allowedOrigins: ['https://example.com'],
            uses: [
                { kind: 'header', name: 'authorization', prefix: 'Bearer ' },
                { kind: 'header', name: 'authorization', prefix: 'Token ' },
            ],
        }))).toBe('INVALID_ARGUMENT')
        expect(errorCode(() => canonicalizePluginSecretPolicy({
            allowedOrigins: ['https://example.com'],
            uses: [
                { kind: 'json-body', pointer: '/token', prefix: 'Bearer ' },
                { kind: 'json-body', pointer: '/token', prefix: 'Token ' },
            ],
        }))).toBe('INVALID_ARGUMENT')
    })
})

const plugin = (principalId: string, name = 'demo') => createPluginExecutionContext({
    principalId, name, displayName: 'Demo Plugin',
})

const policy = {
    allowedOrigins: ['https://api.example.com'],
    uses: [
        { kind: 'header' as const, name: 'Authorization', prefix: 'Bearer ' },
        { kind: 'json-body' as const, pointer: '/api_key' },
    ],
}

const decideCurrent = (queue: SecurityConfirmationQueue, decision: boolean) => {
    const current = queue.current()!
    expect(current).toBeTruthy()
    expect(queue.decide(current.digest, current.presentationId, decision)).toBe(true)
}

describe('write-only plugin secret service', () => {
    it('uses a stable host Web Lock for protected cross-context mutations', async () => {
        const request = vi.fn(async <T>(
            _name: string,
            _options: LockOptions,
            operation: () => Promise<T>,
        ) => operation())
        const previous = Object.getOwnPropertyDescriptor(navigator, 'locks')
        Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
        try {
            const backend = new ProtectedWebPluginSecretBackend() as ProtectedWebPluginSecretBackend & {
                withPrincipalLock<T>(principalId: string, operation: () => Promise<T>): Promise<T>
            }
            await expect(backend.withPrincipalLock('principal', async () => 'result')).resolves.toBe('result')
            expect(request).toHaveBeenCalledWith(
                'risu-plugin-secrets-v3:["principal"]',
                { mode: 'exclusive' },
                expect.any(Function),
            )
        } finally {
            if (previous) Object.defineProperty(navigator, 'locks', previous)
            else Reflect.deleteProperty(navigator, 'locks')
        }
    })

    it('fails closed for mutations but permits retired cleanup when Web Locks are unavailable', async () => {
        const previous = Object.getOwnPropertyDescriptor(navigator, 'locks')
        Reflect.deleteProperty(navigator, 'locks')
        try {
            const backend = new ProtectedWebPluginSecretBackend()
            const cleanup = vi.fn(async () => 'cleaned')

            await expect(backend.status()).resolves.toEqual({
                supported: true, available: false, reason: 'disabled',
            })
            expect(() => backend.withPrincipalLock('principal', async () => undefined))
                .toThrow('cross-context protected storage lock unavailable')
            await expect(backend.withRetiredPrincipalCleanup('principal', cleanup)).resolves.toBe('cleaned')
            expect(cleanup).toHaveBeenCalledOnce()
        } finally {
            if (previous) Object.defineProperty(navigator, 'locks', previous)
            else Reflect.deleteProperty(navigator, 'locks')
        }
    })

    it('serializes permission then full placement consent and isolates values by principal', async () => {
        const queue = new SecurityConfirmationQueue()
        const permissions = new PluginPermissionService(new MemoryPermissionPersistence(), queue)
        const backend = new MemoryPluginSecretBackend()
        const owner = plugin('11111111-1111-4111-8111-111111111111')
        const other = plugin('22222222-2222-4222-8222-222222222222', 'other')
        const service = new PluginSecretService(owner.context, backend, {
            requirePermission: () => permissions.require(owner.context, 'secrets'), queue,
        })

        const write = service.setPluginSecret('nai-key', 'secret-value', policy)
        await queue.whenPresented()
        expect(queue.current()?.request.kind).toBe('permission')
        decideCurrent(queue, true)
        await queue.whenPresented()
        const consent = queue.current()!
        expect(consent.request.kind).toBe('secret-placement')
        expect(consent.copy).toContain('Demo Plugin (demo)')
        expect(consent.copy).toContain('https://api.example.com')
        expect(consent.copy).toContain('authorization')
        expect(consent.copy).toContain('/api_key')
        expect(consent.copy).not.toContain('secret-value')
        decideCurrent(queue, true)
        await write

        expect(await service.hasPluginSecret('nai-key')).toBe(true)
        expect((service as unknown as Record<string, unknown>).getPluginSecret).toBeUndefined()
        expect(await backend.read(other.context.principalId, 'nai-key')).toBeNull()
        expect((await backend.read(owner.context.principalId, 'nai-key'))?.value).toBe('secret-value')
    })

    it('writes nothing on permission or placement denial and cancels on unload', async () => {
        const queue = new SecurityConfirmationQueue()
        const denied = plugin('11111111-1111-4111-8111-111111111111')
        const backend = new MemoryPluginSecretBackend()
        const permissionDenied = new PluginSecretService(denied.context, backend, {
            requirePermission: async () => { throw new PluginApiError('PERMISSION_DENIED', 'denied') }, queue,
        })
        await expect(permissionDenied.setPluginSecret('key', 'value', policy)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(await backend.listIds(denied.context.principalId)).toEqual([])

        const service = new PluginSecretService(denied.context, backend, { requirePermission: async () => undefined, queue })
        const placementDenied = service.setPluginSecret('key', 'value', policy)
        await queue.whenPresented()
        decideCurrent(queue, false)
        await expect(placementDenied).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(await backend.listIds(denied.context.principalId)).toEqual([])

        const unloading = service.setPluginSecret('key', 'value', policy)
        await queue.whenPresented()
        denied.abortController.abort()
        await expect(unloading).rejects.toMatchObject({ code: 'ABORTED' })
        expect(await backend.listIds(denied.context.principalId)).toEqual([])
    })

    it('atomically replaces value and policy only after showing the complete new policy', async () => {
        const queue = new SecurityConfirmationQueue()
        const owner = plugin('11111111-1111-4111-8111-111111111111')
        const backend = new MemoryPluginSecretBackend()
        const service = new PluginSecretService(owner.context, backend, { requirePermission: async () => undefined, queue })
        const first = service.setPluginSecret('key', 'first', policy)
        await queue.whenPresented(); decideCurrent(queue, true); await first

        const nextPolicy = {
            allowedOrigins: ['https://other.example.com'],
            uses: [{ kind: 'json-body' as const, pointer: '/nested/token', prefix: 'Token ' }],
        }
        const replacement = service.setPluginSecret('key', 'second', nextPolicy)
        await queue.whenPresented()
        expect(queue.current()?.request.kind).toBe('secret-replacement')
        expect(queue.current()?.copy).toContain('https://other.example.com')
        expect(queue.current()?.copy).toContain('/nested/token')
        expect((await backend.read(owner.context.principalId, 'key'))?.value).toBe('first')
        decideCurrent(queue, true)
        await replacement
        expect(await backend.read(owner.context.principalId, 'key')).toMatchObject({
            value: 'second', policy: canonicalizePluginSecretPolicy(nextPolicy),
        })

        backend.failNextWrite = true
        const failed = service.setPluginSecret('key', 'third', policy)
        await queue.whenPresented(); decideCurrent(queue, true)
        await expect(failed).rejects.toMatchObject({ code: 'INTERNAL' })
        expect((await backend.read(owner.context.principalId, 'key'))?.value).toBe('second')
    })

    it('enforces availability, quotas, CR/LF rejection, deletion, and existence-only checks', async () => {
        const owner = plugin('11111111-1111-4111-8111-111111111111')
        const unavailable = new MemoryPluginSecretBackend({ available: false })
        const service = new PluginSecretService(owner.context, unavailable, {
            requirePermission: async () => undefined, queue: new SecurityConfirmationQueue(),
        })
        await expect(service.setPluginSecret('key', 'value', policy)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
        expect(await unavailable.listIds(owner.context.principalId)).toEqual([])

        const backend = new MemoryPluginSecretBackend()
        const queue = new SecurityConfirmationQueue()
        const writable = new PluginSecretService(owner.context, backend, { requirePermission: async () => undefined, queue })
        await expect(writable.setPluginSecret('key', 'bad\r\nvalue', policy)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        const write = writable.setPluginSecret('key', 'value', policy)
        await queue.whenPresented(); decideCurrent(queue, true); await write
        expect(await writable.deletePluginSecret('key')).toBe(true)
        expect(await writable.deletePluginSecret('key')).toBe(false)
        expect(await writable.hasPluginSecret('key')).toBe(false)
    })

    it('purges by default and quarantines explicit retention without reassociation', async () => {
        const backend = new MemoryPluginSecretBackend()
        const retention = new PluginSecretRetentionRegistry()
        const lifecycle = new PluginDataLifecycleRegistry()
        const unregister = registerPluginSecretLifecycle(backend, lifecycle, retention)
        await backend.write('default-principal', 'key', { value: 'one', policy: canonicalizePluginSecretPolicy(policy) })
        await backend.write('retained-principal', 'key', { value: 'two', policy: canonicalizePluginSecretPolicy(policy) })
        retention.retainOnUninstall('retained-principal')

        await lifecycle.uninstall('default-principal')
        await lifecycle.uninstall('retained-principal')
        expect(await backend.read('default-principal', 'key')).toBeNull()
        expect(await backend.read('retained-principal', 'key')).toBeNull()
        expect(backend.quarantinedCount()).toBe(1)
        expect(backend.quarantinedEntries()).toEqual([expect.objectContaining({
            principalId: 'retained-principal', id: 'key',
            record: expect.objectContaining({ value: 'two' }),
        })])
        expect(await backend.read('new-principal', 'key')).toBeNull()
        unregister()
    })

    it.each([false, true])(
        'finishes retired cleanup when the normal cross-context lock is unavailable (retain: %s)',
        async (retain) => {
            class LockUnavailableBackend extends MemoryPluginSecretBackend {
                retiredCleanupCalls = 0
                mutationLockCalls = 0
                retired = false
                override status() {
                    return Promise.resolve({ supported: true as const, available: false, reason: 'disabled' as const })
                }
                withPrincipalLock<T>(_principalId: string, _operation: () => Promise<T>): Promise<T> {
                    this.mutationLockCalls++
                    return Promise.reject(new Error('cross-context protected storage lock unavailable'))
                }
                withRetiredPrincipalCleanup<T>(_principalId: string, operation: () => Promise<T>): Promise<T> {
                    this.retiredCleanupCalls++
                    return operation()
                }
                markPrincipalRetired() {
                    this.retired = true
                    return Promise.resolve()
                }
                isPrincipalRetired() { return Promise.resolve(this.retired) }
            }
            const backend = new LockUnavailableBackend()
            const retention = new PluginSecretRetentionRegistry()
            const lifecycle = new PluginDataLifecycleRegistry()
            const principalId = 'lock-unavailable-principal'
            const unregister = registerPluginSecretLifecycle(backend, lifecycle, retention)
            await backend.write(principalId, 'key', {
                value: 'value', policy: canonicalizePluginSecretPolicy(policy),
            })
            if (retain) retention.retainOnUninstall(principalId)

            await lifecycle.uninstall(principalId)

            expect(await backend.listIds(principalId)).toEqual([])
            expect(backend.quarantinedCount()).toBe(retain ? 1 : 0)
            expect(backend.retiredCleanupCalls).toBe(1)
            expect(backend.mutationLockCalls).toBe(0)
            unregister()
        },
    )

    it('rechecks plugin liveness after an asynchronous Secret read', async () => {
        let releaseRead!: () => void
        let readStarted!: () => void
        const started = new Promise<void>((resolve) => { readStarted = resolve })
        const release = new Promise<void>((resolve) => { releaseRead = resolve })
        class DelayedReadBackend extends MemoryPluginSecretBackend {
            delay = false
            override async read(principalId: string, id: string) {
                if (this.delay) {
                    readStarted()
                    await release
                }
                return super.read(principalId, id)
            }
        }
        const backend = new DelayedReadBackend()
        const owner = plugin('11111111-1111-4111-8111-111111111111')
        await backend.write(owner.context.principalId, 'key', {
            value: 'secret', policy: canonicalizePluginSecretPolicy(policy),
        })
        backend.delay = true
        const service = new PluginSecretService(owner.context, backend, { requirePermission: async () => undefined })
        const resolving = service.resolveForRequest('key')
        await started
        owner.abortController.abort()
        releaseRead()
        await expect(resolving).rejects.toMatchObject({ code: 'ABORTED' })
    })

    it('serializes the 32-item quota check and write across service instances', async () => {
        let releaseWrite!: () => void
        let writeStarted!: () => void
        const started = new Promise<void>((resolve) => { writeStarted = resolve })
        const release = new Promise<void>((resolve) => { releaseWrite = resolve })
        class DelayedFirstWriteBackend extends MemoryPluginSecretBackend {
            armed = false
            blocked = false
            override async write(principalId: string, id: string, record: Parameters<MemoryPluginSecretBackend['write']>[2]) {
                if (this.armed && !this.blocked) {
                    this.blocked = true
                    writeStarted()
                    await release
                }
                await super.write(principalId, id, record)
            }
        }
        const backend = new DelayedFirstWriteBackend()
        const principalId = '11111111-1111-4111-8111-111111111111'
        for (let index = 0; index < 31; index++) {
            await backend.write(principalId, `existing-${index}`, {
                value: 'secret', policy: canonicalizePluginSecretPolicy(policy),
            })
        }
        backend.armed = true
        const firstQueue = new SecurityConfirmationQueue()
        const secondQueue = new SecurityConfirmationQueue()
        const first = new PluginSecretService(plugin(principalId, 'first').context, backend, {
            requirePermission: async () => undefined, queue: firstQueue,
        })
        const second = new PluginSecretService(plugin(principalId, 'second').context, backend, {
            requirePermission: async () => undefined, queue: secondQueue,
        })

        const firstWrite = first.setPluginSecret('new-first', 'one', policy)
        await firstQueue.whenPresented(); decideCurrent(firstQueue, true)
        await started
        const secondWrite = second.setPluginSecret('new-second', 'two', policy)
        await secondQueue.whenPresented(); decideCurrent(secondQueue, true)
        await Promise.resolve()
        releaseWrite()

        const results = await Promise.allSettled([firstWrite, secondWrite])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toEqual([
            expect.objectContaining({ reason: expect.objectContaining({ code: 'QUOTA_EXCEEDED' }) }),
        ])
        expect(await backend.listIds(principalId)).toHaveLength(32)
    })

    it.each([false, true])(
        'retires during a delayed write without active residue (retain: %s)',
        async (retain) => {
            const events: string[] = []
            let releaseWrite!: () => void
            let writeStarted!: () => void
            const started = new Promise<void>((resolve) => { writeStarted = resolve })
            const release = new Promise<void>((resolve) => { releaseWrite = resolve })
            class DelayedWriteBackend extends MemoryPluginSecretBackend {
                delay = false
                override async write(
                    principalId: string,
                    id: string,
                    record: Parameters<MemoryPluginSecretBackend['write']>[2],
                ) {
                    if (this.delay) {
                        events.push('write:start')
                        writeStarted()
                        await release
                        events.push('write:commit')
                    }
                    await super.write(principalId, id, record)
                }
            }
            const backend = new DelayedWriteBackend()
            const lifecycle = new PluginDataLifecycleRegistry()
            const retention = new PluginSecretRetentionRegistry()
            lifecycle.register('release-write', 'purge', () => {
                events.push('purge:entered')
                setTimeout(() => {
                    events.push('write:release')
                    releaseWrite()
                }, 0)
            })
            const unregister = registerPluginSecretLifecycle(backend, lifecycle, retention)
            const owner = plugin('33333333-3333-4333-8333-333333333333')
            const queue = new SecurityConfirmationQueue()
            const service = new PluginSecretService(owner.context, backend, {
                requirePermission: async () => undefined,
                queue,
                isPrincipalRetiring: (principalId) => lifecycle.isRetiring(principalId),
            })
            if (retain) retention.retainOnUninstall(owner.context.principalId)
            backend.delay = true

            const write = service.setPluginSecret('late-key', 'late-value', policy)
            await queue.whenPresented(); decideCurrent(queue, true)
            await started
            const retirement = lifecycle.retirePrincipal(owner.context.principalId, {
                invalidate: () => {
                    events.push('invalidate')
                    owner.abortController.abort()
                },
            })

            const [writeResult, retirementResult] = await Promise.allSettled([write, retirement])
            expect(writeResult).toEqual(expect.objectContaining({
                status: 'rejected', reason: expect.objectContaining({ code: 'ABORTED' }),
            }))
            expect(retirementResult.status).toBe('fulfilled')
            expect(await backend.listIds(owner.context.principalId)).toEqual([])
            expect(backend.quarantinedEntries()).toEqual(retain
                ? [expect.objectContaining({
                    principalId: owner.context.principalId,
                    id: 'late-key',
                    record: expect.objectContaining({ value: 'late-value' }),
                })]
                : [])
            expect(events.indexOf('write:commit')).toBeLessThan(events.indexOf('invalidate'))
            unregister()
        },
    )

    it('serializes a delayed delete ahead of principal retirement', async () => {
        const events: string[] = []
        let releaseDelete!: () => void
        let deleteStarted!: () => void
        const started = new Promise<void>((resolve) => { deleteStarted = resolve })
        const release = new Promise<void>((resolve) => { releaseDelete = resolve })
        class DelayedDeleteBackend extends MemoryPluginSecretBackend {
            delay = false
            override async delete(principalId: string, id: string) {
                if (this.delay) {
                    events.push('delete:start')
                    deleteStarted()
                    await release
                    events.push('delete:commit')
                }
                return super.delete(principalId, id)
            }
        }
        const backend = new DelayedDeleteBackend()
        const lifecycle = new PluginDataLifecycleRegistry()
        lifecycle.register('release-delete', 'purge', () => {
            events.push('purge:entered')
            setTimeout(() => {
                events.push('delete:release')
                releaseDelete()
            }, 0)
        })
        const unregister = registerPluginSecretLifecycle(backend, lifecycle, new PluginSecretRetentionRegistry())
        const owner = plugin('44444444-4444-4444-8444-444444444444')
        await backend.write(owner.context.principalId, 'key', {
            value: 'value', policy: canonicalizePluginSecretPolicy(policy),
        })
        const service = new PluginSecretService(owner.context, backend, {
            requirePermission: async () => undefined,
            isPrincipalRetiring: (principalId) => lifecycle.isRetiring(principalId),
        })
        backend.delay = true

        const deletion = service.deletePluginSecret('key')
        await started
        const retirement = lifecycle.retirePrincipal(owner.context.principalId, {
            invalidate: () => {
                events.push('invalidate')
                owner.abortController.abort()
            },
        })
        const [deleteResult, retirementResult] = await Promise.allSettled([deletion, retirement])

        expect(deleteResult).toEqual(expect.objectContaining({
            status: 'rejected', reason: expect.objectContaining({ code: 'ABORTED' }),
        }))
        expect(retirementResult.status).toBe('fulfilled')
        expect(events.indexOf('delete:commit')).toBeLessThan(events.indexOf('invalidate'))
        expect(await backend.listIds(owner.context.principalId)).toEqual([])
        unregister()
    })

    it('fails closed for set, has, and resolve when another context retired first', async () => {
        class RetiredBackend extends MemoryPluginSecretBackend {
            isPrincipalRetired() { return Promise.resolve(true) }
        }
        const backend = new RetiredBackend()
        const owner = plugin('66666666-6666-4666-8666-666666666666')
        await backend.write(owner.context.principalId, 'key', {
            value: 'value', policy: canonicalizePluginSecretPolicy(policy),
        })
        const service = new PluginSecretService(owner.context, backend, {
            requirePermission: async () => undefined,
            isPrincipalRetiring: () => false,
        })

        await expect(service.setPluginSecret('new-key', 'new-value', policy))
            .rejects.toMatchObject({ code: 'ABORTED' })
        await expect(service.hasPluginSecret('key')).rejects.toMatchObject({ code: 'ABORTED' })
        await expect(service.resolveForRequest('key')).rejects.toMatchObject({ code: 'ABORTED' })
        expect(await backend.listIds(owner.context.principalId)).toEqual(['key'])
    })

    it.each([false, true])(
        'coordinates retirement with a delayed write from another storage context (retain: %s)',
        async (retain) => {
            const storage = new MemoryPluginSecretBackend()
            const shared = {
                retired: new Set<string>(),
                tails: new Map<string, Promise<void>>(),
            }
            let releaseWrite!: () => void
            let writeStarted!: () => void
            const started = new Promise<void>((resolve) => { writeStarted = resolve })
            const release = new Promise<void>((resolve) => { releaseWrite = resolve })

            class SharedContextBackend implements PluginSecretBackend {
                constructor(private delayWrite: boolean) {}
                status() { return storage.status() }
                read(principalId: string, id: string) { return storage.read(principalId, id) }
                async write(
                    principalId: string,
                    id: string,
                    record: Parameters<PluginSecretBackend['write']>[2],
                ) {
                    if (this.delayWrite) {
                        writeStarted()
                        await release
                    }
                    await storage.write(principalId, id, record)
                }
                delete(principalId: string, id: string) { return storage.delete(principalId, id) }
                listIds(principalId: string) { return storage.listIds(principalId) }
                purgePrincipal(principalId: string) { return storage.purgePrincipal(principalId) }
                quarantinePrincipal(principalId: string) { return storage.quarantinePrincipal(principalId) }
                markPrincipalRetired(principalId: string) {
                    shared.retired.add(principalId)
                    return Promise.resolve()
                }
                isPrincipalRetired(principalId: string) { return Promise.resolve(shared.retired.has(principalId)) }
                async withPrincipalLock<T>(principalId: string, operation: () => Promise<T>) {
                    const previous = shared.tails.get(principalId) ?? Promise.resolve()
                    let releaseLock!: () => void
                    const gate = new Promise<void>((resolve) => { releaseLock = resolve })
                    const tail = previous.catch(() => undefined).then(() => gate)
                    shared.tails.set(principalId, tail)
                    await previous.catch(() => undefined)
                    try {
                        return await operation()
                    } finally {
                        releaseLock()
                        if (shared.tails.get(principalId) === tail) shared.tails.delete(principalId)
                    }
                }
            }

            const writerBackend = new SharedContextBackend(true)
            const retiringBackend = new SharedContextBackend(false)
            const lifecycle = new PluginDataLifecycleRegistry()
            const retention = new PluginSecretRetentionRegistry()
            lifecycle.register('release-cross-context-write', 'purge', () => {
                setTimeout(releaseWrite, 0)
            })
            const unregister = registerPluginSecretLifecycle(retiringBackend, lifecycle, retention)
            const owner = plugin('55555555-5555-4555-8555-555555555555')
            const queue = new SecurityConfirmationQueue()
            const service = new PluginSecretService(owner.context, writerBackend, {
                requirePermission: async () => undefined,
                queue,
                isPrincipalRetiring: () => false,
            })
            if (retain) retention.retainOnUninstall(owner.context.principalId)

            const write = service.setPluginSecret('cross-context-key', 'cross-context-value', policy)
            await queue.whenPresented(); decideCurrent(queue, true)
            await started
            const retirement = lifecycle.retirePrincipal(owner.context.principalId, {
                invalidate: () => undefined,
            })
            const [writeResult, retirementResult] = await Promise.allSettled([write, retirement])

            expect(writeResult).toEqual(expect.objectContaining({
                status: 'rejected', reason: expect.objectContaining({ code: 'ABORTED' }),
            }))
            expect(retirementResult.status).toBe('fulfilled')
            expect(await storage.listIds(owner.context.principalId)).toEqual([])
            expect(storage.quarantinedEntries()).toEqual(retain
                ? [expect.objectContaining({
                    principalId: owner.context.principalId,
                    id: 'cross-context-key',
                    record: expect.objectContaining({ value: 'cross-context-value' }),
                })]
                : [])
            unregister()
        },
    )

    it('never places values in consent requests, logs, or caller-visible errors', async () => {
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const queue = new SecurityConfirmationQueue()
        const owner = plugin('11111111-1111-4111-8111-111111111111')
        const backend = new MemoryPluginSecretBackend()
        const service = new PluginSecretService(owner.context, backend, { requirePermission: async () => undefined, queue })
        const write = service.setPluginSecret('key', 'never-log-this', policy)
        await queue.whenPresented()
        expect(JSON.stringify(queue.current())).not.toContain('never-log-this')
        decideCurrent(queue, false)
        const error = await write.catch((reason) => reason as PluginApiError)
        expect(JSON.stringify(error)).not.toContain('never-log-this')
        expect(errorLog.mock.calls.flat().join(' ')).not.toContain('never-log-this')
        errorLog.mockRestore()
    })
})
