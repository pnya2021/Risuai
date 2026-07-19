import { describe, expect, it, vi } from 'vitest'
import { runPrincipalBoundPluginUpdate } from './pluginUpdateAuthorization'

const firstPrincipal = '11111111-1111-4111-8111-111111111111'
const secondPrincipal = '22222222-2222-4222-8222-222222222222'

describe('principal-bound plugin update', () => {
    it('fails closed when the initiating record has no canonical principal', async () => {
        const fetchUpdate = vi.fn()
        await expect(runPrincipalBoundPluginUpdate({ name: 'demo', script: 'old', updateURL: '/update' }, {
            fetchUpdate,
            isInstalledRecordCurrent: vi.fn(() => true),
            importUpdate: vi.fn(),
        })).resolves.toBe(false)
        expect(fetchUpdate).not.toHaveBeenCalled()
    })

    it('does not apply a delayed response to a reinstalled same-name plugin', async () => {
        let resolveText!: (value: string) => void
        let installed = { name: 'demo', script: 'old', principalId: firstPrincipal }
        const importUpdate = vi.fn(async () => ({}))
        const update = runPrincipalBoundPluginUpdate({ ...installed, updateURL: '/update' }, {
            fetchUpdate: async () => ({
                status: 200,
                text: () => new Promise<string>((resolve) => { resolveText = resolve }),
            }),
            isInstalledRecordCurrent: (name, principalId, script) => installed.name === name
                && installed.principalId === principalId && installed.script === script,
            importUpdate,
        })
        await vi.waitFor(() => expect(resolveText).toBeTypeOf('function'))
        installed = { name: 'demo', script: 'replacement', principalId: secondPrincipal }
        resolveText('new update code')

        await expect(update).resolves.toBe(false)
        expect(importUpdate).not.toHaveBeenCalled()
    })

    it('binds both principal and source record into the trusted import', async () => {
        const importUpdate = vi.fn(async () => ({ name: 'demo' }))
        await expect(runPrincipalBoundPluginUpdate({
            name: 'demo', script: 'old', updateURL: '/update', principalId: firstPrincipal,
        }, {
            fetchUpdate: async () => ({ status: 200, text: async () => 'updated code' }),
            isInstalledRecordCurrent: () => true,
            importUpdate,
        })).resolves.toBe(true)
        expect(importUpdate).toHaveBeenCalledWith('updated code', {
            isUpdate: true,
            originalPluginName: 'demo',
            expectedPrincipalId: firstPrincipal,
            expectedPluginScript: 'old',
        })
    })
})
