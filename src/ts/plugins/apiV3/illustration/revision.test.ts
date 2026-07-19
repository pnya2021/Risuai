import { describe, expect, it } from 'vitest'
import { canonicalJson, createRevision, validateJsonLimits } from './revision'

describe('canonical revisions', () => {
    it('is stable across object insertion order and changes with content', async () => {
        expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }))
        expect(await createRevision({ b: 2, a: 1 })).toBe(await createRevision({ a: 1, b: 2 }))
        expect(await createRevision({ a: 1 })).not.toBe(await createRevision({ a: 2 }))
    })

    it('enforces exact JSON depth and byte boundaries', () => {
        expect(() => validateJsonLimits({ a: { b: 1 } }, { maxDepth: 3, maxBytes: 100 })).not.toThrow()
        expect(() => validateJsonLimits({ a: { b: 1 } }, { maxDepth: 2, maxBytes: 100 })).toThrowError(/RESOURCE_LIMIT/)
        const bytes = new TextEncoder().encode(canonicalJson({ value: '가' })).byteLength
        expect(() => validateJsonLimits({ value: '가' }, { maxDepth: 2, maxBytes: bytes })).not.toThrow()
        expect(() => validateJsonLimits({ value: '가' }, { maxDepth: 2, maxBytes: bytes - 1 })).toThrowError(/RESOURCE_LIMIT/)
    })

    it('rejects deeply nested input before recursive encoding and accepts wide input without argument spreading', () => {
        let deep: unknown = 0
        for (let index = 0; index < 10_000; index++) deep = { child: deep }
        expect(() => validateJsonLimits(deep, { maxDepth: 32, maxBytes: 2 * 1024 * 1024 })).toThrowError(/RESOURCE_LIMIT/)

        const wide = Array.from({ length: 300_000 }, () => 0)
        expect(() => validateJsonLimits(wide, { maxDepth: 2, maxBytes: 2 * 1024 * 1024 })).not.toThrow()
    })

    it('rejects cycles and executable/non-JSON values', () => {
        const cycle: any = {}; cycle.self = cycle
        expect(() => canonicalJson(cycle)).toThrowError(/INVALID_ARGUMENT/)
        expect(() => canonicalJson({ fn() {} })).toThrowError(/INVALID_ARGUMENT/)
        expect(() => canonicalJson(new Date())).toThrowError(/INVALID_ARGUMENT/)
        expect(() => canonicalJson(new Map())).toThrowError(/INVALID_ARGUMENT/)
        expect(() => canonicalJson([, 1])).toThrowError(/INVALID_ARGUMENT/)
        const shared = { value: 1 }
        expect(() => canonicalJson({ left: shared, right: shared })).not.toThrow()
        const extended = [1] as unknown[] & { [key: symbol]: unknown }
        Object.defineProperty(extended, Symbol('extra'), { value: 2, enumerable: true })
        expect(() => canonicalJson(extended)).toThrowError(/INVALID_ARGUMENT/)
        let getterReads = 0
        const accessor: unknown[] = []
        Object.defineProperty(accessor, '0', { enumerable: true, get: () => { getterReads++; return 1 } })
        expect(() => canonicalJson(accessor)).toThrowError(/INVALID_ARGUMENT/)
        expect(getterReads).toBe(0)
    })
})
