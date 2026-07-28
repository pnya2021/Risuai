import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'acorn'

import { cancelSandboxCallbackInvocation, invokeSandboxCleanupCallback, SandboxHost } from './factory'
import { serializePluginApiError } from './illustration/errors'

vi.stubGlobal('ImageBitmap', class ImageBitmap {})

type PostedMessage = {
  message: any
  transferCount: number
}

const cleanups: Array<() => void> = []

const completePluginError = {
  name: 'PluginApiError',
  code: 'NETWORK',
  message: 'temporary upstream failure',
  retryable: true,
  retryAfterMs: 1_250,
  details: {
    provider: 'example',
    attempt: 2,
    cached: false,
  },
} as const

const internalPluginError = {
  name: 'PluginApiError',
  code: 'INTERNAL',
  message: 'Internal plugin API error',
  retryable: false,
} as const

function createHarness(
  apiFactory: Record<string, (...args: any[]) => any>,
  simulateNativeClone = false,
  authorizeRequest: () => boolean = () => true,
  onAuthorizationFailure: () => void = () => undefined,
  authorizeCallback: () => boolean = authorizeRequest,
) {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const host = new SandboxHost(apiFactory, authorizeRequest, onAuthorizationFailure, authorizeCallback)
  const cleanup = host.run(iframe, '')
  cleanups.push(cleanup)

  const posted: PostedMessage[] = []
  const contentWindow = iframe.contentWindow!
  vi.spyOn(contentWindow, 'postMessage').mockImplementation(((message: any, _target: any, transferOrOptions?: any) => {
    const transfer = Array.isArray(transferOrOptions)
      ? transferOrOptions
      : (transferOrOptions?.transfer ?? [])
    posted.push({
      message: simulateNativeClone
        ? structuredClone(message, { transfer })
        : message,
      transferCount: transfer.length,
    })
  }) as typeof contentWindow.postMessage)

  const dispatch = (data: any) => {
    window.dispatchEvent(new MessageEvent('message', {
      data,
      source: contentWindow as unknown as MessageEventSource,
    }))
  }

  return { contentWindow, dispatch, host, iframe, posted }
}

async function postedMessage(posted: PostedMessage[], type: string, reqId?: string) {
  let match: PostedMessage | undefined
  await vi.waitFor(() => {
    match = posted.find((entry) => entry.message?.type === type && (!reqId || entry.message.reqId === reqId))
    expect(match).toBeDefined()
  })
  return match!
}

function shapeError(shape = completePluginError) {
  return Object.assign(new Error(shape.message), shape)
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('SandboxHost structured errors', () => {
  it('emits a syntactically valid guest bootstrap script', () => {
    const { iframe } = createHarness({})
    const parsed = new DOMParser().parseFromString(iframe.srcdoc, 'text/html')
    const script = parsed.querySelector('script')?.textContent ?? ''
    expect(script.length).toBeGreaterThan(0)
    try {
      parse(script, { ecmaVersion: 'latest' })
    } catch (error: any) {
      const line = error.loc?.line ?? 1
      const context = script.split('\n').slice(Math.max(0, line - 3), line + 2)
        .map((value, index) => `${Math.max(1, line - 2) + index}: ${value}`).join('\n')
      throw new Error(`${error.message}\n${context}`)
    }
  })

  it('installs the nativeFetch guest codec before plugin code can send DOM-only bodies', () => {
    const { iframe } = createHarness({ nativeFetch: vi.fn() })
    const parsed = new DOMParser().parseFromString(iframe.srcdoc, 'text/html')
    const script = parsed.querySelector('script')?.textContent ?? ''
    expect(script).toContain('normalizeGuestNativeFetch')
    expect(script).toContain("propertyCache.set('nativeFetch'")
    expect(script).toContain('ReadableStream bodies are not supported')
    expect(script).toContain('rpcMarkOwnedTransfer')
    expect(script).toContain('rpcIsOwnedTransfer(value)')
  })

  it('requires an authorized READY/START gate and rejects stale post-start host mutations', async () => {
    let current = true
    const mutate = vi.fn()
    const authorizationFailed = vi.fn()
    const { dispatch, iframe, posted } = createHarness(
      { mutate }, false, () => current, authorizationFailed,
    )

    expect(iframe.srcdoc).toContain("window.parent.postMessage({ type: 'READY' }")
    expect(iframe.srcdoc).toContain("event.data.type !== 'START'")
    dispatch({ type: 'READY' })
    await postedMessage(posted, 'START')

    current = false
    dispatch({ type: 'CALL_ROOT', reqId: 'stale-mutation', method: 'mutate', args: [] })
    await vi.waitFor(() => expect(authorizationFailed).toHaveBeenCalledOnce())
    expect(mutate).not.toHaveBeenCalled()
    expect(iframe.isConnected).toBe(false)
  })

  it('aborts a registered guest callback when the same-principal script becomes stale after START', async () => {
    let current = true
    let registered!: () => Promise<unknown>
    const authorizationFailed = vi.fn()
    const { dispatch, posted } = createHarness({
      register: (callback: () => Promise<unknown>) => { registered = callback },
    }, false, () => current, authorizationFailed)

    dispatch({ type: 'READY' })
    await postedMessage(posted, 'START')
    dispatch({
      type: 'CALL_ROOT', reqId: 'register-provider-callback', method: 'register',
      args: [{ __type: 'CALLBACK_REF', id: 'provider-callback' }],
    })
    await postedMessage(posted, 'RESPONSE', 'register-provider-callback')

    current = false
    await expect(registered()).rejects.toMatchObject({ code: 'ABORTED' })
    expect(authorizationFailed).toHaveBeenCalledOnce()
    expect(posted.some((entry) => entry.message.type === 'INVOKE_CALLBACK')).toBe(false)
  })

  it('still lets the host invoke and settle the designated cleanup callback after abort', async () => {
    let active = true
    let registered!: () => Promise<unknown>
    const { dispatch, posted } = createHarness({
      register: (callback: () => Promise<unknown>) => { registered = callback },
    }, false, () => active, vi.fn())
    dispatch({ type: 'CALL_ROOT', reqId: 'register-cleanup', method: 'register', args: [{ __type: 'CALLBACK_REF', id: 'cleanup' }] })
    await postedMessage(posted, 'RESPONSE', 'register-cleanup')

    active = false
    const cleanup = invokeSandboxCleanupCallback(registered)
    const invocation = await postedMessage(posted, 'INVOKE_CALLBACK')
    dispatch({ type: 'CALLBACK_RETURN', reqId: invocation.message.reqId, result: 'clean' })
    await expect(cleanup).resolves.toBe('clean')
  })

  it('invokes a designated cleanup callback at most once', async () => {
    let active = true
    let registered!: () => Promise<unknown>
    const { dispatch, posted } = createHarness({
      register: (callback: () => Promise<unknown>) => { registered = callback },
    }, false, () => active, vi.fn())
    dispatch({ type: 'CALL_ROOT', reqId: 'register-one-shot', method: 'register', args: [{ __type: 'CALLBACK_REF', id: 'cleanup-one-shot' }] })
    await postedMessage(posted, 'RESPONSE', 'register-one-shot')

    active = false
    const first = invokeSandboxCleanupCallback(registered)
    const invocation = await postedMessage(posted, 'INVOKE_CALLBACK')
    dispatch({ type: 'CALLBACK_RETURN', reqId: invocation.message.reqId, result: 'done' })
    await expect(first).resolves.toBe('done')
    await expect(invokeSandboxCleanupCallback(registered)).resolves.toBeUndefined()
    expect(posted.filter((entry) => entry.message.type === 'INVOKE_CALLBACK')).toHaveLength(1)
  })

  it.each(['CALL_ROOT', 'CALL_INSTANCE'] as const)(
    'blocks %s emitted by an after-abort cleanup and settles it as ABORTED',
    async (callType) => {
      let active = true
      let registered!: () => Promise<unknown>
      const mutate = vi.fn()
      const authorizationFailed = vi.fn()
      const { dispatch, iframe, posted } = createHarness({
        register: (callback: () => Promise<unknown>) => { registered = callback },
        mutate,
        make: () => ({ mutate }),
      }, false, () => active, authorizationFailed)
      dispatch({ type: 'CALL_ROOT', reqId: 'register-cleanup-api', method: 'register', args: [{ __type: 'CALLBACK_REF', id: 'cleanup-api' }] })
      await postedMessage(posted, 'RESPONSE', 'register-cleanup-api')

      let instanceId: string | undefined
      if (callType === 'CALL_INSTANCE') {
        dispatch({ type: 'CALL_ROOT', reqId: 'make-instance', method: 'make', args: [] })
        const response = await postedMessage(posted, 'RESPONSE', 'make-instance')
        instanceId = response.message.result.id
      }

      active = false
      const cleanup = invokeSandboxCleanupCallback(registered)
      await postedMessage(posted, 'INVOKE_CALLBACK')
      dispatch(callType === 'CALL_ROOT'
        ? { type: 'CALL_ROOT', reqId: 'cleanup-mutation', method: 'mutate', args: [] }
        : { type: 'CALL_INSTANCE', reqId: 'cleanup-mutation', id: instanceId, method: 'mutate', args: [] })

      await expect(cleanup).rejects.toMatchObject({ code: 'ABORTED' })
      expect(mutate).not.toHaveBeenCalled()
      expect(authorizationFailed).toHaveBeenCalledOnce()
      expect(iframe.isConnected).toBe(false)
    },
  )

  it('rejects an in-flight normal callback return that becomes stale after invocation', async () => {
    let active = true
    let registered!: () => Promise<unknown>
    const authorizationFailed = vi.fn()
    const { dispatch, posted } = createHarness({
      register: (callback: () => Promise<unknown>) => { registered = callback },
    }, false, () => active, authorizationFailed)
    dispatch({ type: 'CALL_ROOT', reqId: 'register-in-flight', method: 'register', args: [{ __type: 'CALLBACK_REF', id: 'in-flight' }] })
    await postedMessage(posted, 'RESPONSE', 'register-in-flight')
    const result = registered()
    const invocation = await postedMessage(posted, 'INVOKE_CALLBACK')
    active = false
    dispatch({ type: 'CALLBACK_RETURN', reqId: invocation.message.reqId, result: 'stale' })
    await expect(result).rejects.toMatchObject({ code: 'ABORTED' })
    expect(authorizationFailed).toHaveBeenCalledOnce()
  })

  it('rechecks exact authorization after an awaited host API call before retaining or returning its result', async () => {
    let current = true
    let resolveCall!: (value: string) => void
    const call = new Promise<string>((resolve) => { resolveCall = resolve })
    const authorizationFailed = vi.fn()
    const { dispatch, iframe, posted } = createHarness({ delayed: () => call }, false, () => current, authorizationFailed)
    dispatch({ type: 'CALL_ROOT', reqId: 'delayed', method: 'delayed', args: [] })
    current = false
    resolveCall('stale-result')

    await vi.waitFor(() => expect(authorizationFailed).toHaveBeenCalledOnce())
    expect(posted.some((entry) => entry.message.reqId === 'delayed')).toBe(false)
    expect(iframe.isConnected).toBe(false)
  })

  it('preserves every PluginApiError field in RESPONSE messages', async () => {
    const { dispatch, posted } = createHarness({
      fail: () => { throw shapeError() },
    })

    dispatch({ type: 'CALL_ROOT', reqId: 'known-error', method: 'fail', args: [] })

    const response = await postedMessage(posted, 'RESPONSE', 'known-error')
    expect(response.message.error).toEqual(completePluginError)
  })

  it('preserves every PluginApiError field across CALLBACK_RETURN', async () => {
    const { dispatch, posted } = createHarness({
      invoke: async (callback: () => Promise<unknown>) => callback(),
    })

    dispatch({
      type: 'CALL_ROOT',
      reqId: 'callback-error',
      method: 'invoke',
      args: [{ __type: 'CALLBACK_REF', id: 'callback-1' }],
    })
    const invocation = await postedMessage(posted, 'INVOKE_CALLBACK')
    dispatch({
      type: 'CALLBACK_RETURN',
      reqId: invocation.message.reqId,
      error: completePluginError,
    })

    const response = await postedMessage(posted, 'RESPONSE', 'callback-error')
    expect(response.message.error).toEqual(completePluginError)
  })

  it('redacts unexpected exceptions as non-retryable INTERNAL errors', async () => {
    const sentinel = 'HOST_EXCEPTION_SENTINEL_DO_NOT_EXPOSE'
    const { dispatch, posted } = createHarness({
      fail: () => { throw new Error(sentinel) },
    })

    dispatch({ type: 'CALL_ROOT', reqId: 'internal-error', method: 'fail', args: [] })

    const response = await postedMessage(posted, 'RESPONSE', 'internal-error')
    expect(response.message.error).toEqual(internalPluginError)
    expect(JSON.stringify(response.message)).not.toContain(sentinel)
  })

  it('normalizes error values without invoking accessors or propagating descriptor traps', () => {
    let getterCalls = 0
    const accessorError = Object.create(null)
    Object.defineProperty(accessorError, 'name', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        throw new Error('accessor must not run')
      },
    })
    const trappedError = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new Error('descriptor trap') },
    })

    expect(serializePluginApiError(accessorError)).toEqual(internalPluginError)
    expect(getterCalls).toBe(0)
    expect(serializePluginApiError(trappedError)).toEqual(internalPluginError)
  })

  it('settles host API failures as INTERNAL when the thrown value cannot be inspected', async () => {
    const uninspectable = new Proxy({}, {
      get: () => { throw new Error('get trap') },
      getOwnPropertyDescriptor: () => { throw new Error('descriptor trap') },
    })
    const { dispatch, posted } = createHarness({
      fail: () => { throw uninspectable },
    })

    dispatch({ type: 'CALL_ROOT', reqId: 'uninspectable-host-error', method: 'fail', args: [] })

    const response = await postedMessage(posted, 'RESPONSE', 'uninspectable-host-error')
    expect(response.message.error).toEqual(internalPluginError)
  })
})

describe('SandboxHost binary RPC safety', () => {
  it('clones caller buffers, deduplicates duplicate views, and preserves view boundaries', async () => {
    const callerBytes = new Uint8Array([10, 20, 30, 40, 50, 60])
    const exactView = new Uint8Array(callerBytes.buffer, 2, 3)
    const { dispatch, posted } = createHarness({
      bytes: () => ({ first: exactView, duplicate: exactView }),
    }, true)

    dispatch({ type: 'CALL_ROOT', reqId: 'binary-result', method: 'bytes', args: [] })

    const response = await postedMessage(posted, 'RESPONSE', 'binary-result')
    expect(response.transferCount).toBe(1)
    expect(response.message.result.first).toBeInstanceOf(Uint8Array)
    expect(response.message.result.first).not.toBe(exactView)
    expect(response.message.result.first.buffer).toBe(response.message.result.duplicate.buffer)
    expect(response.message.result.first.byteOffset).toBe(2)
    expect(response.message.result.first.byteLength).toBe(3)
    expect(Array.from(response.message.result.first)).toEqual([30, 40, 50])
    expect(Array.from(callerBytes)).toEqual([10, 20, 30, 40, 50, 60])
  })

  it.each(['success', 'rejection'] as const)('keeps host callback buffers readable after callback %s', async (outcome) => {
    const callerBytes = new Uint8Array([7, 8, 9, 10])
    const { dispatch, posted } = createHarness({
      invoke: async (callback: (bytes: Uint8Array) => Promise<unknown>) => callback(callerBytes),
    }, true)

    dispatch({
      type: 'CALL_ROOT',
      reqId: `callback-${outcome}`,
      method: 'invoke',
      args: [{ __type: 'CALLBACK_REF', id: `callback-${outcome}` }],
    })
    const invocation = await postedMessage(posted, 'INVOKE_CALLBACK')
    dispatch(outcome === 'success'
      ? { type: 'CALLBACK_RETURN', reqId: invocation.message.reqId, result: 'ok' }
      : { type: 'CALLBACK_RETURN', reqId: invocation.message.reqId, error: completePluginError })
    await postedMessage(posted, 'RESPONSE', `callback-${outcome}`)

    expect(Array.from(callerBytes)).toEqual([7, 8, 9, 10])
  })
})

describe('SandboxHost callback and teardown lifecycle', () => {
  it('cancels exactly one pending callback invocation without releasing its registration', async () => {
    let callback!: (() => Promise<unknown>) & { release: () => void }
    const { dispatch, host, posted } = createHarness({
      capture: (received: typeof callback) => { callback = received },
    })
    dispatch({
      type: 'CALL_ROOT', reqId: 'capture-cancellable', method: 'capture',
      args: [{ __type: 'CALLBACK_REF', id: 'cancellable-callback' }],
    })
    await postedMessage(posted, 'RESPONSE', 'capture-cancellable')

    const invocation = callback()
    const request = await postedMessage(posted, 'INVOKE_CALLBACK')
    expect(cancelSandboxCallbackInvocation(invocation)).toBe(true)
    await expect(invocation).rejects.toMatchObject({ name: 'PluginApiError', code: 'ABORTED' })
    expect(cancelSandboxCallbackInvocation(invocation)).toBe(false)
    expect((host as any).callbackWrapperCache.has('cancellable-callback')).toBe(true)

    dispatch({ type: 'CALLBACK_RETURN', reqId: request.message.reqId, result: 'late' })
    callback.release()
    expect((host as any).callbackWrapperCache.has('cancellable-callback')).toBe(false)
  })

  it('reference-counts callback registrations and releases only the final host wrapper reference', async () => {
    let callbacks: Array<(() => Promise<unknown>) & { release?: () => void }> = []
    const { dispatch, host, posted } = createHarness({
      register: (...received: typeof callbacks) => { callbacks = received },
    })

    dispatch({
      type: 'CALL_ROOT',
      reqId: 'register-callbacks',
      method: 'register',
      args: [
        { __type: 'CALLBACK_REF', id: 'shared-callback' },
        { __type: 'CALLBACK_REF', id: 'shared-callback' },
      ],
    })
    await postedMessage(posted, 'RESPONSE', 'register-callbacks')

    expect(callbacks[0]).toBe(callbacks[1])
    expect(callbacks[0].release).toBeTypeOf('function')
    callbacks[0].release!()
    expect((host as any).callbackWrapperCache.size).toBe(1)
    callbacks[1].release!()
    expect((host as any).callbackWrapperCache.size).toBe(0)
    expect(posted.filter((entry) => entry.message.type === 'RELEASE_CALLBACK')).toHaveLength(2)
  })

  it('does not let a stale wrapper release a newer registration with the same callback ID', async () => {
    const registrations: Array<(() => Promise<unknown>) & { release: () => void }> = []
    const { dispatch, host, posted } = createHarness({
      register: (callback: (() => Promise<unknown>) & { release: () => void }) => {
        registrations.push(callback)
      },
    })

    dispatch({
      type: 'CALL_ROOT',
      reqId: 'register-old-wrapper',
      method: 'register',
      args: [{ __type: 'CALLBACK_REF', id: 'reused-callback' }],
    })
    await postedMessage(posted, 'RESPONSE', 'register-old-wrapper')
    const oldWrapper = registrations[0]
    oldWrapper.release()

    dispatch({
      type: 'CALL_ROOT',
      reqId: 'register-new-wrapper',
      method: 'register',
      args: [{ __type: 'CALLBACK_REF', id: 'reused-callback' }],
    })
    await postedMessage(posted, 'RESPONSE', 'register-new-wrapper')
    const newWrapper = registrations[1]
    expect(newWrapper).not.toBe(oldWrapper)

    oldWrapper.release()
    expect((host as any).callbackWrapperCache.get('reused-callback')).toMatchObject({
      wrapper: newWrapper,
      refCount: 1,
    })
    expect(posted.filter((entry) => entry.message.type === 'RELEASE_CALLBACK')).toHaveLength(1)

    newWrapper.release()
    expect((host as any).callbackWrapperCache.has('reused-callback')).toBe(false)
    expect(posted.filter((entry) => entry.message.type === 'RELEASE_CALLBACK')).toHaveLength(2)
  })

  it('does not serialize or retain an API result that completes after terminate', async () => {
    let resolveResult!: (value: unknown) => void
    const deferredResult = new Promise((resolve) => { resolveResult = resolve })
    const { dispatch, host, posted } = createHarness({
      deferred: () => deferredResult,
    })

    dispatch({ type: 'CALL_ROOT', reqId: 'late-result', method: 'deferred', args: [] })
    host.terminate()
    resolveResult({ __classType: 'REMOTE_REQUIRED' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((host as any).instanceRegistry.size).toBe(0)
    expect(posted.filter((entry) => entry.message.type === 'RESPONSE' && entry.message.reqId === 'late-result')).toHaveLength(0)
  })

  it('removes listeners, aborts controllers, and rejects all pending host promises on terminate', async () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    let callback: undefined | (() => Promise<unknown>)
    let hostSignal: AbortSignal | undefined
    const { dispatch, host, posted } = createHarness({
      capture: (received: () => Promise<unknown>) => { callback = received },
      holdUntilAbort: ({ signal }: { signal: AbortSignal }) => new Promise((resolve) => {
        hostSignal = signal
        signal.addEventListener('abort', () => resolve('aborted'), { once: true })
      }),
    })

    dispatch({
      type: 'CALL_ROOT', reqId: 'capture', method: 'capture',
      args: [{ __type: 'CALLBACK_REF', id: 'pending-callback' }],
    })
    await postedMessage(posted, 'RESPONSE', 'capture')
    const callbackOutcome = callback!().then(
      () => ({ status: 'resolved' as const }),
      (error) => ({ status: 'rejected' as const, error }),
    )
    await postedMessage(posted, 'INVOKE_CALLBACK')

    dispatch({
      type: 'CALL_ROOT', reqId: 'abort', method: 'holdUntilAbort',
      args: [{ signal: { __type: 'ABORT_SIGNAL_REF', abortId: 'abort-on-unload', aborted: false } }],
    })
    await vi.waitFor(() => expect(hostSignal).toBeDefined())

    const executionOutcome = host.executeInIframe('await new Promise(() => {})').then(
      () => ({ status: 'resolved' as const }),
      (error) => ({ status: 'rejected' as const, error }),
    )
    host.terminate()

    const timeout = () => new Promise<{ status: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ status: 'timeout' }), 100)
    })
    const callbackResult = await Promise.race([callbackOutcome, timeout()])
    const executionResult = await Promise.race([executionOutcome, timeout()])
    expect(callbackResult).toMatchObject({ status: 'rejected', error: { name: 'PluginApiError', code: 'ABORTED' } })
    expect(executionResult).toMatchObject({ status: 'rejected', error: { name: 'PluginApiError', code: 'ABORTED' } })
    expect(hostSignal?.aborted).toBe(true)
    expect((host as any).pendingCallbacks.size).toBe(0)
    expect((host as any).abortControllers.size).toBe(0)
    expect((host as any).callbackWrapperCache.size).toBe(0)

    const messageListeners = addListener.mock.calls
      .filter(([type]) => type === 'message')
      .map(([, listener]) => listener)
    for (const listener of messageListeners) {
      expect(removeListener).toHaveBeenCalledWith('message', listener)
    }
  })

  it('logs bounded RPC metadata without request secrets or byte contents', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const sentinel = 'RPC_LOG_SECRET_SENTINEL_5c0f90'
    const bytes = new Uint8Array([222, 173, 190, 239])
    const { dispatch, posted } = createHarness({ echo: (...args: unknown[]) => args.length })

    dispatch({ type: 'CALL_ROOT', reqId: 'safe-log', method: 'echo', args: [sentinel, bytes] })
    await postedMessage(posted, 'RESPONSE', 'safe-log')
    dispatch({ type: sentinel, reqId: 'unrecognized-type' })

    const renderedCalls = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((call) =>
      call.map((value) => {
        if (typeof value === 'string') return value
        try { return JSON.stringify(value) } catch { return String(value) }
      }).join(' '),
    )
    expect(renderedCalls.join('\n')).not.toContain(sentinel)
    expect(renderedCalls.join('\n')).not.toContain('"0":222')
    expect(renderedCalls.every((entry) => entry.length <= 500)).toBe(true)
  })
})
