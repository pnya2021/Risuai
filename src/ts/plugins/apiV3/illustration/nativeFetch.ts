import { CAPABILITY_CONTRACT } from './capabilityContract'
import { pluginDataLifecycle, type PluginDataLifecycleRegistry } from '../../pluginDataLifecycle'
import { PluginApiError } from './errors'
import type { PluginSecretService } from './pluginSecretStore'
import { canonicalizeHeaderName, validatePublicHttpsUrl } from './secretPolicy'

export interface PluginSecretRef { pluginSecret: string }
export type PluginNativeFetchHeaderValue = string | PluginSecretRef
export type PluginNativeFetchHeaders = Record<string, PluginNativeFetchHeaderValue> | Array<[string, PluginNativeFetchHeaderValue]>
export type PluginNativeFetchJsonValue = null | boolean | number | string | PluginSecretRef
    | PluginNativeFetchJsonValue[] | { [key: string]: PluginNativeFetchJsonValue }
export type PluginNativeFetchInit = {
    method?: string
    headers?: HeadersInit | PluginNativeFetchHeaders
    body?: BodyInit
    jsonBody?: PluginNativeFetchJsonValue
    signal?: AbortSignal
    credentials?: 'omit'
    referrer?: ''
    referrerPolicy?: 'no-referrer'
    keepalive?: false
    mode?: 'cors'
    redirect?: 'manual'
    cache?: 'no-store'
}

export interface NativeFetchLimits {
    maxBodyBytes: number
    maxJsonBodyBytes: number
    maxAggregateBytes: number
    maxResponseBytes: number
    maxResponseHeaderBytes: number
    maxJsonDepth: number
}

const CONTRACT_LIMITS = CAPABILITY_CONTRACT['secrets.write-only.v1'].limits
export const DEFAULT_NATIVE_FETCH_LIMITS: NativeFetchLimits = {
    maxBodyBytes: Number(CONTRACT_LIMITS.maxNativeFetchBodyBytes),
    maxJsonBodyBytes: Number(CONTRACT_LIMITS.maxJsonBodyBytes),
    maxAggregateBytes: Number(CONTRACT_LIMITS.maxRpcAggregateBytes),
    maxResponseBytes: Number(CONTRACT_LIMITS.maxNativeFetchResponseBytes),
    maxResponseHeaderBytes: 128 * 1024,
    maxJsonDepth: Number(CONTRACT_LIMITS.maxJsonDepth),
}

type NormalizedHeaders = Array<[string, PluginNativeFetchHeaderValue]>
export interface NormalizedPluginNativeFetch {
    url: string
    method: string
    headers: NormalizedHeaders
    body?: string | Uint8Array
    jsonBody?: PluginNativeFetchJsonValue
    signal?: AbortSignal
    requestInit: Omit<RequestInit, 'headers' | 'body' | 'signal' | 'redirect'>
}

export interface PolicyTransportRequest {
    url: string
    method: string
    headers: Array<[string, string]>
    body?: string | Uint8Array
    signal?: AbortSignal
    requestInit?: Omit<RequestInit, 'headers' | 'body' | 'signal' | 'redirect' | 'method'>
    allowedOrigins?: string[]
    secretHeaderNames?: string[]
    maxRedirects: number
    maxResponseBytes?: number
}

export interface PolicyTransport { request(request: PolicyTransportRequest): Promise<Response> }

const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength
const HOST_OWNED_NETWORK_HOSTS = ['risuai.xyz', 'risuai.net', 'sionyw.com'] as const
const FORBIDDEN_NATIVE_HEADER_NAMES = new Set([
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie',
    'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
    'permissions-policy', 'proxy-authorization', 'proxy-connection', 'referer',
    'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
])
const NATIVE_FETCH_OPTION_KEYS = new Set([
    'method', 'headers', 'body', 'jsonBody', 'signal', 'credentials', 'referrer',
    'referrerPolicy', 'keepalive', 'mode', 'redirect', 'cache',
])
const SAFE_REQUEST_INIT_VALUES = {
    credentials: 'omit',
    referrer: '',
    referrerPolicy: 'no-referrer',
    keepalive: false,
    mode: 'cors',
    redirect: 'manual',
    cache: 'no-store',
} as const
const isHostOwnedNetworkHost = (hostname: string) => HOST_OWNED_NETWORK_HOSTS.some(
    (blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`),
)
const resourceLimit = (key: string, maximum: number): never => {
    throw new PluginApiError('RESOURCE_LIMIT', `${key} exceeds ${maximum} bytes`, { details: { key, maximum } })
}
const invalid = (message: string, key: string): never => {
    throw new PluginApiError('INVALID_ARGUMENT', message, { details: { key } })
}

const plainRecord = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const ownDataEntries = (value: object, key: string) => {
    const result: Array<[string, unknown]> = []
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue
        if (!('value' in descriptor)) invalid(`Accessors are not allowed in ${key}`, key)
        result.push([name, descriptor.value])
    }
    return result
}

const secretRefId = (value: unknown): string | null => {
    if (!plainRecord(value)) return null
    const entries = ownDataEntries(value as object, 'pluginSecret')
    if (entries.length !== 1 || entries[0][0] !== 'pluginSecret' || typeof entries[0][1] !== 'string') return null
    return entries[0][1]
}

const normalizeOrdinaryHeaderName = (input: unknown) => {
    if (typeof input !== 'string') return invalid('Invalid header name', 'headers')
    try {
        const headers = new Headers([[input, 'value']])
        const name = [...headers.keys()][0].toLowerCase()
        if (FORBIDDEN_NATIVE_HEADER_NAMES.has(name) || name.startsWith('sec-')) {
            return invalid('Forbidden request header name', 'headers')
        }
        return name
    } catch { return invalid('Invalid header name', 'headers') }
}

function normalizeHeaderValue(name: string, value: unknown): PluginNativeFetchHeaderValue {
    if (typeof value === 'string') {
        if (/\r|\n/.test(value)) invalid('Invalid header value', 'headers')
        return value
    }
    if (plainRecord(value) && ownDataEntries(value as object, 'headers').some(([key]) => key === 'secretHeader')) {
        invalid('Legacy secretHeader references are unsupported; use { pluginSecret: id }', 'headers')
    }
    const id = secretRefId(value)
    if (id !== null) {
        canonicalizeHeaderName(name)
        return { pluginSecret: id }
    }
    return invalid('Header values must be strings or exact pluginSecret references', 'headers')
}

function normalizeHeaders(input: PluginNativeFetchInit['headers']): NormalizedHeaders {
    if (input === undefined) return []
    if (input instanceof Headers) return [...input.entries()]
        .map(([name, value]) => [normalizeOrdinaryHeaderName(name), value] as [string, string])
        .sort(([left], [right]) => left.localeCompare(right))
    if (Array.isArray(input)) return input.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) invalid('Invalid header tuple', 'headers')
        const name = normalizeOrdinaryHeaderName(entry[0])
        return [name, normalizeHeaderValue(name, entry[1])] as [string, PluginNativeFetchHeaderValue]
    })
    if (!plainRecord(input)) invalid('Invalid headers object', 'headers')
    return ownDataEntries(input as object, 'headers').map(([rawName, value]) => {
        const name = normalizeOrdinaryHeaderName(rawName)
        return [name, normalizeHeaderValue(name, value)]
    })
}

const hasHeader = (headers: NormalizedHeaders, name: string) => headers.some(([candidate]) => candidate === name)

async function normalizeBody(body: BodyInit, headers: NormalizedHeaders, maximum: number): Promise<string | Uint8Array> {
    if (typeof body === 'string') {
        if (utf8Length(body) > maximum) resourceLimit('body', maximum)
        return body
    }
    if (body instanceof URLSearchParams) {
        const value = body.toString()
        if (utf8Length(value) > maximum) resourceLimit('body', maximum)
        if (!hasHeader(headers, 'content-type')) headers.push(['content-type', 'application/x-www-form-urlencoded;charset=UTF-8'])
        return value
    }
    if (body instanceof Blob) {
        if (body.size > maximum) resourceLimit('body', maximum)
        const value = new Uint8Array(await body.arrayBuffer())
        if (value.byteLength > maximum) resourceLimit('body', maximum)
        if (body.type && !hasHeader(headers, 'content-type')) headers.push(['content-type', body.type])
        return value
    }
    if (body instanceof FormData) {
        const request = new Request('https://multipart.invalid/', { method: 'POST', body })
        const contentType = request.headers.get('content-type')
        const contentLength = Number(request.headers.get('content-length') ?? 0)
        if (contentLength > maximum) resourceLimit('body', maximum)
        const value = new Uint8Array(await request.arrayBuffer())
        if (value.byteLength > maximum) resourceLimit('body', maximum)
        if (contentType && !hasHeader(headers, 'content-type')) headers.push(['content-type', contentType])
        return value
    }
    if (body instanceof ArrayBuffer) {
        if (body.byteLength > maximum) resourceLimit('body', maximum)
        return new Uint8Array(body.slice(0))
    }
    if (ArrayBuffer.isView(body) && body.buffer instanceof ArrayBuffer) {
        if (body.byteLength > maximum) resourceLimit('body', maximum)
        if (body instanceof Uint8Array && body.byteOffset === 0 && body.byteLength === body.buffer.byteLength) return body
        return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
    }
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
        invalid('ReadableStream bodies are not replayable and are unsupported', 'body')
    }
    return invalid('Unsupported request body type', 'body')
}

function cloneJsonValue(value: unknown, depth: number, maximumDepth: number, seen: Set<object>): PluginNativeFetchJsonValue {
    if (depth > maximumDepth) resourceLimit('jsonBody.depth', maximumDepth)
    if (value === null) return null
    if (typeof value === 'string') return value
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) invalid('jsonBody numbers must be finite', 'jsonBody')
        return value
    }
    if (!value || typeof value !== 'object') invalid('jsonBody must contain only JSON-safe values', 'jsonBody')
    const objectValue = value as object
    if (seen.has(objectValue)) invalid('jsonBody must not be cyclic', 'jsonBody')
    seen.add(objectValue)
    try {
        if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item, depth + 1, maximumDepth, seen))
        if (!plainRecord(value)) invalid('jsonBody must contain plain objects', 'jsonBody')
        const output: Record<string, PluginNativeFetchJsonValue> = Object.create(null)
        for (const [key, item] of ownDataEntries(objectValue, 'jsonBody')) {
            output[key] = cloneJsonValue(item, depth + 1, maximumDepth, seen)
        }
        return output
    } finally { seen.delete(objectValue) }
}

const bodyLength = (body: string | Uint8Array | undefined) => body === undefined
    ? 0
    : typeof body === 'string' ? utf8Length(body) : body.byteLength

export async function normalizePluginNativeFetch(
    urlInput: string,
    options: PluginNativeFetchInit = {},
    limitOverrides: Partial<NativeFetchLimits> = {},
): Promise<NormalizedPluginNativeFetch> {
    const limits = { ...DEFAULT_NATIVE_FETCH_LIMITS, ...limitOverrides }
    const parsedUrl = validatePublicHttpsUrl(urlInput)
    if (isHostOwnedNetworkHost(parsedUrl.hostname)) {
        throw new PluginApiError('PERMISSION_DENIED', 'Host-owned network destinations are unavailable to plugins')
    }
    const url = parsedUrl.toString()
    if (!plainRecord(options)) invalid('Invalid nativeFetch options', 'options')
    const descriptors = Object.getOwnPropertyDescriptors(options)
    const dataOptions: Record<string, unknown> = Object.create(null)
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue
        if (!('value' in descriptor)) invalid('nativeFetch options must be plain data', key)
        if (!NATIVE_FETCH_OPTION_KEYS.has(key)) invalid('Unsupported nativeFetch option', key)
        dataOptions[key] = descriptor.value
    }
    for (const symbol of Object.getOwnPropertySymbols(options)) {
        if (Object.getOwnPropertyDescriptor(options, symbol)?.enumerable) invalid('Unsupported nativeFetch option', String(symbol))
    }
    for (const [key, safeValue] of Object.entries(SAFE_REQUEST_INIT_VALUES)) {
        const value = dataOptions[key]
        if (value !== undefined && value !== safeValue) invalid(`Unsafe nativeFetch ${key}`, key)
    }
    const normalizedOptions = dataOptions as unknown as PluginNativeFetchInit
    const headers = normalizeHeaders(normalizedOptions.headers)
    if (normalizedOptions.body !== undefined && normalizedOptions.jsonBody !== undefined) {
        invalid('body and jsonBody are mutually exclusive', 'body')
    }
    const methodInput = normalizedOptions.method
        ?? (normalizedOptions.body !== undefined || normalizedOptions.jsonBody !== undefined ? 'POST' : 'GET')
    if (typeof methodInput !== 'string') invalid('Invalid request method', 'method')
    const method = methodInput.toUpperCase()
    if (!/^[A-Z]+$/.test(method)) invalid('Invalid request method', 'method')
    let body: string | Uint8Array | undefined
    if (normalizedOptions.body !== undefined) body = await normalizeBody(normalizedOptions.body, headers, limits.maxBodyBytes)
    let jsonBody: PluginNativeFetchJsonValue | undefined
    if (normalizedOptions.jsonBody !== undefined) {
        jsonBody = cloneJsonValue(normalizedOptions.jsonBody, 0, limits.maxJsonDepth, new Set())
        const serialized = JSON.stringify(jsonBody)
        if (utf8Length(serialized) > limits.maxJsonBodyBytes) resourceLimit('jsonBody', limits.maxJsonBodyBytes)
    }
    if ((method === 'GET' || method === 'HEAD') && (body !== undefined || jsonBody !== undefined)) {
        invalid(`${method} requests cannot contain a body`, 'body')
    }
    const headerBytes = headers.reduce((total, [name, value]) => total + utf8Length(name)
        + (typeof value === 'string' ? utf8Length(value) : utf8Length(value.pluginSecret)), 0)
    const jsonBytes = jsonBody === undefined ? 0 : utf8Length(JSON.stringify(jsonBody))
    if (utf8Length(url) + headerBytes + bodyLength(body) + jsonBytes > limits.maxAggregateBytes) {
        resourceLimit('nativeFetch.aggregate', limits.maxAggregateBytes)
    }
    const signal = normalizedOptions.signal
    return {
        url, method, headers,
        ...(body === undefined ? {} : { body }),
        ...(jsonBody === undefined ? {} : { jsonBody }),
        signal,
        requestInit: {},
    }
}

const escapePointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1')

export class PluginSecretFetchRateLimiter {
    private attempts = new Map<string, number[]>()
    private maximum: number
    private now: () => number
    constructor(options: { maximum?: number; now?: () => number } = {}) {
        this.maximum = options.maximum ?? Number(CONTRACT_LIMITS.secretFetchesPerMinute)
        this.now = options.now ?? Date.now
    }
    consume(principalId: string) {
        const now = this.now()
        const cutoff = now - 60_000
        const retained = (this.attempts.get(principalId) ?? []).filter((timestamp) => timestamp > cutoff)
        if (retained.length >= this.maximum) {
            this.attempts.set(principalId, retained)
            throw new PluginApiError('RESOURCE_LIMIT', 'Secret-bearing nativeFetch rate limit exceeded', {
                retryable: true,
                retryAfterMs: Math.max(1, retained[0] + 60_000 - now),
                details: { maximum: this.maximum },
            })
        }
        retained.push(now)
        this.attempts.set(principalId, retained)
    }
    clearPrincipal(principalId: string) { this.attempts.delete(principalId) }
}

export const pluginSecretFetchRateLimiter = new PluginSecretFetchRateLimiter()

export function registerPluginSecretFetchRateLimitLifecycle(
    limiter: PluginSecretFetchRateLimiter,
    lifecycle: PluginDataLifecycleRegistry = pluginDataLifecycle,
) {
    return lifecycle.register('secret-fetch-rate-limit', 'purge', ({ principalId }) => {
        limiter.clearPrincipal(principalId)
    })
}

registerPluginSecretFetchRateLimitLifecycle(pluginSecretFetchRateLimiter)

export class PluginNativeFetchService {
    private limits: NativeFetchLimits
    constructor(
        private secrets: PluginSecretService,
        private transport: PolicyTransport,
        limitOverrides: Partial<NativeFetchLimits> = {},
        private rateLimiter: PluginSecretFetchRateLimiter = pluginSecretFetchRateLimiter,
    ) { this.limits = { ...DEFAULT_NATIVE_FETCH_LIMITS, ...limitOverrides } }

    async fetch(url: string, options: PluginNativeFetchInit = {}) {
        const normalized = await normalizePluginNativeFetch(url, options, this.limits)
        const controller = new AbortController()
        const onAbort = () => controller.abort()
        const sourceSignals = [...new Set([normalized.signal, this.secrets.executionSignal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
        ))]
        let sourcesCleaned = false
        const cleanupSources = () => {
            if (sourcesCleaned) return
            sourcesCleaned = true
            for (const signal of sourceSignals) signal.removeEventListener('abort', onAbort)
        }
        for (const signal of sourceSignals) signal.addEventListener('abort', onAbort, { once: true })
        if (sourceSignals.some((signal) => signal.aborted)) onAbort()
        const assertActive = () => {
            if (controller.signal.aborted) throw new PluginApiError('ABORTED', 'Native request aborted')
        }
        try {
            assertActive()
            const origin = new URL(normalized.url).origin
            const resolvedHeaders: Array<[string, string]> = []
            const policies: Array<{ allowedOrigins: string[] }> = []
            const secretHeaderNames = new Set<string>()

            for (const [name, value] of normalized.headers) {
                assertActive()
                if (typeof value === 'string') {
                    resolvedHeaders.push([name, value])
                    continue
                }
                const record = await this.secrets.resolveForRequest(value.pluginSecret)
                assertActive()
                const use = record.policy.uses.find((candidate) => candidate.kind === 'header' && candidate.name === name)
                if (!record.policy.allowedOrigins.includes(origin) || !use || use.kind !== 'header') {
                    throw new PluginApiError('PERMISSION_DENIED', `Secret ${value.pluginSecret} is not allowed in header ${name}`, {
                        details: { secretId: value.pluginSecret, placement: `header:${name}` },
                    })
                }
                resolvedHeaders.push([name, `${use.prefix ?? ''}${record.value}`])
                policies.push(record.policy)
                secretHeaderNames.add(name)
            }

            const resolveJson = async (value: PluginNativeFetchJsonValue, pointer: string): Promise<PluginNativeFetchJsonValue> => {
                assertActive()
                const id = secretRefId(value)
                if (id !== null) {
                    const record = await this.secrets.resolveForRequest(id)
                    assertActive()
                    const use = record.policy.uses.find((candidate) => candidate.kind === 'json-body' && candidate.pointer === pointer)
                    if (!record.policy.allowedOrigins.includes(origin) || !use || use.kind !== 'json-body') {
                        throw new PluginApiError('PERMISSION_DENIED', `Secret ${id} is not allowed at JSON pointer ${pointer}`, {
                            details: { secretId: id, placement: `json-body:${pointer}` },
                        })
                    }
                    policies.push(record.policy)
                    return `${use.prefix ?? ''}${record.value}`
                }
                if (Array.isArray(value)) return Promise.all(value.map((item, index) => resolveJson(item, `${pointer}/${index}`)))
                if (value && typeof value === 'object') {
                    const output: Record<string, PluginNativeFetchJsonValue> = Object.create(null)
                    for (const [key, item] of ownDataEntries(value, 'jsonBody')) {
                        output[key] = await resolveJson(item as PluginNativeFetchJsonValue, `${pointer}/${escapePointer(key)}`)
                        assertActive()
                    }
                    return output
                }
                return value
            }

            let body = normalized.body
            if (normalized.jsonBody !== undefined) {
                const resolved = await resolveJson(normalized.jsonBody, '')
                assertActive()
                body = JSON.stringify(resolved)
                if (utf8Length(body) > this.limits.maxJsonBodyBytes) resourceLimit('jsonBody', this.limits.maxJsonBodyBytes)
                if (!resolvedHeaders.some(([name]) => name === 'content-type')) resolvedHeaders.push(['content-type', 'application/json'])
            }
            const aggregate = utf8Length(normalized.url)
                + resolvedHeaders.reduce((total, [name, value]) => total + utf8Length(name) + utf8Length(value), 0)
                + bodyLength(body)
            if (aggregate > this.limits.maxAggregateBytes) resourceLimit('nativeFetch.aggregate', this.limits.maxAggregateBytes)

            let allowedOrigins: string[] | undefined
            if (policies.length) {
                allowedOrigins = policies.slice(1).reduce(
                    (common, policy) => common.filter((candidate) => policy.allowedOrigins.includes(candidate)),
                    [...policies[0].allowedOrigins],
                )
                if (!allowedOrigins.includes(origin)) throw new PluginApiError('PERMISSION_DENIED', 'Secret origin policy mismatch')
                this.rateLimiter.consume(this.secrets.principalId)
            }
            assertActive()
            let response: Response
            try {
                response = await this.transport.request({
                    url: normalized.url,
                    method: normalized.method,
                    headers: resolvedHeaders,
                    ...(body === undefined ? {} : { body }),
                    signal: controller.signal,
                    requestInit: normalized.requestInit,
                    allowedOrigins,
                    secretHeaderNames: [...secretHeaderNames],
                    maxRedirects: Number(CONTRACT_LIMITS.maxSecretRedirects),
                    maxResponseBytes: this.limits.maxResponseBytes,
                })
            } catch (error) {
                if (controller.signal.aborted) throw new PluginApiError('ABORTED', 'Native request aborted')
                if (error instanceof PluginApiError && ['PERMISSION_DENIED', 'RESOURCE_LIMIT', 'INVALID_ARGUMENT'].includes(error.code)) throw error
                throw new PluginApiError('NETWORK', 'Native request failed', { retryable: true })
            }
            assertActive()
            return this.boundedResponse(response, controller, cleanupSources)
        } catch (error) {
            cleanupSources()
            throw error
        }
    }

    private boundedResponse(response: Response, controller: AbortController, cleanupSources: () => void) {
        const headerBytes = [...response.headers.entries()].reduce(
            (total, [name, value]) => total + utf8Length(name) + utf8Length(value), 0,
        )
        if (headerBytes > this.limits.maxResponseHeaderBytes) {
            controller.abort()
            void response.body?.cancel().catch(() => undefined)
            cleanupSources()
            resourceLimit('response.headers', this.limits.maxResponseHeaderBytes)
        }
        const declared = response.headers.get('content-length')
        if (declared && /^\d+$/.test(declared) && Number(declared) > this.limits.maxResponseBytes) {
            controller.abort()
            void response.body?.cancel().catch(() => undefined)
            cleanupSources()
            resourceLimit('response', this.limits.maxResponseBytes)
        }
        if (!response.body) {
            cleanupSources()
            return response
        }
        const reader = response.body.getReader()
        let total = 0
        let closed = false
        const cleanup = () => {
            if (closed) return
            closed = true
            controller.signal.removeEventListener('abort', abortReader)
            cleanupSources()
        }
        const abortReader = () => {
            void reader.cancel().catch(() => undefined)
            cleanup()
        }
        controller.signal.addEventListener('abort', abortReader, { once: true })
        if (controller.signal.aborted) {
            abortReader()
            throw new PluginApiError('ABORTED', 'Native request aborted')
        }
        const body = new ReadableStream<Uint8Array>({
            pull: async (streamController) => {
                if (controller.signal.aborted) {
                    await reader.cancel().catch(() => undefined)
                    cleanup()
                    streamController.error(new PluginApiError('ABORTED', 'Native request aborted'))
                    return
                }
                try {
                    const result = await reader.read()
                    if (controller.signal.aborted) {
                        await reader.cancel().catch(() => undefined)
                        cleanup()
                        streamController.error(new PluginApiError('ABORTED', 'Native request aborted'))
                        return
                    }
                    if (result.done) {
                        cleanup()
                        streamController.close()
                        return
                    }
                    total += result.value.byteLength
                    if (total > this.limits.maxResponseBytes) {
                        controller.abort()
                        await reader.cancel().catch(() => undefined)
                        cleanup()
                        streamController.error(new PluginApiError('RESOURCE_LIMIT', 'Native response exceeds byte limit'))
                        return
                    }
                    streamController.enqueue(result.value)
                } catch {
                    cleanup()
                    streamController.error(controller.signal.aborted
                        ? new PluginApiError('ABORTED', 'Native request aborted')
                        : new PluginApiError('NETWORK', 'Native response stream failed', { retryable: true }))
                }
            },
            cancel: async () => {
                controller.abort()
                await reader.cancel().catch(() => undefined)
                cleanup()
            },
        })
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key'])

export function createWebPolicyTransport(fetchImplementation: typeof fetch = fetch): PolicyTransport {
    return { request: async (request) => {
        let current = request.url
        let method = request.method
        let body = request.body
        let headers = request.headers.map(([name, value]) => [name, value] as [string, string])
        let redirects = 0
        while (true) {
            let currentUrl: URL
            try { currentUrl = validatePublicHttpsUrl(current) } catch {
                throw new PluginApiError('NETWORK', 'Redirect destination was rejected')
            }
            if (request.allowedOrigins && !request.allowedOrigins.includes(currentUrl.origin)) {
                throw new PluginApiError('PERMISSION_DENIED', 'Redirect origin is outside the Secret policy')
            }
            let response: Response
            try {
                response = await fetchImplementation(currentUrl.toString(), {
                    method,
                    headers,
                    body: body as BodyInit | undefined,
                    signal: request.signal,
                    credentials: 'omit',
                    referrer: '',
                    referrerPolicy: 'no-referrer',
                    keepalive: false,
                    mode: 'cors',
                    cache: 'no-store',
                    redirect: 'manual',
                })
            } catch {
                if (request.signal?.aborted) throw new PluginApiError('ABORTED', 'Native request aborted')
                throw new PluginApiError('NETWORK', 'Native request failed', { retryable: true })
            }
            if (response.type === 'opaqueredirect') {
                await response.body?.cancel().catch(() => undefined)
                throw new PluginApiError('NETWORK', 'Opaque redirects are not allowed')
            }
            if (!REDIRECT_STATUSES.has(response.status)) return response
            const location = response.headers.get('location')
            await response.body?.cancel().catch(() => undefined)
            if (!location) throw new PluginApiError('NETWORK', 'Redirect response omitted Location')
            if (redirects >= request.maxRedirects) throw new PluginApiError('NETWORK', 'Native request exceeded redirect limit')
            let next: URL
            try { next = validatePublicHttpsUrl(new URL(location, currentUrl).toString()) } catch {
                throw new PluginApiError('NETWORK', 'Redirect destination was rejected')
            }
            if (request.allowedOrigins && !request.allowedOrigins.includes(next.origin)) {
                throw new PluginApiError('PERMISSION_DENIED', 'Redirect origin is outside the Secret policy')
            }
            if (next.origin !== currentUrl.origin) {
                headers = headers.filter(([name]) => !CREDENTIAL_HEADERS.has(name) || request.secretHeaderNames?.includes(name))
            }
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
                method = 'GET'
                body = undefined
                headers = headers.filter(([name]) => name !== 'content-type' && name !== 'content-length')
            }
            current = next.toString()
            redirects++
        }
    } }
}
