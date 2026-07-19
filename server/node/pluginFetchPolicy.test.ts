import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import policy from './pluginFetchPolicy.cjs'

const {
    canonicalPublicHttpsUrl,
    isForbiddenAddress,
    securePolicyFetch,
    createPluginFetchAuthGate,
} = policy as {
    canonicalPublicHttpsUrl: (url: string) => URL
    isForbiddenAddress: (address: string) => boolean
    securePolicyFetch: (request: Record<string, unknown>, dependencies: Record<string, unknown>) => Promise<{
        status: number; headers: Record<string, string>; body: Buffer
    }>
    createPluginFetchAuthGate: (authenticate: (request: unknown) => Promise<boolean>) =>
        (request: unknown, response: { status: (status: number) => { send: (body: unknown) => void } }, next: () => void) => Promise<void>
}

const response = (status: number, headers: Record<string, string> = {}, chunks: number[] = []) => ({
    status,
    headers,
    body: (async function* () { for (const length of chunks) yield Buffer.alloc(length) })(),
    cancel: vi.fn(),
})

describe('Node plugin fetch policy', () => {
    it('rejects unauthenticated bridge callers before the JSON body parser', async () => {
        const next = vi.fn()
        const send = vi.fn()
        const gate = createPluginFetchAuthGate(async () => false)
        await gate({}, { status: vi.fn(() => ({ send })) }, next)
        expect(next).not.toHaveBeenCalled()
        expect(send).toHaveBeenCalledWith({ error: 'Unauthorized' })

        const source = readFileSync(resolve(process.cwd(), 'server/node/server.cjs'), 'utf8')
        expect(source.indexOf("app.use('/plugin-native-fetch', pluginFetchEarlyAuthGate)"))
            .toBeGreaterThan(-1)
        expect(source.indexOf("app.use('/plugin-native-fetch', pluginFetchEarlyAuthGate)"))
            .toBeLessThan(source.indexOf("app.use(express.json"))
    })
    it.each([
        '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.1', '172.16.0.1',
        '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
        '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1',
        'ff00::1', '2001:db8::1', '::127.0.0.1', '::ffff:8.8.8.8', 'fec0::1',
        '64:ff9b:1::8.8.8.8', '64:ff9b:1::127.0.0.1', '64:ff9b::127.0.0.1',
    ])('rejects private, loopback, link-local, reserved, multicast, and mapped address %s', (address) => {
        expect(isForbiddenAddress(address)).toBe(true)
    })

    it('canonicalizes public HTTPS including alternate IPv4 and rejects unsafe schemes or credentials', () => {
        expect(canonicalPublicHttpsUrl('https://0x08080808/path').hostname).toBe('8.8.8.8')
        expect(canonicalPublicHttpsUrl('https://BÜCHER.example:443/path').origin).toBe('https://xn--bcher-kva.example')
        for (const unsafe of [
            'http://example.com', 'file:///tmp/x', 'data:text/plain,x', 'blob:https://example.com/x',
            'https://user:pass@example.com', 'https://127.1', 'https://[::127.0.0.1]', 'https://[::ffff:8.8.8.8]',
            'https://[fec0::1]', 'https://[64:ff9b:1::8.8.8.8]',
            'https://[64:ff9b:1::127.0.0.1]', 'https://[64:ff9b::127.0.0.1]',
            'https://localhost', 'https://sub.localhost', 'https://printer.local', 'https://home.arpa',
            'https://risuai.xyz/api', 'https://api.risuai.net', 'https://sionyw.com/',
        ]) expect(() => canonicalPublicHttpsUrl(unsafe)).toThrow()
        for (const safe of [
            'https://192.88.98.1', 'https://198.51.101.1', 'https://203.0.114.1',
            'https://[64:ff9b::8.8.8.8]', 'https://[64:ff9b:2::8.8.8.8]',
        ]) {
            expect(canonicalPublicHttpsUrl(safe).origin).toBe(new URL(safe).origin)
        }
        expect(canonicalPublicHttpsUrl('https://EXAMPLE.com.:443/path').origin).toBe('https://example.com')
    })

    it('rejects when any DNS answer is forbidden and pins the validated public address', async () => {
        const openConnection = vi.fn(async () => response(200, {}, [2]))
        await expect(securePolicyFetch({
            url: 'https://api.example.com/path', method: 'GET', headers: [], maxRedirects: 5, maxResponseBytes: 5,
        }, {
            resolveAddresses: async () => ['8.8.8.8', '127.0.0.1'], openConnection,
        })).rejects.toThrow(/destination/i)
        expect(openConnection).not.toHaveBeenCalled()

        const result = await securePolicyFetch({
            url: 'https://api.example.com/path', method: 'GET', headers: [], maxRedirects: 5, maxResponseBytes: 5,
        }, {
            resolveAddresses: async () => ['8.8.8.8', '1.1.1.1'], openConnection,
        })
        expect(result.body.byteLength).toBe(2)
        expect(openConnection).toHaveBeenCalledWith(expect.objectContaining({
            address: '8.8.8.8', hostname: 'api.example.com', servername: 'api.example.com',
        }))
    })

    it('rejects caller-controlled routing and framing headers before opening a connection', async () => {
        const openConnection = vi.fn()
        await expect(securePolicyFetch({
            url: 'https://api.example.com', method: 'POST',
            headers: [['host', 'internal.example'], ['content-length', '1']], body: 'x',
            maxRedirects: 5, maxResponseBytes: 5,
        }, { resolveAddresses: async () => ['8.8.8.8'], openConnection })).rejects.toThrow(/headers/i)
        expect(openConnection).not.toHaveBeenCalled()
    })

    it('re-resolves and re-pins every allowed redirect and detects DNS rebinding', async () => {
        const resolveAddresses = vi.fn(async () => ['8.8.8.8'])
        const openConnection = vi.fn(async ({ url }: { url: URL }) => url.pathname === '/start'
            ? response(302, { location: 'https://cdn.example.com/final' })
            : response(200, {}, [2]))
        const result = await securePolicyFetch({
            url: 'https://api.example.com/start', method: 'GET', headers: [['authorization', 'Bearer secret']],
            allowedOrigins: ['https://api.example.com', 'https://cdn.example.com'],
            secretHeaderNames: ['authorization'], maxRedirects: 5, maxResponseBytes: 10,
        }, { resolveAddresses, openConnection })
        expect(result.body.byteLength).toBe(2)
        expect(resolveAddresses).toHaveBeenNthCalledWith(1, 'api.example.com')
        expect(resolveAddresses).toHaveBeenNthCalledWith(2, 'cdn.example.com')
        expect(openConnection).toHaveBeenNthCalledWith(2, expect.objectContaining({ address: '8.8.8.8' }))

        let lookup = 0
        await expect(securePolicyFetch({
            url: 'https://api.example.com/start', method: 'GET', headers: [], maxRedirects: 5, maxResponseBytes: 10,
        }, {
            resolveAddresses: async () => ++lookup === 1 ? ['8.8.8.8'] : ['127.0.0.1'],
            openConnection: async () => response(302, { location: 'https://api.example.com/again' }),
        })).rejects.toThrow(/destination/i)
    })

    it('allows exactly five redirects, rejects the sixth and unlisted origins, and strips ordinary credentials cross-origin', async () => {
        let redirects = 0
        const seenHeaders: Array<Array<[string, string]>> = []
        const openConnection = vi.fn(async ({ headers }: { headers: Array<[string, string]> }) => {
            seenHeaders.push(headers)
            if (redirects++ < 5) return response(302, { location: `https://cdn.example.com/${redirects}` })
            return response(200, {}, [1])
        })
        await expect(securePolicyFetch({
            url: 'https://api.example.com/0', method: 'GET',
            headers: [['authorization', 'ordinary'], ['x-api-key', 'ordinary'], ['x-test', 'safe']],
            allowedOrigins: ['https://api.example.com', 'https://cdn.example.com'],
            secretHeaderNames: [], maxRedirects: 5, maxResponseBytes: 10,
        }, { resolveAddresses: async () => ['8.8.8.8'], openConnection })).resolves.toMatchObject({ status: 200 })
        expect(seenHeaders[1]).not.toContainEqual(['authorization', 'ordinary'])
        expect(seenHeaders[1]).not.toContainEqual(['x-api-key', 'ordinary'])

        redirects = 0
        await expect(securePolicyFetch({
            url: 'https://api.example.com/0', method: 'GET', headers: [],
            allowedOrigins: ['https://api.example.com', 'https://cdn.example.com'],
            secretHeaderNames: [], maxRedirects: 4, maxResponseBytes: 10,
        }, { resolveAddresses: async () => ['8.8.8.8'], openConnection })).rejects.toThrow(/redirect/i)

        await expect(securePolicyFetch({
            url: 'https://api.example.com/0', method: 'GET', headers: [['authorization', 'secret']],
            allowedOrigins: ['https://api.example.com'], secretHeaderNames: ['authorization'],
            maxRedirects: 5, maxResponseBytes: 10,
        }, {
            resolveAddresses: async () => ['8.8.8.8'],
            openConnection: async () => response(302, { location: 'https://other.example.com/' }),
        })).rejects.toThrow(/origin/i)
    })

    it('enforces declared and actual response byte boundaries and abort', async () => {
        await expect(securePolicyFetch({
            url: 'https://api.example.com', method: 'GET', headers: [], maxRedirects: 5, maxResponseBytes: 5,
        }, {
            resolveAddresses: async () => ['8.8.8.8'],
            openConnection: async () => response(200, { 'content-length': '6' }, [1]),
        })).rejects.toThrow(/response/i)
        await expect(securePolicyFetch({
            url: 'https://api.example.com', method: 'GET', headers: [], maxRedirects: 5, maxResponseBytes: 5,
        }, {
            resolveAddresses: async () => ['8.8.8.8'],
            openConnection: async () => response(200, { 'content-length': '5' }, [3, 3]),
        })).rejects.toThrow(/response/i)

        const controller = new AbortController(); controller.abort()
        await expect(securePolicyFetch({
            url: 'https://api.example.com', method: 'GET', headers: [], maxRedirects: 5,
            maxResponseBytes: 5, signal: controller.signal,
        }, { resolveAddresses: async () => ['8.8.8.8'], openConnection: vi.fn() })).rejects.toThrow(/aborted/i)
    })
})
