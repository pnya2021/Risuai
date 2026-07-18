import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'acorn'

import { SandboxHost } from './factory'
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

function createHarness(apiFactory: Record<string, (...args: any[]) => any>, simulateNativeClone = false) {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const host = new SandboxHost(apiFactory)
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
