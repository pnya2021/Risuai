export interface PluginV2RuntimeState {
    providers: Map<unknown, unknown>
    providerOptions: Map<unknown, unknown>
    editdisplay: Set<unknown>
    editoutput: Set<unknown>
    editprocess: Set<unknown>
    editinput: Set<unknown>
    replacerbeforeRequest: Set<unknown>
    replacerafterRequest: Set<unknown>
    unload: Set<() => void | Promise<void>>
    loaded: boolean
    generation: number
    ownedResources?: Set<() => void>
}

export function createV2RuntimeAuthorization(
    runtime: Pick<PluginV2RuntimeState, 'generation'>,
    isRecordCurrent: () => boolean,
) {
    const generation = runtime.generation
    return () => runtime.generation === generation && isRecordCurrent()
}

/**
 * Best-effort lifecycle membrane for legacy V2 plugins. V2 code executes in
 * the host realm, so this revokes normal API aliases and callbacks but is not
 * a sandbox or a security/capability boundary. V3 provides that boundary.
 */
export function createRevocableV2Api<T extends object>(
    value: T,
    isActive: () => boolean,
    ownedResources: Set<() => void> = new Set(),
): T {
    const objectCache = new WeakMap<object, object>()
    const callbackCache = new WeakMap<object, any>()
    const listenerRecords: Array<{
        target: object; type: unknown; original: object; capture: boolean; cleanup: () => void
    }> = []
    const timerRecords: Array<{ handle: unknown; kind: 'timeout' | 'interval'; cleanup: () => void }> = []
    const assertActive = () => {
        if (!isActive()) throw new Error('V2 plugin runtime is no longer active')
    }
    const capture = (options: unknown) => typeof options === 'boolean'
        ? options
        : !!(options && typeof options === 'object' && (options as { capture?: boolean }).capture)
    const wrapResult = (result: any) => {
        if (result instanceof Promise) {
            const settled = result.then(
                (next) => { assertActive(); return wrap(next) },
                (error) => { assertActive(); throw error },
            )
            // A revoked plugin cannot observe this rejection. Mark the host
            // promise handled while its then/catch/finally facade keeps the
            // rejection state for callers that attach before revocation.
            void settled.catch(() => undefined)
            return wrap(settled)
        }
        if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) return result
        return wrap(result)
    }
    const wrapHostCallbackResult = (result: any) => {
        const wrapHostValue = (next: any) => next instanceof ArrayBuffer || ArrayBuffer.isView(next)
            ? next
            : wrap(next)
        if (result instanceof Promise) {
            const settled = result.then(
                (next) => { assertActive(); return wrapHostValue(next) },
                (error) => { assertActive(); throw error },
            )
            // Host registries (providers, replacers, and similar callbacks)
            // must be able to await revocation instead of assimilating the
            // plugin-facing thenable whose continuations are intentionally
            // suppressed after reset.
            void settled.catch(() => undefined)
            return settled
        }
        return wrapHostValue(result)
    }
    const guardCallback = (callback: any): any => {
        if ((typeof callback !== 'function') && !(callback && typeof callback === 'object')) return callback
        const cached = callbackCache.get(callback)
        if (cached) return cached
        let guarded: any
        if (typeof callback === 'function') {
            guarded = function(this: unknown, ...args: unknown[]) {
                if (!isActive()) return undefined
                return wrapHostCallbackResult(Reflect.apply(callback, wrap(this), args.map((arg) => wrap(arg))))
            }
        } else if (typeof callback.handleEvent === 'function') {
            guarded = {
                handleEvent(event: unknown) {
                    if (!isActive()) return undefined
                    return wrapHostCallbackResult(Reflect.apply(callback.handleEvent, wrap(callback), [wrap(event)]))
                },
            }
        } else return callback
        callbackCache.set(callback, guarded)
        return guarded
    }
    const wrap = (candidate: any, boundThis?: object, property?: PropertyKey): any => {
        if ((typeof candidate !== 'object' || candidate === null) && typeof candidate !== 'function') return candidate
        if (typeof candidate === 'function') {
            const facade = function(this: unknown, ...args: unknown[]) {
                assertActive()
                const receiver: any = boundThis ?? this
                if (new.target) {
                    const guardedArgs = args.map((arg) => typeof arg === 'function' ? guardCallback(arg) : arg)
                    return wrapResult(Reflect.construct(candidate, guardedArgs, new.target === facade ? candidate : new.target))
                }

                if ((property === 'setTimeout' || property === 'setInterval') && receiver && typeof args[0] !== 'function') {
                    throw new TypeError(`${String(property)} requires a function callback`)
                }
                if ((property === 'setTimeout' || property === 'setInterval') && receiver) {
                    const kind = property === 'setTimeout' ? 'timeout' : 'interval'
                    const original = args[0] as Function
                    let record!: { handle: unknown; kind: 'timeout' | 'interval'; cleanup: () => void }
                    const release = () => {
                        const index = timerRecords.indexOf(record)
                        if (index >= 0) timerRecords.splice(index, 1)
                        ownedResources.delete(record.cleanup)
                    }
                    const guarded = function(this: unknown, ...callbackArgs: unknown[]) {
                        if (kind === 'timeout') release()
                        if (!isActive()) return undefined
                        return wrapHostCallbackResult(Reflect.apply(original, wrap(this), callbackArgs.map((arg) => wrap(arg))))
                    }
                    const handle = Reflect.apply(candidate, receiver, [guarded, ...args.slice(1)])
                    const clearName = kind === 'timeout' ? 'clearTimeout' : 'clearInterval'
                    const cleanup = () => {
                        release()
                        const clear = Reflect.get(receiver, clearName, receiver)
                        if (typeof clear === 'function') Reflect.apply(clear, receiver, [handle])
                    }
                    record = { handle, kind, cleanup }
                    timerRecords.push(record)
                    ownedResources.add(cleanup)
                    return handle
                }
                if ((property === 'clearTimeout' || property === 'clearInterval') && receiver) {
                    const kind = property === 'clearTimeout' ? 'timeout' : 'interval'
                    for (const record of [...timerRecords]) {
                        if (record.kind === kind && record.handle === args[0]) record.cleanup()
                    }
                    return undefined
                }
                if (property === 'addEventListener' && receiver && args[1]) {
                    const original = args[1] as object
                    const wrappedListener = guardCallback(original)
                    const type = args[0]
                    const options = args[2]
                    const result = Reflect.apply(candidate, receiver, [type, wrappedListener, options])
                    let record!: { target: object; type: unknown; original: object; capture: boolean; cleanup: () => void }
                    const cleanup = () => {
                        const index = listenerRecords.indexOf(record)
                        if (index >= 0) listenerRecords.splice(index, 1)
                        ownedResources.delete(cleanup)
                        const remove = Reflect.get(receiver, 'removeEventListener', receiver)
                        if (typeof remove === 'function') Reflect.apply(remove, receiver, [type, wrappedListener, options])
                    }
                    record = { target: receiver, type, original, capture: capture(options), cleanup }
                    listenerRecords.push(record)
                    ownedResources.add(cleanup)
                    return wrapResult(result)
                }
                if (property === 'removeEventListener' && receiver && args[1]) {
                    const matching = listenerRecords.filter((record) => record.target === receiver
                        && record.type === args[0] && record.original === args[1] && record.capture === capture(args[2]))
                    for (const record of matching) record.cleanup()
                    return undefined
                }
                // Cleanup callbacks are deliberately invoked after the runtime
                // generation is revoked. Storing a guarded callback here would
                // turn every registered onUnload callback into a no-op.
                if (property === 'onUnload' && receiver) {
                    return wrapResult(Reflect.apply(candidate, receiver, args))
                }
                const guardedArgs = args.map((arg) => typeof arg === 'function' ? guardCallback(arg) : arg)
                return wrapResult(Reflect.apply(candidate, receiver, guardedArgs))
            }
            return facade
        }
        const cached = objectCache.get(candidate)
        if (cached) return cached
        // Use a shadow target so fixed host properties can still be wrapped
        // without violating Proxy invariants or exposing raw host objects.
        const shadow = Array.isArray(candidate) ? [] : Object.create(null)
        const proxy = new Proxy(shadow, {
            get(_target, nextProperty) {
                assertActive()
                if (nextProperty === 'constructor' && !Object.hasOwn(candidate, nextProperty)) return undefined
                const child = Reflect.get(candidate, nextProperty, candidate)
                return wrap(child, typeof child === 'function' ? candidate : undefined, nextProperty)
            },
            set(_target, nextProperty, next) {
                assertActive()
                const guarded = typeof next === 'function'
                    || (next && typeof next === 'object' && typeof next.handleEvent === 'function')
                    ? guardCallback(next)
                    : next
                return Reflect.set(candidate, nextProperty, guarded, candidate)
            },
            defineProperty(_target, nextProperty, descriptor) {
                assertActive()
                if (descriptor.configurable === false) return false
                const guardedDescriptor = { ...descriptor }
                if (Object.hasOwn(guardedDescriptor, 'value')) {
                    const next = guardedDescriptor.value
                    if (typeof next === 'function'
                        || (next && typeof next === 'object' && typeof next.handleEvent === 'function')) {
                        guardedDescriptor.value = guardCallback(next)
                    }
                }
                if (guardedDescriptor.get) guardedDescriptor.get = guardCallback(guardedDescriptor.get)
                if (guardedDescriptor.set) guardedDescriptor.set = guardCallback(guardedDescriptor.set)
                return Reflect.defineProperty(candidate, nextProperty, guardedDescriptor)
            },
            deleteProperty(_target, nextProperty) { assertActive(); return Reflect.deleteProperty(candidate, nextProperty) },
            has(_target, nextProperty) { assertActive(); return Reflect.has(candidate, nextProperty) },
            ownKeys() { assertActive(); return Reflect.ownKeys(candidate) },
            getOwnPropertyDescriptor(_target, nextProperty) {
                assertActive()
                const shadowDescriptor = Reflect.getOwnPropertyDescriptor(shadow, nextProperty)
                if (shadowDescriptor?.configurable === false) return shadowDescriptor
                const descriptor = Reflect.getOwnPropertyDescriptor(candidate, nextProperty)
                if (!descriptor) return undefined
                descriptor.configurable = true
                if (Object.hasOwn(descriptor, 'value')) descriptor.value = wrap(descriptor.value, typeof descriptor.value === 'function' ? candidate : undefined, nextProperty)
                if (descriptor.get) descriptor.get = wrap(descriptor.get, candidate, nextProperty)
                if (descriptor.set) descriptor.set = wrap(descriptor.set, candidate, nextProperty)
                return descriptor
            },
            getPrototypeOf() { assertActive(); return null },
            setPrototypeOf() { assertActive(); return false },
            preventExtensions() { assertActive(); return false },
        })
        objectCache.set(candidate, proxy)
        return proxy
    }
    return wrap(value)
}

export async function resetPluginV2Runtime(
    runtime: PluginV2RuntimeState,
    clearProviderNames: () => void,
    cleanupTimeoutMs = 1000,
) {
    // Invalidate every API closure before user cleanup code can run.
    runtime.generation += 1
    const errors: unknown[] = []
    const cleanupOwnedResources = () => {
        const resources = [...(runtime.ownedResources ?? [])]
        runtime.ownedResources?.clear()
        for (const cleanup of resources) {
            try { cleanup() } catch (error) { errors.push(error) }
        }
    }
    cleanupOwnedResources()
    if (!runtime.loaded) return errors
    const callbacks = [...runtime.unload]
    runtime.unload.clear()
    try {
        if (callbacks.length) {
            const cleanup = Promise.allSettled(callbacks.map((callback) => Promise.resolve().then(callback)))
            let timeout: ReturnType<typeof setTimeout> | undefined
            const timedOut = Symbol('v2-cleanup-timeout')
            const result = await Promise.race([
                cleanup,
                new Promise<typeof timedOut>((resolve) => { timeout = setTimeout(() => resolve(timedOut), cleanupTimeoutMs) }),
            ])
            if (timeout) clearTimeout(timeout)
            if (result === timedOut) errors.push(new Error('V2 unload callback timed out'))
            else for (const settled of result) if (settled.status === 'rejected') errors.push(settled.reason)
        }
    } finally {
        cleanupOwnedResources()
        runtime.unload.clear()
        runtime.providers.clear()
        runtime.providerOptions.clear()
        runtime.editdisplay.clear()
        runtime.editoutput.clear()
        runtime.editprocess.clear()
        runtime.editinput.clear()
        runtime.replacerbeforeRequest.clear()
        runtime.replacerafterRequest.clear()
        clearProviderNames()
    }
    return errors
}
