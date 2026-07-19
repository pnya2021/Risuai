import { describe, expect, it } from 'vitest'
import { CAPABILITY_CONTRACT } from './capabilityContract'
import { assertLimit, utf8ByteLength } from './limits'

describe('capability numeric limits', () => {
    it('accepts every exact descriptor boundary and rejects one over', () => {
        for (const capability of Object.values(CAPABILITY_CONTRACT)) {
            for (const [key, value] of Object.entries(capability.limits)) {
                if (typeof value !== 'number') continue
                expect(() => assertLimit(value, value, key)).not.toThrow()
                expect(() => assertLimit(value + 1, value, key)).toThrowError(/RESOURCE_LIMIT/)
            }
        }
    })

    it('counts UTF-8 bytes, not JavaScript code units', () => {
        expect(utf8ByteLength('가')).toBe(3)
    })
})
