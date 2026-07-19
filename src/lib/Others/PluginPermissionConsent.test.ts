import { mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import PluginPermissionConsent from './PluginPermissionConsent.svelte'
import { securityConfirmationQueue } from '../../ts/plugins/securityConfirmationQueue'

afterEach(() => {
    document.body.innerHTML = ''
    securityConfirmationQueue.clearForTests()
})

const requestPermission = () => securityConfirmationQueue.request({
    kind: 'permission' as const, principalId: 'p', instanceId: 'i', action: 'contextAssets', copyVersion: 1,
    displayName: 'Demo', internalName: 'demo',
})

describe('PluginPermissionConsent', () => {
    it('renders an alert dialog, focuses the safe default, and treats Escape as denial', async () => {
        const decision = requestPermission()
        await securityConfirmationQueue.whenPresented()
        const component = mount(PluginPermissionConsent, { target: document.body })
        await Promise.resolve()
        await Promise.resolve()
        const dialog = document.querySelector('dialog[role="alertdialog"][aria-modal="true"][aria-label="Plugin permission"]')
        expect(dialog).toBeTruthy()
        const deny = [...document.querySelectorAll('button')].find((button) => /Deny/i.test(button.textContent ?? '')) as HTMLButtonElement
        expect(document.activeElement).toBe(deny)
        deny.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(await decision).toBe(false)
        unmount(component)
    })

    it('supports native button approval without a custom keydown decision', async () => {
        const decision = requestPermission()
        await securityConfirmationQueue.whenPresented()
        const component = mount(PluginPermissionConsent, { target: document.body })
        await Promise.resolve()
        const allow = [...document.querySelectorAll('button')].find((button) => /Allow/i.test(button.textContent ?? '')) as HTMLButtonElement
        allow.click()
        expect(await decision).toBe(true)
        unmount(component)
    })
})
