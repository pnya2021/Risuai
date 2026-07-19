'use strict'

const dns = require('dns/promises')
const https = require('https')
const net = require('net')

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key'])
const HOST_OWNED_NETWORK_HOSTS = ['risuai.xyz', 'risuai.net', 'sionyw.com']
const FORBIDDEN_REQUEST_HEADERS = new Set([
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie',
    'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
    'permissions-policy', 'proxy-authorization', 'proxy-connection', 'referer',
    'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
])

function ipv4Parts(address) {
    if (net.isIP(address) !== 4) return null
    return address.split('.').map(Number)
}

function ipv6Words(address) {
    let source = String(address).toLowerCase()
    if (source.startsWith('[') && source.endsWith(']')) source = source.slice(1, -1)
    const zone = source.indexOf('%')
    if (zone >= 0) source = source.slice(0, zone)
    const mapped = source.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) {
        const parts = ipv4Parts(mapped[2])
        if (!parts) return null
        source = `${mapped[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
    }
    if (net.isIP(source) !== 6) return null
    const halves = source.split('::')
    const side = (value) => value ? value.split(':').map((part) => Number.parseInt(part, 16)) : []
    const left = side(halves[0])
    const right = side(halves[1])
    return [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
}

function ipv4IsForbidden([a, b, c]) {
    return a === 0 || a === 10 || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
        || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
        || (a === 203 && b === 0 && c === 113)
        || a >= 224
}

function isForbiddenAddress(address) {
    const ipv4 = ipv4Parts(address)
    if (ipv4) return ipv4IsForbidden(ipv4)
    const words = ipv6Words(address)
    if (!words) return true
    const wellKnownNat64 = words[0] === 0x0064 && words[1] === 0xff9b
        && words.slice(2, 6).every((word) => word === 0)
    const embeddedIpv4 = [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff]
    return words.every((word) => word === 0)
        || (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)
        || words.slice(0, 6).every((word) => word === 0)
        || (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
        || (words[0] & 0xfe00) === 0xfc00
        || (words[0] & 0xffc0) === 0xfe80
        || (words[0] & 0xffc0) === 0xfec0
        || (words[0] & 0xff00) === 0xff00
        || (words[0] === 0x2001 && words[1] === 0x0db8)
        || (words[0] === 0x0100 && words.slice(1, 4).every((word) => word === 0))
        || (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010)
        || (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001)
        || (wellKnownNat64 && ipv4IsForbidden(embeddedIpv4))
}

function canonicalPublicHttpsUrl(input) {
    if (typeof input !== 'string' || !input || /[\r\n]/.test(input)) throw new Error('Plugin fetch destination rejected')
    let url
    try { url = new URL(input) } catch { throw new Error('Plugin fetch destination rejected') }
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname.includes('*')) {
        throw new Error('Plugin fetch destination rejected')
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/g, '')
    const specialUse = hostname === 'localhost' || hostname.endsWith('.localhost')
        || hostname === 'local' || hostname.endsWith('.local')
        || hostname === 'home.arpa' || hostname.endsWith('.home.arpa')
    const hostOwned = HOST_OWNED_NETWORK_HOSTS.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))
    if (!hostname || specialUse || hostOwned) throw new Error('Plugin fetch destination rejected')
    url.hostname = hostname
    if (net.isIP(hostname) && isForbiddenAddress(hostname)) throw new Error('Plugin fetch destination rejected')
    return url
}

function createPluginFetchAuthGate(authenticate) {
    if (typeof authenticate !== 'function') throw new TypeError('authenticate must be a function')
    return async function pluginFetchAuthGate(request, response, next) {
        let authorized = false
        try { authorized = await authenticate(request) } catch { authorized = false }
        if (!authorized) {
            response.status(401).send({ error: 'Unauthorized' })
            return
        }
        next()
    }
}

async function defaultResolveAddresses(hostname) {
    const answers = await dns.lookup(hostname, { all: true, verbatim: true })
    return answers.map((answer) => answer.address)
}

function defaultOpenConnection({ url, address, hostname, servername, method, headers, body, signal }) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Plugin fetch aborted'))
        const headerObject = Object.fromEntries(headers)
        const request = https.request({
            protocol: 'https:', hostname, servername, port: url.port ? Number(url.port) : 443,
            path: `${url.pathname}${url.search}`, method, headers: headerObject,
            lookup: (_host, options, callback) => {
                const family = net.isIP(address)
                if (options?.all) callback(null, [{ address, family }])
                else callback(null, address, family)
            },
        }, (incoming) => resolve({
            status: incoming.statusCode || 502,
            headers: Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [
                name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? ''),
            ])),
            body: incoming,
            cancel: () => incoming.destroy(),
        }))
        const abort = () => request.destroy(new Error('Plugin fetch aborted'))
        signal?.addEventListener('abort', abort, { once: true })
        request.once('close', () => signal?.removeEventListener('abort', abort))
        request.once('error', () => reject(signal?.aborted ? new Error('Plugin fetch aborted') : new Error('Plugin fetch network failure')))
        if (body && body.length) request.write(body)
        request.end()
    })
}

function normalizedHeaders(value) {
    if (!Array.isArray(value)) throw new Error('Plugin fetch headers rejected')
    return value.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
            throw new Error('Plugin fetch headers rejected')
        }
        const name = entry[0].toLowerCase()
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(entry[1])
            || FORBIDDEN_REQUEST_HEADERS.has(name) || name.startsWith('sec-')) {
            throw new Error('Plugin fetch headers rejected')
        }
        return [name, entry[1]]
    })
}

function normalizeAllowedOrigins(value) {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length === 0) throw new Error('Plugin fetch origin policy rejected')
    return value.map((origin) => {
        const url = canonicalPublicHttpsUrl(origin)
        if (url.pathname !== '/' || url.search || url.hash || url.origin !== origin) throw new Error('Plugin fetch origin policy rejected')
        return origin
    })
}

async function securePolicyFetch(request, dependencies = {}) {
    const resolveAddresses = dependencies.resolveAddresses || defaultResolveAddresses
    const openConnection = dependencies.openConnection || defaultOpenConnection
    const allowedOrigins = normalizeAllowedOrigins(request.allowedOrigins)
    const secretHeaderNames = new Set(Array.isArray(request.secretHeaderNames) ? request.secretHeaderNames.map((name) => String(name).toLowerCase()) : [])
    const maximumRedirects = Number(request.maxRedirects)
    const maximumResponse = Number(request.maxResponseBytes)
    if (!Number.isInteger(maximumRedirects) || maximumRedirects < 0 || maximumRedirects > 5) throw new Error('Plugin fetch redirect policy rejected')
    if (!Number.isInteger(maximumResponse) || maximumResponse < 0 || maximumResponse > 64 * 1024 * 1024) throw new Error('Plugin fetch response policy rejected')
    let current = canonicalPublicHttpsUrl(request.url)
    let method = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET'
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].includes(method)) throw new Error('Plugin fetch method rejected')
    let headers = normalizedHeaders(request.headers || [])
    let body = request.body === undefined
        ? undefined
        : Buffer.isBuffer(request.body) ? Buffer.from(request.body)
        : request.body instanceof Uint8Array ? Buffer.from(request.body)
        : typeof request.body === 'string' ? Buffer.from(request.body, 'utf8')
        : (() => { throw new Error('Plugin fetch body rejected') })()
    let redirectCount = 0

    while (true) {
        if (request.signal?.aborted) throw new Error('Plugin fetch aborted')
        if (allowedOrigins && !allowedOrigins.includes(current.origin)) throw new Error('Plugin fetch redirect origin rejected')
        const hostname = current.hostname.replace(/^\[|\]$/g, '')
        let addresses
        try { addresses = await resolveAddresses(hostname) } catch { throw new Error('Plugin fetch destination resolution failed') }
        if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(isForbiddenAddress)) {
            throw new Error('Plugin fetch destination rejected')
        }
        const connection = await openConnection({
            url: current, address: addresses[0], hostname, servername: hostname,
            method, headers: headers.map(([name, value]) => [name, value]), body, signal: request.signal,
        })
        const responseHeaders = Object.fromEntries(Object.entries(connection.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]))
        if (REDIRECTS.has(connection.status)) {
            connection.cancel?.()
            const location = responseHeaders.location
            if (!location) throw new Error('Plugin fetch redirect omitted Location')
            if (redirectCount >= maximumRedirects) throw new Error('Plugin fetch redirect limit exceeded')
            let next
            try { next = canonicalPublicHttpsUrl(new URL(location, current).toString()) } catch { throw new Error('Plugin fetch redirect destination rejected') }
            if (allowedOrigins && !allowedOrigins.includes(next.origin)) throw new Error('Plugin fetch redirect origin rejected')
            if (next.origin !== current.origin) {
                headers = headers.filter(([name]) => !CREDENTIAL_HEADERS.has(name) || secretHeaderNames.has(name))
            }
            if (connection.status === 303 || ((connection.status === 301 || connection.status === 302) && method === 'POST')) {
                method = 'GET'
                body = undefined
                headers = headers.filter(([name]) => name !== 'content-type' && name !== 'content-length')
            }
            current = next
            redirectCount++
            continue
        }

        const declared = responseHeaders['content-length']
        if (declared && /^\d+$/.test(declared) && Number(declared) > maximumResponse) {
            connection.cancel?.()
            throw new Error('Plugin fetch response limit exceeded')
        }
        const chunks = []
        let total = 0
        try {
            for await (const chunk of connection.body || []) {
                if (request.signal?.aborted) throw new Error('Plugin fetch aborted')
                const bytes = Buffer.from(chunk)
                total += bytes.length
                if (total > maximumResponse) throw new Error('Plugin fetch response limit exceeded')
                chunks.push(bytes)
            }
        } catch (error) {
            connection.cancel?.()
            if (request.signal?.aborted) throw new Error('Plugin fetch aborted')
            if (String(error?.message || error).includes('response limit')) throw error
            throw new Error('Plugin fetch response failed')
        }
        return { status: connection.status, headers: responseHeaders, body: Buffer.concat(chunks, total) }
    }
}

module.exports = {
    canonicalPublicHttpsUrl,
    createPluginFetchAuthGate,
    isForbiddenAddress,
    securePolicyFetch,
}
