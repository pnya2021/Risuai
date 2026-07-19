import { describe, expect, it, vi } from 'vitest'
import { SecurityConfirmationQueue } from './securityConfirmationQueue'

const request = (instanceId: string, permission = 'contextAssets') => ({
    kind: 'permission' as const,
    principalId: '11111111-1111-4111-8111-111111111111',
    instanceId,
    action: permission,
    copyVersion: 1,
    displayName: 'Demo',
    internalName: 'demo',
})

describe('security confirmation queue', () => {
    it('serializes mixed trusted confirmations and binds decisions to exact digests', async () => {
        const queue = new SecurityConfirmationQueue()
        const first = queue.request(request('a'))
        const second = queue.request({ ...request('b'), kind: 'model-install', action: 'pixai' })
        await queue.whenPresented()
        const firstView = queue.current()
        expect(firstView?.request.kind).toBe('permission')
        expect(queue.decide('wrong-digest', firstView!.presentationId, true)).toBe(false)
        expect(queue.decide(firstView!.digest, firstView!.presentationId, true)).toBe(true)
        expect(await first).toBe(true)
        await queue.whenPresented()
        expect(queue.current()?.request.kind).toBe('model-install')
        const secondView = queue.current()!
        expect(queue.decide(secondView.digest, secondView.presentationId, false)).toBe(true)
        expect(await second).toBe(false)
    })

    it('cancels only unconfirmed requests owned by an aborted instance', async () => {
        const queue = new SecurityConfirmationQueue()
        const a = new AbortController()
        const b = new AbortController()
        const first = queue.request(request('a'), a.signal)
        const second = queue.request(request('b'), b.signal)
        a.abort()
        expect(await first).toBe(false)
        await queue.whenPresented()
        expect(queue.current()?.request.instanceId).toBe('b')
        const view = queue.current()!
        queue.decide(view.digest, view.presentationId, true)
        expect(await second).toBe(true)
    })

    it('rejects a stale presentation nonce when consecutive requests have the same authorization digest', async () => {
        const queue = new SecurityConfirmationQueue()
        const first = queue.request(request('a'))
        const second = queue.request(request('b'))
        await queue.whenPresented()
        const stale = queue.current()!
        expect(queue.decide(stale.digest, stale.presentationId, true)).toBe(true)
        expect(await first).toBe(true)
        await queue.whenPresented()
        const current = queue.current()!
        expect(current.digest).toBe(stale.digest)
        expect(current.presentationId).not.toBe(stale.presentationId)
        expect(queue.decide(stale.digest, stale.presentationId, true)).toBe(false)
        expect(queue.decide(current.digest, current.presentationId, false)).toBe(true)
        expect(await second).toBe(false)
    })

    it('does not expose a full principal ID in ordinary trusted copy', async () => {
        const queue = new SecurityConfirmationQueue()
        void queue.request(request('a'))
        await queue.whenPresented()
        expect(queue.current()?.copy).toContain('Demo')
        expect(queue.current()?.copy).toContain('demo')
        expect(queue.current()?.copy).not.toContain(request('a').principalId)
    })
})
