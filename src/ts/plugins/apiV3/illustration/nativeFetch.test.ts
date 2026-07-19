import { describe, expect, it, vi } from 'vitest'
import { createPluginExecutionContext } from './permissions'
import { MemoryPluginSecretBackend, PluginSecretService } from './pluginSecretStore'
import { canonicalizePluginSecretPolicy } from './secretPolicy'
import {
    PluginNativeFetchService,
    PluginSecretFetchRateLimiter,
    createWebPolicyTransport,
    normalizePluginNativeFetch,
    registerPluginSecretFetchRateLimitLifecycle,
    type PolicyTransport,
    type PolicyTransportRequest,
} from './nativeFetch'
import { SecurityConfirmationQueue } from '../../securityConfirmationQueue'
import { PluginDataLifecycleRegistry } from '../../pluginDataLifecycle'

const principal = '11111111-1111-4111-8111-111111111111'
const execution = () => createPluginExecutionContext({ principalId: principal, name: 'demo', displayName: 'Demo' })

const makeSecrets = async () => {
    const owner = execution()
    const backend = new MemoryPluginSecretBackend()
    await backend.write(principal, 'key', {
        value: 'top-secret',
        policy: canonicalizePluginSecretPolicy({
            allowedOrigins: ['https://api.example.com', 'https://cdn.example.com'],
            uses: [
                { kind: 'header', name: 'authorization', prefix: 'Bearer ' },
                { kind: 'json-body', pointer: '/auth/token', prefix: 'Token ' },
            ],
        }),
    })
    const secrets = new PluginSecretService(owner.context, backend, {
        requirePermission: async () => undefined,
        queue: new SecurityConfirmationQueue(),
    })
    return { owner, backend, secrets }
}

describe('nativeFetch request codec', () => {
    it('keeps host-owned Risu origins unreachable without over-blocking lookalike public hosts', async () => {
        for (const url of ['https://risuai.xyz/api', 'https://api.risuai.net', 'https://sionyw.com/']) {
            await expect(normalizePluginNativeFetch(url)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        }
        await expect(normalizePluginNativeFetch('https://notrisuai.xyz.example/path')).resolves.toBeTruthy()
    })

    it('normalizes record, tuple, and DOM Headers without consuming caller objects', async () => {
        const record = { 'X-Test': 'one', Authorization: { pluginSecret: 'key' } }
        const tuple: Array<[string, string | { pluginSecret: string }]> = [
            ['X-Test', 'one'], ['Authorization', { pluginSecret: 'key' }],
        ]
        const dom = new Headers([['X-Test', 'one'], ['X-Other', 'two']])
        expect((await normalizePluginNativeFetch('https://api.example.com/path', { headers: record })).headers)
            .toEqual([['x-test', 'one'], ['authorization', { pluginSecret: 'key' }]])
        expect((await normalizePluginNativeFetch('https://api.example.com/path', { headers: tuple })).headers)
            .toEqual([['x-test', 'one'], ['authorization', { pluginSecret: 'key' }]])
        expect((await normalizePluginNativeFetch('https://api.example.com/path', { headers: dom })).headers)
            .toEqual([['x-other', 'two'], ['x-test', 'one']])
        expect(record.Authorization).toEqual({ pluginSecret: 'key' })
        expect(tuple[1][1]).toEqual({ pluginSecret: 'key' })
        expect(dom.get('x-test')).toBe('one')
    })

    it('normalizes replayable body codecs and preserves exact views and generated content types', async () => {
        const arrayBuffer = Uint8Array.from([9, 1, 2, 3, 8]).buffer
        const view = new Uint8Array(arrayBuffer, 1, 3)
        const normalizedView = await normalizePluginNativeFetch('https://api.example.com', { method: 'POST', body: view })
        expect([...normalizedView.body as Uint8Array]).toEqual([1, 2, 3])
        expect([...view]).toEqual([1, 2, 3])

        const blob = new Blob(['hello'], { type: 'text/plain' })
        const normalizedBlob = await normalizePluginNativeFetch('https://api.example.com', { method: 'POST', body: blob })
        expect(new TextDecoder().decode(normalizedBlob.body as Uint8Array)).toBe('hello')
        expect(normalizedBlob.headers).toContainEqual(['content-type', 'text/plain'])
        expect(await blob.text()).toBe('hello')

        const params = new URLSearchParams({ a: 'one two' })
        const normalizedParams = await normalizePluginNativeFetch('https://api.example.com', { method: 'POST', body: params })
        expect(normalizedParams.body).toBe('a=one+two')
        expect(normalizedParams.headers).toContainEqual(['content-type', 'application/x-www-form-urlencoded;charset=UTF-8'])
        expect(params.get('a')).toBe('one two')

        const form = new FormData()
        form.append('field', 'value')
        const normalizedForm = await normalizePluginNativeFetch('https://api.example.com', { method: 'POST', body: form })
        expect(normalizedForm.body).toBeInstanceOf(Uint8Array)
        expect(normalizedForm.headers.find(([name]) => name === 'content-type')?.[1]).toMatch(/^multipart\/form-data;\s*boundary=/i)
        expect(form.get('field')).toBe('value')
    })

    it('reuses an exact host-owned Uint8Array after the sandbox transfer without another body copy', async () => {
        const transferred = Uint8Array.from([1, 2, 3])
        const normalized = await normalizePluginNativeFetch('https://api.example.com', {
            method: 'POST', body: transferred,
        })
        expect(normalized.body).toBe(transferred)

        const backing = Uint8Array.from([9, 1, 2, 3, 8])
        const partial = backing.subarray(1, 4)
        const normalizedPartial = await normalizePluginNativeFetch('https://api.example.com', {
            method: 'POST', body: partial,
        })
        expect(normalizedPartial.body).not.toBe(partial)
        expect([...normalizedPartial.body as Uint8Array]).toEqual([1, 2, 3])
    })

    it('rejects streams, unknown bodies, legacy Secret refs, mutual bodies, and exact byte overages', async () => {
        await expect(normalizePluginNativeFetch('https://api.example.com', {
            method: 'POST', body: new ReadableStream(),
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(normalizePluginNativeFetch('https://api.example.com', {
            method: 'POST', body: { unknown: true } as never,
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(normalizePluginNativeFetch('https://api.example.com', {
            headers: { Authorization: { secretHeader: 'Authorization' } } as never,
        })).rejects.toThrow(/pluginSecret/)
        await expect(normalizePluginNativeFetch('https://api.example.com', {
            headers: { Host: 'internal.example', 'Content-Length': '1' },
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        await expect(normalizePluginNativeFetch('https://api.example.com', {
            method: 'POST', body: 'x', jsonBody: {},
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

        await expect(normalizePluginNativeFetch('https://api.example.com', { method: 'POST', body: 'éé' }, {
            maxBodyBytes: 4, maxJsonBodyBytes: 4, maxAggregateBytes: 128,
        })).resolves.toBeTruthy()
        await expect(normalizePluginNativeFetch('https://api.example.com', { method: 'POST', body: 'ééx' }, {
            maxBodyBytes: 4, maxJsonBodyBytes: 4, maxAggregateBytes: 128,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        await expect(normalizePluginNativeFetch('https://api.example.com', { method: 'POST', jsonBody: { x: '123' } }, {
            maxBodyBytes: 16, maxJsonBodyBytes: 11, maxAggregateBytes: 128,
        })).resolves.toBeTruthy()
        await expect(normalizePluginNativeFetch('https://api.example.com', { method: 'POST', jsonBody: { x: '1234' } }, {
            maxBodyBytes: 16, maxJsonBodyBytes: 11, maxAggregateBytes: 128,
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })

    it.each([
        { credentials: 'include' },
        { referrer: 'https://caller.example/' },
        { referrerPolicy: 'origin' },
        { keepalive: true },
        { mode: 'no-cors' },
        { redirect: 'follow' },
        { cache: 'default' },
        { integrity: 'sha256-unsafe' },
    ])('rejects unsafe or non-portable RequestInit before transport: %#', async (unsafe) => {
        await expect(normalizePluginNativeFetch('https://api.example.com', unsafe as never))
            .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })

    it('accepts only explicit safe RequestInit values and normalizes them away', async () => {
        const normalized = await normalizePluginNativeFetch('https://api.example.com', {
            credentials: 'omit', referrer: '', referrerPolicy: 'no-referrer', keepalive: false,
            mode: 'cors', redirect: 'manual', cache: 'no-store',
        })
        expect(normalized.requestInit).toEqual({})
    })
})

describe('policy-bound nativeFetch', () => {
    it('resolves exact header and JSON pointer leaves only immediately before transport', async () => {
        const { secrets } = await makeSecrets()
        const requests: PolicyTransportRequest[] = []
        const transport: PolicyTransport = { request: async (request) => {
            requests.push(request)
            return new Response('ok', { status: 200 })
        } }
        const service = new PluginNativeFetchService(secrets, transport)
        const input = {
            auth: { token: { pluginSecret: 'key' } },
            keep: { pluginSecret: 'key', extra: true },
        }
        const response = await service.fetch('https://api.example.com/v1', {
            method: 'POST',
            headers: { Authorization: { pluginSecret: 'key' }, 'X-Test': 'ordinary' },
            jsonBody: input as never,
        })
        expect(await response.text()).toBe('ok')
        expect(requests).toHaveLength(1)
        expect(requests[0].headers).toContainEqual(['authorization', 'Bearer top-secret'])
        expect(JSON.parse(requests[0].body as string)).toEqual({
            auth: { token: 'Token top-secret' }, keep: { pluginSecret: 'key', extra: true },
        })
        expect(input.auth.token).toEqual({ pluginSecret: 'key' })
        expect(requests[0].allowedOrigins).toEqual(['https://api.example.com', 'https://cdn.example.com'])
        expect(requests[0].secretHeaderNames).toEqual(['authorization'])
        expect(requests[0].requestInit).toEqual({})
    })

    it.each([
        ['origin', 'https://wrong.example.com', { headers: { authorization: { pluginSecret: 'key' } } }],
        ['header', 'https://api.example.com', { headers: { 'x-api-key': { pluginSecret: 'key' } } }],
        ['pointer', 'https://api.example.com', { method: 'POST', jsonBody: { wrong: { pluginSecret: 'key' } } }],
    ])('rejects a mismatched %s without opening transport', async (_kind, url, options) => {
        const { secrets } = await makeSecrets()
        const transport: PolicyTransport = { request: vi.fn() }
        const service = new PluginNativeFetchService(secrets, transport)
        await expect(service.fetch(url, options as never)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        expect(transport.request).not.toHaveBeenCalled()
    })

    it('enforces resolved JSON, aggregate, and response exact/one-over limits', async () => {
        const { secrets } = await makeSecrets()
        const responseFor = (chunks: number[], contentLength?: string) => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                chunks.forEach((length) => controller.enqueue(new Uint8Array(length)))
                controller.close()
            },
        }), { headers: contentLength === undefined ? {} : { 'content-length': contentLength } })
        let response = responseFor([2, 3], '5')
        const transport: PolicyTransport = { request: async () => response }
        const service = new PluginNativeFetchService(secrets, transport, {
            maxBodyBytes: 32, maxJsonBodyBytes: 20, maxAggregateBytes: 64, maxResponseBytes: 5,
        })
        expect((await (await service.fetch('https://api.example.com')).arrayBuffer()).byteLength).toBe(5)

        response = responseFor([6], '6')
        await expect(service.fetch('https://api.example.com')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
        response = responseFor([3, 3], '5')
        await expect((await service.fetch('https://api.example.com')).arrayBuffer()).rejects.toBeTruthy()

        const oversizedResolved = new PluginNativeFetchService(secrets, transport, {
            maxBodyBytes: 64, maxJsonBodyBytes: 8, maxAggregateBytes: 64, maxResponseBytes: 8,
        })
        await expect(oversizedResolved.fetch('https://api.example.com', {
            method: 'POST', jsonBody: { auth: { token: { pluginSecret: 'key' } } },
        })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })

        response = new Response('x', { headers: { 'x-long': '123456' } })
        const boundedHeaders = new PluginNativeFetchService(secrets, transport, {
            maxBodyBytes: 64, maxJsonBodyBytes: 64, maxAggregateBytes: 128,
            maxResponseBytes: 8, maxResponseHeaderBytes: 8,
        })
        await expect(boundedHeaders.fetch('https://api.example.com')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    })

    it('aborts transport and releases a response reader on caller cancellation', async () => {
        const { secrets } = await makeSecrets()
        const cancelled = vi.fn()
        const body = new ReadableStream<Uint8Array>({
            pull() { /* stays pending */ },
            cancel: cancelled,
        })
        let transportSignal: AbortSignal | undefined
        const transport: PolicyTransport = { request: async (request) => {
            transportSignal = request.signal
            return new Response(body)
        } }
        const service = new PluginNativeFetchService(secrets, transport)
        const controller = new AbortController()
        const response = await service.fetch('https://api.example.com', { signal: controller.signal })
        controller.abort()
        await expect(response.arrayBuffer()).rejects.toBeTruthy()
        expect(transportSignal?.aborted).toBe(true)
        expect(cancelled).toHaveBeenCalled()
    })

    it('rechecks plugin unload after an asynchronous Secret read and never opens transport', async () => {
        const { owner, backend, secrets } = await makeSecrets()
        const originalRead = backend.read.bind(backend)
        let markStarted!: () => void
        let releaseRead!: () => void
        const started = new Promise<void>((resolve) => { markStarted = resolve })
        const gate = new Promise<void>((resolve) => { releaseRead = resolve })
        vi.spyOn(backend, 'read').mockImplementation(async (...args) => {
            markStarted()
            await gate
            return originalRead(...args)
        })
        const transport: PolicyTransport = { request: vi.fn() }
        const service = new PluginNativeFetchService(secrets, transport)
        const request = service.fetch('https://api.example.com', {
            headers: { authorization: { pluginSecret: 'key' } },
        })
        await started
        owner.abortController.abort()
        releaseRead()
        await expect(request).rejects.toMatchObject({ code: 'ABORTED' })
        expect(transport.request).not.toHaveBeenCalled()
    })

    it('combines plugin unload with caller cancellation for pending transport and response readers', async () => {
        const pendingSetup = await makeSecrets()
        let pendingSignal: AbortSignal | undefined
        const pendingTransport: PolicyTransport = { request: (request) => new Promise((_resolve, reject) => {
            pendingSignal = request.signal
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }) }
        const pendingService = new PluginNativeFetchService(pendingSetup.secrets, pendingTransport)
        const pending = pendingService.fetch('https://api.example.com')
        await vi.waitFor(() => expect(pendingSignal).toBeDefined())
        pendingSetup.owner.abortController.abort()
        await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
        expect(pendingSignal?.aborted).toBe(true)

        const responseSetup = await makeSecrets()
        const cancelled = vi.fn()
        const body = new ReadableStream<Uint8Array>({ pull() {}, cancel: cancelled })
        const responseService = new PluginNativeFetchService(responseSetup.secrets, {
            request: async () => new Response(body),
        })
        const response = await responseService.fetch('https://api.example.com')
        responseSetup.owner.abortController.abort()
        await expect(response.arrayBuffer()).rejects.toBeTruthy()
        expect(cancelled).toHaveBeenCalled()
    })

    it('rejects unsafe RequestInit before reading a Secret or opening transport', async () => {
        const { backend, secrets } = await makeSecrets()
        const read = vi.spyOn(backend, 'read')
        const transport: PolicyTransport = { request: vi.fn() }
        const service = new PluginNativeFetchService(secrets, transport)
        await expect(service.fetch('https://api.example.com', {
            headers: { authorization: { pluginSecret: 'key' } }, credentials: 'include',
        } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        expect(read).not.toHaveBeenCalled()
        expect(transport.request).not.toHaveBeenCalled()
    })

    it('redacts transport failures and never returns resolved request material', async () => {
        const { secrets } = await makeSecrets()
        const transport: PolicyTransport = { request: async () => { throw new Error('top-secret leaked by backend') } }
        const service = new PluginNativeFetchService(secrets, transport)
        const error = await service.fetch('https://api.example.com', {
            headers: { authorization: { pluginSecret: 'key' } },
        }).then(() => { throw new Error('expected rejection') }, (reason) => reason as Error)
        expect(error.message).not.toContain('top-secret')
        expect((error as Error & { code?: string }).code).toBe('NETWORK')
    })

    it('rate-limits Secret-bearing requests per principal across service instances', async () => {
        const { secrets } = await makeSecrets()
        const transport: PolicyTransport = { request: vi.fn(async () => new Response('ok')) }
        let now = 1_000
        const limiter = new PluginSecretFetchRateLimiter({ maximum: 2, now: () => now })
        const first = new PluginNativeFetchService(secrets, transport, {}, limiter)
        const second = new PluginNativeFetchService(secrets, transport, {}, limiter)
        const options = { headers: { authorization: { pluginSecret: 'key' } } } as const
        await first.fetch('https://api.example.com', options)
        await second.fetch('https://api.example.com', options)
        await expect(first.fetch('https://api.example.com', options)).rejects.toMatchObject({
            code: 'RESOURCE_LIMIT', retryable: true,
        })
        expect(transport.request).toHaveBeenCalledTimes(2)
        now += 60_001
        await expect(first.fetch('https://api.example.com', options)).resolves.toBeInstanceOf(Response)
    })

    it('clears the principal rate-limit bucket when its private plugin data is purged', async () => {
        const lifecycle = new PluginDataLifecycleRegistry()
        const limiter = new PluginSecretFetchRateLimiter({ maximum: 1, now: () => 1_000 })
        const unregister = registerPluginSecretFetchRateLimitLifecycle(limiter, lifecycle)
        limiter.consume(principal)
        expect(() => limiter.consume(principal)).toThrow(/rate limit/i)
        await lifecycle.run(principal, 'purge')
        expect(() => limiter.consume(principal)).not.toThrow()
        unregister()
    })
})

describe('secure web redirect transport', () => {
    it('strips ordinary Authorization and X-API-Key credentials before a cross-origin hop', async () => {
        const seen: RequestInit[] = []
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            seen.push(init ?? {})
            return seen.length === 1
                ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/final' } })
                : new Response('ok')
        }) as unknown as typeof fetch
        const transport = createWebPolicyTransport(fetchImpl)
        await transport.request({
            url: 'https://api.example.com/start', method: 'GET',
            headers: [['authorization', 'ordinary'], ['x-api-key', 'ordinary'], ['x-test', 'safe']],
            allowedOrigins: ['https://api.example.com', 'https://cdn.example.com'],
            secretHeaderNames: [], maxRedirects: 5,
            requestInit: { credentials: 'include', mode: 'no-cors', referrer: 'https://unsafe.example/' } as never,
        })
        expect(seen[1].headers).toEqual([['x-test', 'safe']])
        for (const init of seen) {
            expect(init).toMatchObject({
                credentials: 'omit', referrer: '', referrerPolicy: 'no-referrer',
                keepalive: false, mode: 'cors', cache: 'no-store', redirect: 'manual',
            })
        }
    })

    it('revalidates each same-origin or separately allowlisted hop and honors the five-hop boundary', async () => {
        const visited: string[] = []
        const locations = [1, 2, 3, 4, 5].map((n) => `https://api.example.com/${n}`)
        const fetchImpl = vi.fn(async (url: string) => {
            visited.push(url)
            const location = locations.shift()
            return location ? new Response(null, { status: 302, headers: { location } }) : new Response('ok')
        }) as unknown as typeof fetch
        const transport = createWebPolicyTransport(fetchImpl)
        const response = await transport.request({
            url: 'https://api.example.com/0', method: 'GET', headers: [],
            allowedOrigins: ['https://api.example.com'], secretHeaderNames: [], maxRedirects: 5,
        })
        expect(await response.text()).toBe('ok')
        expect(visited).toHaveLength(6)
    })

    it('rejects the sixth, unlisted, private, and opaque redirect before forwarding credentials', async () => {
        const sixRedirects = vi.fn(async (_url: string, init?: RequestInit) => new Response(null, {
            status: 302, headers: { location: 'https://api.example.com/next' },
        })) as unknown as typeof fetch
        const transport = createWebPolicyTransport(sixRedirects)
        await expect(transport.request({
            url: 'https://api.example.com/0', method: 'GET', headers: [['authorization', 'Bearer secret']],
            allowedOrigins: ['https://api.example.com'], secretHeaderNames: ['authorization'], maxRedirects: 5,
        })).rejects.toMatchObject({ code: 'NETWORK' })
        expect(sixRedirects).toHaveBeenCalledTimes(6)

        const unlisted = createWebPolicyTransport(vi.fn(async () => new Response(null, {
            status: 302, headers: { location: 'https://other.example.com/next' },
        })) as unknown as typeof fetch)
        await expect(unlisted.request({
            url: 'https://api.example.com', method: 'GET', headers: [['authorization', 'Bearer secret']],
            allowedOrigins: ['https://api.example.com'], secretHeaderNames: ['authorization'], maxRedirects: 5,
        })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

        const privateHop = createWebPolicyTransport(vi.fn(async () => new Response(null, {
            status: 302, headers: { location: 'https://127.0.0.1/private' },
        })) as unknown as typeof fetch)
        await expect(privateHop.request({
            url: 'https://api.example.com', method: 'GET', headers: [], maxRedirects: 5,
        })).rejects.toMatchObject({ code: 'NETWORK' })

        const opaqueResponse = new Response(null, { status: 200 })
        Object.defineProperty(opaqueResponse, 'type', { value: 'opaqueredirect' })
        const opaque = createWebPolicyTransport(vi.fn(async () => opaqueResponse) as unknown as typeof fetch)
        await expect(opaque.request({
            url: 'https://api.example.com', method: 'GET', headers: [], maxRedirects: 5,
        })).rejects.toMatchObject({ code: 'NETWORK' })
    })
})
