import { describe, expect, it } from 'vitest'
import { createPluginDatabaseBoundary } from './pluginDatabaseBoundary'

describe('public plugin database boundary', () => {
    it('never exposes or accepts host principal fields through reflection', () => {
        const raw = { plugins: [{ name: 'demo', script: 'code', principalId: 'secret-principal' }], pluginCustomStorage: {} }
        const boundary = createPluginDatabaseBoundary(raw, ['plugins', 'pluginCustomStorage'])
        expect(boundary.plugins?.[0].principalId).toBeUndefined()
        expect(({ ...boundary }).plugins?.[0].principalId).toBeUndefined()
        expect(Object.getOwnPropertyDescriptor(boundary, 'plugins')?.value[0].principalId).toBeUndefined()
        expect(Object.getOwnPropertyDescriptors(boundary).plugins.value[0].principalId).toBeUndefined()
        expect(() => Object.defineProperty(boundary, 'plugins', { value: [] })).toThrow(/blocked/)
        expect(() => { boundary.plugins = [] }).toThrow(/blocked/)
        expect(raw.plugins[0].principalId).toBe('secret-principal')
    })
})
