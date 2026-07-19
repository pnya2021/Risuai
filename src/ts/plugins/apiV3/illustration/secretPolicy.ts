import { CAPABILITY_CONTRACT } from './capabilityContract'
import { PluginApiError } from './errors'
import { utf8ByteLength } from './limits'

export type PluginSecretUsePolicy =
    | { kind: 'header'; name: string; prefix?: string }
    | { kind: 'json-body'; pointer: string; prefix?: string }

export interface PluginSecretPolicy {
    allowedOrigins: string[]
    uses: PluginSecretUsePolicy[]
}

export type CanonicalPluginSecretPolicy = PluginSecretPolicy

const CONTRACT_LIMITS = CAPABILITY_CONTRACT['secrets.write-only.v1'].limits
const LIMITS = {
    maxJsonPointerUtf8Bytes: Number(CONTRACT_LIMITS.maxJsonPointerUtf8Bytes),
    maxSecretPrefixUtf8Bytes: Number(CONTRACT_LIMITS.maxSecretPrefixUtf8Bytes),
    maxSecretIdUtf8Bytes: Number(CONTRACT_LIMITS.maxSecretIdUtf8Bytes),
    maxSecretValueBytes: Number(CONTRACT_LIMITS.maxSecretValueBytes),
    maxSecretOrigins: Number(CONTRACT_LIMITS.maxSecretOrigins),
    maxSecretUses: Number(CONTRACT_LIMITS.maxSecretUses),
}
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FORBIDDEN_HEADER_NAMES = new Set([
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie',
    'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
    'permissions-policy', 'proxy-authorization', 'referer', 'set-cookie', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'via', 'proxy-connection',
])

const invalid = (message: string, key: string): never => {
    throw new PluginApiError('INVALID_ARGUMENT', message, { details: { key } })
}

const ownValue = (object: object, key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (!descriptor || !('value' in descriptor)) invalid('Secret policy must contain plain data properties', String(key))
    return descriptor.value
}

const optionalOwnValue = (object: object, key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (!descriptor) return undefined
    if (!('value' in descriptor)) invalid('Secret policy must contain plain data properties', String(key))
    return descriptor.value
}

const assertPlainRecord = (value: unknown, key: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${key}`, key)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid(`Invalid ${key}`, key)
    return value as Record<string, unknown>
}

const parseIpv4 = (hostname: string): number[] | null => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null
    const octets = hostname.split('.').map(Number)
    return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
        ? octets
        : null
}

const ipv4IsForbidden = ([a, b, c]: number[]) =>
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (
        b === 0 || b === 168 || (b === 88 && c === 99)
    ))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224

const isSpecialUseHostname = (hostname: string) =>
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === 'local'
    || hostname.endsWith('.local')
    || hostname === 'home.arpa'
    || hostname.endsWith('.home.arpa')

const parseIpv6 = (hostname: string): number[] | null => {
    let source = hostname
    if (source.startsWith('[') && source.endsWith(']')) source = source.slice(1, -1)
    const zone = source.indexOf('%')
    if (zone >= 0) return null
    if (!source.includes(':')) return null
    const halves = source.split('::')
    if (halves.length > 2) return null
    const parseSide = (side: string) => side === '' ? [] : side.split(':').map((part) => {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return Number.NaN
        return Number.parseInt(part, 16)
    })
    const left = parseSide(halves[0])
    const right = parseSide(halves[1] ?? '')
    if ([...left, ...right].some(Number.isNaN)) return null
    const missing = 8 - left.length - right.length
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null
    return [...left, ...Array(missing).fill(0), ...right]
}

const ipv6IsForbidden = (words: number[]) => {
    const allZero = words.every((word) => word === 0)
    const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1
    const ipv4Compatible = words.slice(0, 6).every((word) => word === 0)
    const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
    const uniqueLocal = (words[0] & 0xfe00) === 0xfc00
    const linkLocal = (words[0] & 0xffc0) === 0xfe80
    const siteLocal = (words[0] & 0xffc0) === 0xfec0
    const multicast = (words[0] & 0xff00) === 0xff00
    const documentation = words[0] === 0x2001 && words[1] === 0x0db8
    const discardOnly = words[0] === 0x0100 && words.slice(1, 4).every((word) => word === 0)
    const orchid = words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010
    const localNat64 = words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001
    const wellKnownNat64 = words[0] === 0x0064 && words[1] === 0xff9b
        && words.slice(2, 6).every((word) => word === 0)
    const embeddedIpv4 = [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff]
    return allZero || loopback || ipv4Compatible || mapped || uniqueLocal || linkLocal || siteLocal
        || multicast || documentation || discardOnly || orchid || localNat64
        || (wellKnownNat64 && ipv4IsForbidden(embeddedIpv4))
}

export function isForbiddenNumericHost(hostname: string) {
    const ipv4 = parseIpv4(hostname)
    if (ipv4) return ipv4IsForbidden(ipv4)
    const ipv6 = parseIpv6(hostname)
    return ipv6 ? ipv6IsForbidden(ipv6) : false
}

export function canonicalizeHttpsOrigin(input: unknown): string {
    if (typeof input !== 'string' || input.length === 0 || /[\r\n]/.test(input)) {
        invalid('Secret origins must be non-empty HTTPS origins', 'allowedOrigins')
    }
    const url = validatePublicHttpsUrl(input, 'allowedOrigins')
    if (
        url.pathname !== '/'
        || url.search !== ''
        || url.hash !== ''
    ) invalid('Secret origins must be exact HTTPS origins', 'allowedOrigins')
    return url.origin
}

export function validatePublicHttpsUrl(input: unknown, key = 'url'): URL {
    if (typeof input !== 'string' || input.length === 0 || /[\r\n]/.test(input)) {
        invalid('Request URL must be HTTPS', key)
    }
    const text = input as string
    let url: URL
    try { url = new URL(text) } catch { return invalid('Invalid request URL', key) }
    if (
        url.protocol !== 'https:'
        || url.username !== ''
        || url.password !== ''
        || url.hostname.includes('*')
    ) invalid('Request URL must be public HTTPS without credentials', key)
    const hostname = url.hostname.replace(/\.+$/u, '')
    if (hostname.length === 0) invalid('Private or reserved request destinations are not allowed', key)
    url.hostname = hostname
    if (isSpecialUseHostname(hostname) || isForbiddenNumericHost(hostname)) {
        invalid('Private or reserved request destinations are not allowed', key)
    }
    return url
}

export function canonicalizeHeaderName(input: unknown): string {
    if (typeof input !== 'string' || !HEADER_TOKEN.test(input) || /[\r\n]/.test(input)) {
        invalid('Invalid Secret header name', 'uses.name')
    }
    const name = (input as string).toLowerCase()
    if (FORBIDDEN_HEADER_NAMES.has(name) || name.startsWith('sec-')) {
        invalid('Forbidden Secret header name', 'uses.name')
    }
    return name
}

export function assertCanonicalJsonPointer(input: unknown): string {
    if (typeof input !== 'string' || utf8ByteLength(input) > LIMITS.maxJsonPointerUtf8Bytes) {
        invalid('Invalid Secret JSON pointer', 'uses.pointer')
    }
    const pointer = input as string
    if (pointer !== '' && !pointer.startsWith('/')) invalid('Invalid Secret JSON pointer', 'uses.pointer')
    if (/~(?![01])/u.test(pointer) || /[\u0000-\u001f\u007f]/u.test(pointer)) {
        invalid('Invalid Secret JSON pointer', 'uses.pointer')
    }
    return pointer
}

const canonicalPrefix = (input: unknown): string | undefined => {
    if (input === undefined) return undefined
    if (
        typeof input !== 'string'
        || /[\r\n]/.test(input)
        || utf8ByteLength(input) > LIMITS.maxSecretPrefixUtf8Bytes
    ) invalid('Invalid Secret prefix', 'uses.prefix')
    return input as string
}

export function assertPluginSecretId(input: unknown): asserts input is string {
    if (
        typeof input !== 'string'
        || input.length === 0
        || utf8ByteLength(input) > LIMITS.maxSecretIdUtf8Bytes
        || /[\u0000-\u001f\u007f]/u.test(input)
    ) invalid('Invalid Secret ID', 'id')
}

export function assertPluginSecretValue(input: unknown): asserts input is string {
    if (
        typeof input !== 'string'
        || utf8ByteLength(input) > LIMITS.maxSecretValueBytes
        || /[\r\n]/.test(input)
    ) invalid('Invalid Secret value', 'value')
}

export function canonicalizePluginSecretPolicy(input: unknown): CanonicalPluginSecretPolicy {
    const policy = assertPlainRecord(input, 'policy')
    const allowedOrigins = ownValue(policy, 'allowedOrigins')
    const uses = ownValue(policy, 'uses')
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length < 1 || allowedOrigins.length > LIMITS.maxSecretOrigins) {
        invalid('Secret policy requires one or more allowed origins', 'allowedOrigins')
    }
    if (!Array.isArray(uses) || uses.length < 1 || uses.length > LIMITS.maxSecretUses) {
        invalid('Secret policy requires one or more uses', 'uses')
    }

    const canonicalOrigins = (allowedOrigins as unknown[]).map(canonicalizeHttpsOrigin)
    if (new Set(canonicalOrigins).size !== canonicalOrigins.length) invalid('Duplicate Secret origin', 'allowedOrigins')

    const canonicalUses = (uses as unknown[]).map((candidate, index): PluginSecretUsePolicy => {
        const use = assertPlainRecord(candidate, `uses.${index}`)
        const kind = ownValue(use, 'kind')
        const prefix = canonicalPrefix(optionalOwnValue(use, 'prefix'))
        if (kind === 'header') {
            return { kind, name: canonicalizeHeaderName(ownValue(use, 'name')), ...(prefix === undefined ? {} : { prefix }) }
        }
        if (kind === 'json-body') {
            return { kind, pointer: assertCanonicalJsonPointer(ownValue(use, 'pointer')), ...(prefix === undefined ? {} : { prefix }) }
        }
        return invalid('Invalid Secret use kind', 'uses.kind')
    })
    const useKeys = canonicalUses.map((use) => use.kind === 'header'
        ? `header:${use.name}`
        : `json-body:${use.pointer}`)
    if (new Set(useKeys).size !== useKeys.length) invalid('Duplicate Secret use', 'uses')
    return { allowedOrigins: canonicalOrigins, uses: canonicalUses }
}

export const secretPolicyDigestInput = (policy: CanonicalPluginSecretPolicy) => JSON.stringify([
    [...policy.allowedOrigins].sort(),
    [...policy.uses].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
])
