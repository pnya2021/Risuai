import type { RegisteredModelArtifact } from "./pixaiRegistry"

const XET_HOST = "us.aws.cdn.hf.co"
const XET_PATH_PREFIX = "/xet-bridge-us/"
const HOST_CACHE_PREFIX = "/api/resolve-cache/"
const XET_QUERY_KEYS = new Set([
    "Expires",
    "Key-Pair-Id",
    "Policy",
    "Signature",
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-Security-Token",
    "X-Amz-Signature",
    "X-Amz-SignedHeaders",
    "X-Xet-Cas-Uid",
    "response-content-disposition",
    "response-content-type",
    "x-id",
])

function rawAuthority(value: string): string {
    const match = /^https:\/\/([^/?#]+)/.exec(value)
    if (!match) throw new Error("Artifact URL must use canonical HTTPS")
    return match[1]
}

function hasExplicitPort(value: string): boolean {
    const authority = rawAuthority(value).replace(/^.*@/, "")
    if (authority.startsWith("[")) return /\]:\d+$/.test(authority)
    return /:\d+$/.test(authority)
}

function hasTraversal(value: string): boolean {
    const pathname = value.slice(value.indexOf("/", "https://".length + 1)).split(/[?#]/, 1)[0]
    if (pathname.includes("\\") || /%5c/i.test(pathname)) return true
    return pathname.split("/").some((segment) => {
        let decoded = segment
        try {
            decoded = decodeURIComponent(decoded)
            decoded = decodeURIComponent(decoded)
        } catch {
            return true
        }
        return decoded === "." || decoded === ".."
    })
}

function parseCanonicalHttps(value: string, allowPort: boolean): URL {
    if (hasTraversal(value)) throw new Error("Artifact URL path traversal rejected")
    const parsed = new URL(value)
    if (parsed.protocol !== "https:") throw new Error("Artifact URL must use HTTPS")
    if (parsed.username || parsed.password) {
        throw new Error("Artifact URL credentials are forbidden")
    }
    if (parsed.hash) throw new Error("Artifact URL fragments are forbidden")
    if (!allowPort && hasExplicitPort(value)) {
        throw new Error("Artifact URL port is not approved")
    }
    if (parsed.href !== value) throw new Error("Artifact URL is not canonical")
    return parsed
}

export function assertRegisteredArtifactInitialUrl(
    artifact: Readonly<RegisteredModelArtifact>,
    value: string,
): string {
    if (value !== artifact.url) {
        throw new Error("Artifact URL does not match its immutable registration")
    }
    const parsed = parseCanonicalHttps(value, false)
    if (parsed.search) throw new Error("Initial artifact URL query is forbidden")
    return parsed.href
}

function parseHostOrigin(value: string): URL {
    const origin = parseCanonicalHttps(
        value.endsWith("/") ? value : `${value}/`,
        true,
    )
    if (
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        origin.href !== `${origin.origin}/`
    ) {
        throw new Error("Current Host origin must be a canonical origin")
    }
    return origin
}

function assertXetQuery(parsed: URL): void {
    const seen = new Set<string>()
    for (const [key, value] of parsed.searchParams) {
        if (!XET_QUERY_KEYS.has(key) || seen.has(key) || value.length === 0) {
            throw new Error("Artifact redirect query is not approved")
        }
        seen.add(key)
    }
}

export function resolveRegisteredArtifactRedirect(input: {
    artifact: Readonly<RegisteredModelArtifact>
    currentUrl: string
    location: string
    currentHostOrigin?: string
    redirectsFollowed: number
}): string {
    if (input.redirectsFollowed >= 1) {
        throw new Error("Registered artifact redirect limit exceeded")
    }
    assertRegisteredArtifactInitialUrl(input.artifact, input.currentUrl)
    const target = parseCanonicalHttps(input.location, false)

    if (input.currentHostOrigin !== undefined) {
        const host = parseHostOrigin(input.currentHostOrigin)
        if (target.origin === host.origin) {
            if (
                !target.pathname.startsWith(HOST_CACHE_PREFIX) ||
                target.pathname.length === HOST_CACHE_PREFIX.length ||
                target.search
            ) {
                throw new Error("Host artifact redirect shape is not approved")
            }
            return target.href
        }
    }

    if (
        target.hostname !== XET_HOST ||
        target.port !== "" ||
        !target.pathname.startsWith(XET_PATH_PREFIX) ||
        target.pathname.length === XET_PATH_PREFIX.length
    ) {
        throw new Error("Artifact redirect target is not approved")
    }
    assertXetQuery(target)
    return target.href
}
