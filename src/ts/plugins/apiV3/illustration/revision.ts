import { PluginApiError } from './errors'

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')

const invalidJson = (message: string): never => {
    throw new PluginApiError('INVALID_ARGUMENT', `INVALID_ARGUMENT: ${message}`)
}

const objectKeys = (value: object) => {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalidJson('non-plain JSON object')
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) invalidJson('symbol JSON key')
    for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidJson('non-data JSON property')
    }
    return keys as string[]
}

const assertDenseArray = (value: unknown[]) => {
    const ownKeys = Reflect.ownKeys(value)
    if (Object.getPrototypeOf(value) !== Array.prototype || ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
        invalidJson('sparse or extended JSON array')
    }
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidJson('sparse or accessor JSON array')
    }
}

const jsonChildren = (value: object): unknown[] => {
    if (Array.isArray(value)) {
        assertDenseArray(value)
        const children: unknown[] = []
        for (let index = 0; index < value.length; index++) {
            children.push(Object.getOwnPropertyDescriptor(value, String(index))!.value)
        }
        return children
    }
    return objectKeys(value).map((key) => Object.getOwnPropertyDescriptor(value, key)!.value)
}

type CanonicalFrame =
    | { kind: 'value'; value: unknown }
    | { kind: 'text'; value: string }
    | { kind: 'exit'; value: object; closing: ']' | '}' }

export const canonicalJson = (value: unknown) => {
    const output: string[] = []
    const active = new Set<object>()
    const stack: CanonicalFrame[] = [{ kind: 'value', value }]

    while (stack.length > 0) {
        const frame = stack.pop()!
        if (frame.kind === 'text') {
            output.push(frame.value)
            continue
        }
        if (frame.kind === 'exit') {
            active.delete(frame.value)
            output.push(frame.closing)
            continue
        }

        const current = frame.value
        if (current === null) {
            output.push('null')
            continue
        }
        if (typeof current === 'string' || typeof current === 'boolean') {
            output.push(JSON.stringify(current))
            continue
        }
        if (typeof current === 'number') {
            if (!Number.isFinite(current)) invalidJson('non-finite JSON number')
            output.push(Object.is(current, -0) ? '0' : JSON.stringify(current))
            continue
        }
        if (typeof current !== 'object' || current === null) invalidJson('non-JSON value')
        const objectValue = current as object
        if (active.has(objectValue)) invalidJson('cyclic JSON value')
        active.add(objectValue)

        if (Array.isArray(current)) {
            const children = jsonChildren(current)
            output.push('[')
            stack.push({ kind: 'exit', value: current, closing: ']' })
            for (let index = children.length - 1; index >= 0; index--) {
                stack.push({ kind: 'value', value: children[index] })
                if (index > 0) stack.push({ kind: 'text', value: ',' })
            }
            continue
        }

        const keys = objectKeys(objectValue).sort()
        output.push('{')
        stack.push({ kind: 'exit', value: objectValue, closing: '}' })
        for (let index = keys.length - 1; index >= 0; index--) {
            const key = keys[index]
            stack.push({ kind: 'value', value: Object.getOwnPropertyDescriptor(objectValue, key)!.value })
            stack.push({ kind: 'text', value: `${JSON.stringify(key)}:` })
            if (index > 0) stack.push({ kind: 'text', value: ',' })
        }
    }

    return output.join('')
}

const assertJsonDepth = (value: unknown, maxDepth: number) => {
    type DepthFrame = { kind: 'value'; value: unknown; depth: number } | { kind: 'exit'; value: object }
    const active = new Set<object>()
    const stack: DepthFrame[] = [{ kind: 'value', value, depth: 1 }]

    while (stack.length > 0) {
        const frame = stack.pop()!
        if (frame.kind === 'exit') {
            active.delete(frame.value)
            continue
        }
        if (frame.depth > maxDepth) throw new PluginApiError('RESOURCE_LIMIT', 'RESOURCE_LIMIT: JSON limit exceeded')
        if (frame.value === null || typeof frame.value !== 'object') continue
        if (active.has(frame.value)) invalidJson('cyclic JSON value')
        active.add(frame.value)
        const children = jsonChildren(frame.value)
        stack.push({ kind: 'exit', value: frame.value })
        for (let index = children.length - 1; index >= 0; index--) {
            stack.push({ kind: 'value', value: children[index], depth: frame.depth + 1 })
        }
    }
}

export function validateJsonLimits(value: unknown, limits: { maxDepth: number; maxBytes: number }) {
    assertJsonDepth(value, limits.maxDepth)
    const canonical = canonicalJson(value)
    if (new TextEncoder().encode(canonical).byteLength > limits.maxBytes) {
        throw new PluginApiError('RESOURCE_LIMIT', 'RESOURCE_LIMIT: JSON limit exceeded')
    }
    return canonical
}

export async function createRevision(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(canonicalJson(value))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return `sha256:${hex(digest)}`
}
