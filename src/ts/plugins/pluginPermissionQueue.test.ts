import { describe, expect, it } from 'vitest'
import { SecurityConfirmationQueue } from './securityConfirmationQueue'
import { MemoryPermissionPersistence, PluginPermissionService } from './apiV3/illustration/permissions'

const context = (principalId: string, instanceId: string) => ({
    principalId, instanceId, displayName: 'Display', internalName: 'internal', signal: new AbortController().signal,
})

describe('production plugin permission queue', () => {
    it('serializes principals and keeps permissions independent', async () => {
        const queue = new SecurityConfirmationQueue()
        const service = new PluginPermissionService(new MemoryPermissionPersistence(), queue)
        const first = service.request(context('p1', 'i1'), 'fetchLogs')
        const second = service.request(context('p2', 'i2'), 'db')
        await queue.whenPresented()
        let view = queue.current()!
        queue.decide(view.digest, view.presentationId, true)
        await first
        await queue.whenPresented()
        view = queue.current()!
        queue.decide(view.digest, view.presentationId, false)
        await second
        expect(await service.state('p1', 'fetchLogs')).toBe('granted')
        expect(await service.state('p1', 'db')).toBe('not-requested')
        expect(await service.state('p2', 'db')).toBe('denied')
    })
})
