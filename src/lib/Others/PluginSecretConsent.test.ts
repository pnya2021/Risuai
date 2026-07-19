import { mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import PluginSecretConsent from './PluginSecretConsent.svelte'
import { securityConfirmationQueue } from '../../ts/plugins/securityConfirmationQueue'

afterEach(() => {
    document.body.innerHTML = ''
    securityConfirmationQueue.clearForTests()
})

describe('PluginSecretConsent', () => {
    it('uses an alert dialog, safe default focus, Escape denial, and policy description', async () => {
        const decision = securityConfirmationQueue.request({
            kind: 'secret-placement', principalId: 'p', instanceId: 'i', action: 'nai-key',
            policyDigest: 'policy', copyVersion: 1, displayName: 'Demo', internalName: 'demo',
            title: 'Store write-only Secret', description: 'Allowed origins:\n· https://api.example.com',
            allowLabel: 'Store', denyLabel: 'Cancel',
        })
        await securityConfirmationQueue.whenPresented()
        const component = mount(PluginSecretConsent, { target: document.body })
        await Promise.resolve(); await Promise.resolve()
        const dialog = document.querySelector('dialog[role="alertdialog"][aria-modal="true"]')
        expect(dialog?.textContent).toContain('https://api.example.com')
        const cancel = [...document.querySelectorAll('button')].find((button) => /Cancel/i.test(button.textContent ?? '')) as HTMLButtonElement
        expect(document.activeElement).toBe(cancel)
        dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(await decision).toBe(false)
        unmount(component)
    })

    it('does not render for ordinary permission confirmations', async () => {
        void securityConfirmationQueue.request({
            kind: 'permission', principalId: 'p', instanceId: 'i', action: 'secrets',
            copyVersion: 1, displayName: 'Demo', internalName: 'demo',
        })
        await securityConfirmationQueue.whenPresented()
        const component = mount(PluginSecretConsent, { target: document.body })
        await Promise.resolve()
        expect(document.querySelector('dialog')).toBeNull()
        unmount(component)
    })
})
