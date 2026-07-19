import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRevocableV2Api, createV2RuntimeAuthorization, resetPluginV2Runtime, type PluginV2RuntimeState } from './pluginV2Runtime'

describe('V2 runtime reload', () => {
    it('wires the tested generation gate and facade into the production V2 API factory', () => {
        const source = readFileSync(join(process.cwd(), 'src/ts/plugins/plugins.svelte.ts'), 'utf8')
        expect(source).toContain('isInstalledRecordCurrent: () => boolean = isActive')
        expect(source).toContain('scopedApi = createRevocableV2Api(rawApi, isActive, pluginV2.ownedResources)')
        expect(source).toContain('return safeGlobal;')
        expect(source).toContain('rawApi.safeGlobalThis = safeGlobal;')
        expect(source).not.toContain('createRevocableV2Api(safeGlobal, isActive')
        expect(source).toContain("applyProgrammaticDatabaseMutation(newDb, 'lite', isActive, isInstalledRecordCurrent)")
        expect(source).toContain('createV2RuntimeAuthorization(pluginV2')
    })
    it('runs old unload callbacks exactly once and clears every shared registry before reload', async () => {
        const handler = vi.fn()
        const unload = vi.fn()
        const runtime: PluginV2RuntimeState = {
            providers: new Map([['provider', handler]]),
            providerOptions: new Map([['provider', { tokenizer: 'legacy' }]]),
            editdisplay: new Set([handler]), editoutput: new Set([handler]),
            editprocess: new Set([handler]), editinput: new Set([handler]),
            replacerbeforeRequest: new Set([handler]), replacerafterRequest: new Set([handler]),
            unload: new Set([unload]), loaded: true, generation: 0,
        }
        const clearProviderNames = vi.fn()

        await resetPluginV2Runtime(runtime, clearProviderNames)
        await resetPluginV2Runtime(runtime, clearProviderNames)

        expect(unload).toHaveBeenCalledOnce()
        expect(runtime.providers.size).toBe(0)
        expect(runtime.providerOptions.size).toBe(0)
        expect(runtime.editdisplay.size).toBe(0)
        expect(runtime.editoutput.size).toBe(0)
        expect(runtime.editprocess.size).toBe(0)
        expect(runtime.editinput.size).toBe(0)
        expect(runtime.replacerbeforeRequest.size).toBe(0)
        expect(runtime.replacerafterRequest.size).toBe(0)
        expect(runtime.unload.size).toBe(0)
        expect(clearProviderNames).toHaveBeenCalledTimes(2)
    })

    it('drops unload callbacks registered during teardown and continues after callback failure', async () => {
        const late = vi.fn()
        const later = vi.fn()
        const runtime: PluginV2RuntimeState = {
            providers: new Map(), providerOptions: new Map(),
            editdisplay: new Set(), editoutput: new Set(), editprocess: new Set(), editinput: new Set(),
            replacerbeforeRequest: new Set(), replacerafterRequest: new Set(),
            unload: new Set(), loaded: true, generation: 0,
        }
        runtime.unload.add(() => { runtime.unload.add(late); throw new Error('expected cleanup failure') })
        runtime.unload.add(later)

        const failures = await resetPluginV2Runtime(runtime, vi.fn())
        await resetPluginV2Runtime(runtime, vi.fn())

        expect(failures).toHaveLength(1)
        expect(later).toHaveBeenCalledOnce()
        expect(late).not.toHaveBeenCalled()
        expect(runtime.unload.size).toBe(0)
    })

    it('invalidates the old generation before unload callbacks run', async () => {
        const runtime: PluginV2RuntimeState = {
            providers: new Map(), providerOptions: new Map(),
            editdisplay: new Set(), editoutput: new Set(), editprocess: new Set(), editinput: new Set(),
            replacerbeforeRequest: new Set(), replacerafterRequest: new Set(),
            unload: new Set(), loaded: true, generation: 4,
        }
        const isActive = createV2RuntimeAuthorization(runtime, () => true)
        let observedActive = true
        const observed = vi.fn(() => { observedActive = isActive() })
        runtime.unload.add(observed)

        await resetPluginV2Runtime(runtime, vi.fn())

        expect(observedActive).toBe(false)
        expect(isActive()).toBe(false)
    })

    it('times out a never-settling unload callback and still clears every registry', async () => {
        const handler = vi.fn()
        const runtime: PluginV2RuntimeState = {
            providers: new Map([['provider', handler]]), providerOptions: new Map([['provider', {}]]),
            editdisplay: new Set([handler]), editoutput: new Set(), editprocess: new Set(), editinput: new Set(),
            replacerbeforeRequest: new Set(), replacerafterRequest: new Set(),
            unload: new Set([() => new Promise<void>(() => undefined)]), loaded: true, generation: 0,
        }
        const clearProviderNames = vi.fn()
        const failures = await resetPluginV2Runtime(runtime, clearProviderNames, 10)
        expect(failures).toHaveLength(1)
        expect(runtime.providers.size).toBe(0)
        expect(runtime.providerOptions.size).toBe(0)
        expect(runtime.editdisplay.size).toBe(0)
        expect(runtime.unload.size).toBe(0)
        expect(clearProviderNames).toHaveBeenCalledOnce()
    })

    it('revokes delayed direct, storage, safe-global, SafeFunction, and registration aliases', () => {
        const runtime = { generation: 1 }
        const isActive = createV2RuntimeAuthorization(runtime, () => true)
        const effect = vi.fn()
        let api: any
        const raw = {
            setDatabaseLite: effect,
            addProvider: effect,
            storage: { setItem: effect },
            makeStorage: () => ({ setItem: effect }),
            safeGlobalThis: { mutate: effect },
            SafeFunction: new Proxy(Function, {
                apply: () => () => api.safeGlobalThis,
                construct: () => () => api.safeGlobalThis,
            }),
        }
        api = createRevocableV2Api(raw, isActive)
        const setter = api.setDatabaseLite
        const boundSetter = api.setDatabaseLite.bind(null)
        const descriptorSetter = Object.getOwnPropertyDescriptor(api, 'setDatabaseLite')!.value
        const register = api.addProvider
        const storage = api.storage
        const descriptorStorageSetter = Object.getOwnPropertyDescriptor(storage, 'setItem')!.value
        const returnedStorage = api.makeStorage()
        const safeGlobal = api.safeGlobalThis
        const delayedSafeFunction = api.SafeFunction() as () => unknown
        const risuai = api
        expect(Object.getPrototypeOf(risuai)).toBeNull()
        expect(Object.getPrototypeOf(storage)).toBeNull()
        expect(storage.constructor).toBeUndefined()

        runtime.generation += 1

        expect(() => setter({ plugins: [] })).toThrow('no longer active')
        expect(() => boundSetter({ plugins: [] })).toThrow('no longer active')
        expect(() => descriptorSetter({ plugins: [] })).toThrow('no longer active')
        expect(() => register('late', effect)).toThrow('no longer active')
        expect(() => storage.setItem('key', 'value')).toThrow('no longer active')
        expect(() => descriptorStorageSetter('key', 'value')).toThrow('no longer active')
        expect(() => returnedStorage.setItem('key', 'value')).toThrow('no longer active')
        expect(() => safeGlobal.mutate()).toThrow('no longer active')
        expect(() => delayedSafeFunction()).toThrow('no longer active')
        expect(() => risuai.setDatabaseLite).toThrow('no longer active')
        expect(effect).not.toHaveBeenCalled()
    })

    it('executes a facade-registered onUnload callback once after revocation', async () => {
        const runtime: PluginV2RuntimeState = {
            providers: new Map(), providerOptions: new Map(), editdisplay: new Set(), editoutput: new Set(),
            editprocess: new Set(), editinput: new Set(), replacerbeforeRequest: new Set(), replacerafterRequest: new Set(),
            unload: new Set(), loaded: true, generation: 0, ownedResources: new Set(),
        }
        const isActive = createV2RuntimeAuthorization(runtime, () => true)
        const effect = vi.fn()
        let api: any
        let capturedApiWasRevoked = false
        const cleanup = vi.fn(() => {
            try { api.mutate() } catch { capturedApiWasRevoked = true }
        })
        api = createRevocableV2Api({
            onUnload: (callback: () => void | Promise<void>) => runtime.unload.add(callback),
            mutate: effect,
        }, isActive, runtime.ownedResources)

        api.onUnload(cleanup)
        await resetPluginV2Runtime(runtime, vi.fn(), 10)
        await resetPluginV2Runtime(runtime, vi.fn(), 10)

        expect(cleanup).toHaveBeenCalledOnce()
        expect(capturedApiWasRevoked).toBe(true)
        expect(effect).not.toHaveBeenCalled()
    })

    it('settles a host-observed registered callback with rejection after revocation', async () => {
        const runtime: PluginV2RuntimeState = {
            providers: new Map(), providerOptions: new Map(), editdisplay: new Set(), editoutput: new Set(),
            editprocess: new Set(), editinput: new Set(), replacerbeforeRequest: new Set(), replacerafterRequest: new Set(),
            unload: new Set(), loaded: true, generation: 0, ownedResources: new Set(),
        }
        const isActive = createV2RuntimeAuthorization(runtime, () => true)
        let resolveProvider!: (value: string) => void
        const providerResult = new Promise<string>((resolve) => { resolveProvider = resolve })
        let registeredProvider!: () => Promise<string>
        const api = createRevocableV2Api({
            addProvider: (provider: () => Promise<string>) => { registeredProvider = provider },
        }, isActive, runtime.ownedResources)
        api.addProvider(() => providerResult)
        const providerCall = registeredProvider()
        expect(providerCall).toBeInstanceOf(Promise)
        let timeout!: ReturnType<typeof setTimeout>
        const hostObservation = providerCall.then(
            () => ({ status: 'fulfilled' as const }),
            (error) => ({ status: 'rejected' as const, error }),
        )
        const observed = Promise.race([
            Promise.resolve(hostObservation),
            new Promise<{ status: 'timed-out' }>((resolve) => {
                timeout = setTimeout(() => resolve({ status: 'timed-out' }), 100)
            }),
        ])
        await Promise.resolve()

        await resetPluginV2Runtime(runtime, vi.fn(), 10)
        resolveProvider('stale provider output')

        const result = await observed
        clearTimeout(timeout)
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') expect(result.error).toEqual(expect.objectContaining({
            message: expect.stringContaining('no longer active'),
        }))
    })

    it('preserves binary results returned from plugin callbacks to the host', async () => {
        const runtime = { generation: 0 }
        const isActive = createV2RuntimeAuthorization(runtime, () => true)
        const registered: Array<() => unknown> = []
        const bytes = new Uint8Array([1, 2, 3])
        const api = createRevocableV2Api({
            register: (callback: () => unknown) => { registered.push(callback) },
        }, isActive)

        api.register(() => bytes)
        api.register(async () => bytes)
        const syncResult = registered[0]()
        const asyncResult = await registered[1]()

        expect(syncResult === bytes).toBe(true)
        expect(ArrayBuffer.isView(syncResult)).toBe(true)
        expect(asyncResult === bytes).toBe(true)
        expect(ArrayBuffer.isView(asyncResult)).toBe(true)
    })

    it('does not run Promise chain callbacks after the runtime is revoked', async () => {
        const runtime = { generation: 0 }
        const isActive = createV2RuntimeAuthorization(runtime, () => true)
        let resolveRead!: (value: string) => void
        const read = new Promise<string>((resolve) => { resolveRead = resolve })
        const rejectedByThen = vi.fn()
        const rejectedByCatch = vi.fn()
        const finalized = vi.fn()
        const api = createRevocableV2Api({ read: () => read }, isActive)
        const pending = api.read()

        pending.then(undefined, rejectedByThen)
        pending.catch(rejectedByCatch)
        pending.finally(finalized).catch(() => undefined)
        runtime.generation += 1
        resolveRead('stale value')
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(rejectedByThen).not.toHaveBeenCalled()
        expect(rejectedByCatch).not.toHaveBeenCalled()
        expect(finalized).not.toHaveBeenCalled()
    })

    it('guards callback properties assigned through the object membrane', () => {
        const runtime = { generation: 0 }
        const isActive = createV2RuntimeAuthorization(runtime, () => true)
        const assigned = vi.fn()
        const defined = vi.fn()
        const rawTarget: { onclick?: () => void; onmessage?: () => void } = {}
        const api = createRevocableV2Api({ target: rawTarget }, isActive)

        api.target.onclick = assigned
        Object.defineProperty(api.target, 'onmessage', {
            configurable: true,
            writable: true,
            value: defined,
        })
        runtime.generation += 1
        rawTarget.onclick?.()
        rawTarget.onmessage?.()

        expect(assigned).not.toHaveBeenCalled()
        expect(defined).not.toHaveBeenCalled()
    })

    it('owns timers and listeners, membranes callback inputs, and removes them on reset', async () => {
        vi.useFakeTimers()
        try {
            const target = new EventTarget()
            const runtime: PluginV2RuntimeState = {
                providers: new Map(), providerOptions: new Map(), editdisplay: new Set(), editoutput: new Set(),
                editprocess: new Set(), editinput: new Set(), replacerbeforeRequest: new Set(), replacerafterRequest: new Set(),
                unload: new Set(), loaded: true, generation: 0, ownedResources: new Set(),
            }
            const isActive = createV2RuntimeAuthorization(runtime, () => true)
            const safeWindow = {
                setTimeout: (callback: () => void, delay?: number) => globalThis.setTimeout(callback, delay),
                clearTimeout: (handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle),
                setInterval: (callback: () => void, delay?: number) => globalThis.setInterval(callback, delay),
                clearInterval: (handle: ReturnType<typeof setInterval>) => globalThis.clearInterval(handle),
                addEventListener: target.addEventListener.bind(target),
                removeEventListener: target.removeEventListener.bind(target),
                getEventTarget: () => target,
            }
            const rawApi: { safeGlobalThis: typeof safeWindow | Record<string, never>; getSafeGlobalThis: () => typeof safeWindow } = {
                safeGlobalThis: {},
                getSafeGlobalThis: () => {
                    if (Object.keys(rawApi.safeGlobalThis).length) return rawApi.safeGlobalThis as typeof safeWindow
                    rawApi.safeGlobalThis = safeWindow
                    return safeWindow
                },
            }
            const rootApi = createRevocableV2Api(rawApi, isActive, runtime.ownedResources)
            const api = rootApi.getSafeGlobalThis()
            expect(rootApi.getSafeGlobalThis()).toBe(api)
            expect(rootApi.safeGlobalThis).toBe(api)

            expect(() => (api.setTimeout as any)('unsafe string timer', 0)).toThrow('requires a function callback')

            const timeout = vi.fn()
            api.setTimeout(timeout, 5)
            expect(runtime.ownedResources.size).toBe(1)
            await vi.advanceTimersByTimeAsync(5)
            expect(timeout).toHaveBeenCalledOnce()
            expect(runtime.ownedResources.size).toBe(0)

            const clearedTimeout = vi.fn()
            const timeoutId = api.setTimeout(clearedTimeout, 50)
            api.clearTimeout(timeoutId)
            const interval = vi.fn()
            const clearedInterval = vi.fn()
            const clearedIntervalId = api.setInterval(clearedInterval, 5)
            expect(runtime.ownedResources.size).toBe(1)
            api.clearInterval(clearedIntervalId)
            expect(runtime.ownedResources.size).toBe(0)
            api.setInterval(interval, 5)
            const returnedTarget = api.getEventTarget()
            const explicitlyRemoved = vi.fn()
            returnedTarget.addEventListener('explicit', explicitlyRemoved, false)
            returnedTarget.removeEventListener('explicit', explicitlyRemoved, true)
            expect(runtime.ownedResources.size).toBe(2)
            returnedTarget.dispatchEvent(new Event('explicit'))
            expect(explicitlyRemoved).toHaveBeenCalledOnce()
            returnedTarget.removeEventListener('explicit', explicitlyRemoved, false)
            returnedTarget.dispatchEvent(new Event('explicit'))
            expect(explicitlyRemoved).toHaveBeenCalledOnce()
            let received: Event | undefined
            const escapedMutation = vi.fn()
            const listener = vi.fn((event: Event & { view?: { __pluginApis__?: { mutate?: () => void } } }) => {
                received = event
                event.view?.__pluginApis__?.mutate?.()
            })
            returnedTarget.addEventListener('message', listener, { capture: true })
            const message = new Event('message')
            Object.defineProperty(message, 'view', { value: { __pluginApis__: { mutate: escapedMutation } } })
            returnedTarget.dispatchEvent(message)
            expect(listener).toHaveBeenCalledOnce()
            expect(escapedMutation).toHaveBeenCalledOnce()
            expect(Object.getPrototypeOf(received!)).toBeNull()
            expect(runtime.ownedResources.size).toBe(2)

            await vi.advanceTimersByTimeAsync(5)
            expect(interval).toHaveBeenCalledOnce()
            const resetErrors = await resetPluginV2Runtime(runtime, vi.fn(), 10)
            const staleMessage = new Event('message')
            Object.defineProperty(staleMessage, 'view', { value: { __pluginApis__: { mutate: escapedMutation } } })
            target.dispatchEvent(staleMessage)
            await vi.advanceTimersByTimeAsync(50)
            expect(listener).toHaveBeenCalledOnce()
            expect(escapedMutation).toHaveBeenCalledOnce()
            expect(interval).toHaveBeenCalledOnce()
            expect(clearedInterval).not.toHaveBeenCalled()
            expect(clearedTimeout).not.toHaveBeenCalled()
            expect(runtime.ownedResources.size).toBe(0)
            expect(resetErrors).toEqual([])
        } finally {
            vi.useRealTimers()
        }
    })
})
