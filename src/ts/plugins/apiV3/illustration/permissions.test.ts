import { beforeEach, describe, expect, it } from 'vitest'
import { SecurityConfirmationQueue } from '../../securityConfirmationQueue'
import {
    ALL_PLUGIN_PERMISSIONS,
    MemoryPermissionPersistence,
    PluginPermissionService,
    createPluginExecutionContext,
    permissionCopy,
} from './permissions'

const context = {
    principalId: '11111111-1111-4111-8111-111111111111', instanceId: 'instance',
    displayName: 'Demo', internalName: 'demo', signal: new AbortController().signal,
}
const decideCurrent = (queue: SecurityConfirmationQueue, decision: boolean) => {
    const view = queue.current()!
    return queue.decide(view.digest, view.presentationId, decision)
}

describe('principal permission service', () => {
    let queue: SecurityConfirmationQueue
    let persistence: MemoryPermissionPersistence
    let service: PluginPermissionService

    beforeEach(() => {
        queue = new SecurityConfirmationQueue()
        persistence = new MemoryPermissionPersistence()
        service = new PluginPermissionService(persistence, queue)
    })

    it.each(ALL_PLUGIN_PERMISSIONS)('persists isolated grant and denial for %s', async (permission) => {
        const result = service.request(context, permission)
        await queue.whenPresented()
        decideCurrent(queue, permission !== 'db')
        expect(await result).toBe(permission !== 'db')
        expect(await service.state(context.principalId, permission)).toBe(permission !== 'db' ? 'granted' : 'denied')
        const other = permission === 'fetchLogs' ? 'db' : 'fetchLogs'
        expect(await service.state(context.principalId, other)).toBe('not-requested')
    })

    it('coalesces the same request while serializing different prompts', async () => {
        const first = service.request(context, 'contextAssets')
        const duplicate = service.request(context, 'contextAssets')
        const other = service.request(context, 'chatObserve')
        await queue.whenPresented()
        decideCurrent(queue, true)
        expect(await first).toBe(true)
        expect(await duplicate).toBe(true)
        await queue.whenPresented()
        decideCurrent(queue, false)
        expect(await other).toBe(false)
    })

    it('does not let one instance abort a coalesced request owned by another instance', async () => {
        const firstAbort = new AbortController()
        const firstContext = { ...context, instanceId: 'first', signal: firstAbort.signal }
        const secondContext = { ...context, instanceId: 'second', signal: new AbortController().signal }
        const first = service.request(firstContext, 'contextAssets')
        const second = service.request(secondContext, 'contextAssets')
        await queue.whenPresented()
        firstAbort.abort()
        expect(await first).toBe(false)
        await queue.whenPresented()
        decideCurrent(queue, true)
        expect(await second).toBe(true)
    })

    it('never returns a persisted grant to an already aborted instance', async () => {
        await persistence.set(context.principalId, 'contextAssets', { state: 'granted', decidedAt: 1 })
        const abort = new AbortController(); abort.abort()
        await expect(service.request({ ...context, signal: abort.signal }, 'contextAssets')).resolves.toBe(false)
        expect(queue.current()).toBeNull()
    })

    it('preserves three-day periodic reconfirmation without coalescing an explicit reconfirm', async () => {
        let now = 1_000
        service = new PluginPermissionService(persistence, queue, { now: () => now })
        const initial = service.request(context, 'db')
        await queue.whenPresented()
        decideCurrent(queue, true)
        await initial

        now += 3 * 24 * 60 * 60 * 1000
        await expect(service.request(context, 'db', { reconfirm: 'periodically' })).resolves.toBe(true)
        expect(queue.current()).toBeNull()

        now += 1
        const periodic = service.request(context, 'db', { reconfirm: 'periodically' })
        const explicit = service.request(context, 'db', { reconfirm: true })
        await queue.whenPresented()
        decideCurrent(queue, true)
        await periodic
        await queue.whenPresented()
        decideCurrent(queue, true)
        await explicit
    })

    it('resets and reconfirms without trusting name-only legacy records', async () => {
        await persistence.set('legacy-name', 'contextAssets', 'granted')
        expect(await service.state(context.principalId, 'contextAssets')).toBe('not-requested')
        const result = service.request(context, 'contextAssets')
        await queue.whenPresented()
        decideCurrent(queue, true)
        await result
        await service.resetPrincipal(context.principalId)
        expect(await service.state(context.principalId, 'contextAssets')).toBe('not-requested')
    })

    it('does not let an uninstall-time prompt repersist a cleared grant', async () => {
        const pending = service.request(context, 'contextAssets')
        await queue.whenPresented()
        const view = queue.current()!
        await service.resetPrincipal(context.principalId)
        queue.decide(view.digest, view.presentationId, true)
        await expect(pending).resolves.toBe(false)
        await expect(service.state(context.principalId, 'contextAssets')).resolves.toBe('not-requested')
    })

    it('barriers requests behind an in-progress principal reset', async () => {
        await persistence.set(context.principalId, 'contextAssets', { state: 'granted', decidedAt: 1 })
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const clearStarted = new Promise<void>((resolve) => { started = resolve })
        const delayedPersistence = {
            get: persistence.get.bind(persistence),
            set: persistence.set.bind(persistence),
            clearPrincipal: async (principalId: string) => {
                started()
                await gate
                await persistence.clearPrincipal(principalId)
            },
        }
        service = new PluginPermissionService(delayedPersistence, queue)

        const reset = service.resetPrincipal(context.principalId)
        await clearStarted
        const pending = service.request(context, 'contextAssets')
        await Promise.resolve()
        expect(queue.current()).toBeNull()
        release()
        await reset
        await queue.whenPresented()
        decideCurrent(queue, true)
        await expect(pending).resolves.toBe(true)
    })

    it('serializes a stale grant write, reset, and new grant without clearing the new generation', async () => {
        let releaseFirstSet!: () => void
        let markFirstSetStarted!: () => void
        const firstSetGate = new Promise<void>((resolve) => { releaseFirstSet = resolve })
        const firstSetStarted = new Promise<void>((resolve) => { markFirstSetStarted = resolve })
        let blockFirstSet = true
        const delayedPersistence = {
            get: persistence.get.bind(persistence),
            clearPrincipal: persistence.clearPrincipal.bind(persistence),
            set: async (...args: Parameters<MemoryPermissionPersistence['set']>) => {
                if (blockFirstSet) {
                    blockFirstSet = false
                    markFirstSetStarted()
                    await firstSetGate
                }
                await persistence.set(...args)
            },
        }
        service = new PluginPermissionService(delayedPersistence, queue)

        const stale = service.request(context, 'contextAssets')
        await queue.whenPresented()
        decideCurrent(queue, true)
        await firstSetStarted

        const reset = service.resetPrincipal(context.principalId)
        const fresh = service.request({ ...context, instanceId: 'fresh' }, 'contextAssets')
        expect(queue.current()).toBeNull()
        releaseFirstSet()
        await reset
        await queue.whenPresented()
        decideCurrent(queue, true)

        await expect(stale).resolves.toBe(false)
        await expect(fresh).resolves.toBe(true)
        await expect(service.state(context.principalId, 'contextAssets')).resolves.toBe('granted')
    })

    it('barriers and invalidates requests during a global permission reset', async () => {
        await persistence.set(context.principalId, 'contextAssets', { state: 'granted', decidedAt: 1 })
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const clearStarted = new Promise<void>((resolve) => { started = resolve })
        const reset = service.resetAll(async () => {
            started()
            await gate
            await persistence.clearPrincipal(context.principalId)
        })
        await clearStarted
        const pending = service.request(context, 'contextAssets')
        await Promise.resolve()
        expect(queue.current()).toBeNull()
        release()
        await reset
        await queue.whenPresented()
        decideCurrent(queue, false)
        await expect(pending).resolves.toBe(false)
    })

    it('rejects cached and in-flight grants as soon as principal retirement begins', async () => {
        let retiring = false
        service = new PluginPermissionService(persistence, queue, { isPrincipalRetiring: () => retiring })
        await persistence.set(context.principalId, 'contextAssets', { state: 'granted', decidedAt: 1 })
        retiring = true
        await expect(service.request(context, 'contextAssets')).resolves.toBe(false)
        expect(queue.current()).toBeNull()

        retiring = false
        await persistence.clearPrincipal(context.principalId)
        const pending = service.request(context, 'contextAssets')
        await queue.whenPresented()
        retiring = true
        decideCurrent(queue, true)
        await expect(pending).resolves.toBe(false)
        await expect(service.state(context.principalId, 'contextAssets')).resolves.toBe('not-requested')
    })

    it.each(['en', 'ko'] as const)('has accessible %s copy for every permission', (locale) => {
        for (const permission of ALL_PLUGIN_PERMISSIONS) {
            const copy = permissionCopy(locale, permission, 'Demo', 'demo')
            expect(copy.title.length).toBeGreaterThan(0)
            expect(copy.description.length).toBeGreaterThan(0)
            expect(copy.allowLabel.length).toBeGreaterThan(0)
            expect(copy.denyLabel.length).toBeGreaterThan(0)
        }
    })

    it('uses the exact least-privilege card catalogue consent copy', () => {
        expect(ALL_PLUGIN_PERMISSIONS).toContain('cardCatalogRead')
        expect(permissionCopy('en', 'cardCatalogRead', 'Demo', 'demo').description).toBe(
            'Demo (demo) requests permission to read normal character and group card names, types, representative images, card settings, global lorebooks, and card-owned images; chat messages and trash are excluded.',
        )
        expect(permissionCopy('ko', 'cardCatalogRead', 'Demo', 'demo').description).toBe(
            'Demo (demo) 플러그인이 다음 권한을 요청합니다: 일반 캐릭터와 그룹 카드의 이름, 유형, 대표 이미지, 카드 설정, 전역 로어북, 카드 소유 이미지를 읽기(채팅 메시지와 휴지통 제외).',
        )
    })

    it('creates one unique abortable execution context per plugin load', () => {
        const plugin = { principalId: context.principalId, name: 'demo', displayName: 'Demo' }
        const first = createPluginExecutionContext(plugin)
        const second = createPluginExecutionContext(plugin)
        expect(first.context.instanceId).not.toBe(second.context.instanceId)
        expect(first.context.principalId).toBe(context.principalId)
        expect(first.context.displayName).toBe('Demo')
        first.abortController.abort()
        expect(first.context.signal.aborted).toBe(true)
        expect(second.context.signal.aborted).toBe(false)
    })

    it('exposes a read-only generation token that changes synchronously for principal and global resets', async () => {
        const otherPrincipal = '22222222-2222-4222-8222-222222222222'
        const initial = service.generation(context.principalId)
        expect(service.generation(otherPrincipal)).toBe(initial)

        const principalReset = service.resetPrincipal(context.principalId)
        const afterPrincipal = service.generation(context.principalId)
        expect(afterPrincipal).not.toBe(initial)
        expect(service.generation(otherPrincipal)).toBe(initial)
        await principalReset

        const globalReset = service.resetAll(async () => undefined)
        expect(service.generation(context.principalId)).not.toBe(afterPrincipal)
        expect(service.generation(otherPrincipal)).not.toBe(initial)
        await globalReset
    })
})
