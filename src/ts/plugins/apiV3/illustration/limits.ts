import { PluginApiError } from './errors'

export const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength

export function assertLimit(value: number, maximum: number, key = 'value') {
    if (!Number.isFinite(value) || value < 0 || value > maximum) {
        throw new PluginApiError('RESOURCE_LIMIT', `RESOURCE_LIMIT: ${key} exceeds ${maximum}`, {
            details: { key, maximum },
        })
    }
}

export function assertUtf8Limit(value: string, maximum: number, key = 'value') {
    assertLimit(utf8ByteLength(value), maximum, key)
}
