import type { PluginApiErrorCode, PluginApiErrorShape } from './contracts'

export const PLUGIN_API_ERROR_CODES: readonly PluginApiErrorCode[] = [
  'UNSUPPORTED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'ABORTED',
  'QUOTA_EXCEEDED',
  'RESOURCE_LIMIT',
  'CONFLICT',
  'NETWORK',
  'INTEGRITY_MISMATCH',
  'DECODE_FAILED',
  'PROVIDER_ERROR',
  'INTERNAL',
]

export const INTERNAL_PLUGIN_API_ERROR_MESSAGE = 'Internal plugin API error'

const pluginApiErrorCodes = new Set<string>(PLUGIN_API_ERROR_CODES)
const missingDataProperty = Symbol('missingDataProperty')

const internalPluginApiError = (): PluginApiErrorShape => ({
  name: 'PluginApiError',
  code: 'INTERNAL',
  message: INTERNAL_PLUGIN_API_ERROR_MESSAGE,
  retryable: false,
})

function ownDataProperty(value: object, key: PropertyKey): unknown | typeof missingDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor)) return missingDataProperty
  return descriptor.value
}

function snapshotPluginApiError(value: unknown): PluginApiErrorShape | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined

    const name = ownDataProperty(value, 'name')
    const code = ownDataProperty(value, 'code')
    const message = ownDataProperty(value, 'message')
    const retryable = ownDataProperty(value, 'retryable')
    if (
      name !== 'PluginApiError'
      || typeof code !== 'string'
      || !pluginApiErrorCodes.has(code)
      || typeof message !== 'string'
      || typeof retryable !== 'boolean'
    ) return undefined

    const retryAfterMs = ownDataProperty(value, 'retryAfterMs')
    if (
      retryAfterMs !== missingDataProperty
      && retryAfterMs !== undefined
      && typeof retryAfterMs !== 'number'
    ) return undefined

    const detailsValue = ownDataProperty(value, 'details')
    let details: Record<string, string | number | boolean> | undefined
    if (detailsValue !== missingDataProperty && detailsValue !== undefined) {
      if (!detailsValue || typeof detailsValue !== 'object' || Array.isArray(detailsValue)) return undefined
      details = {}
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(detailsValue))) {
        if (!descriptor.enumerable) continue
        if (!('value' in descriptor)) return undefined
        const detail = descriptor.value
        if (!['string', 'number', 'boolean'].includes(typeof detail)) return undefined
        details[key] = detail as string | number | boolean
      }
    }

    const shape: PluginApiErrorShape = {
      name: 'PluginApiError',
      code: code as PluginApiErrorCode,
      message,
      retryable,
    }
    if (typeof retryAfterMs === 'number') shape.retryAfterMs = retryAfterMs
    if (details !== undefined) shape.details = details
    return shape
  } catch {
    return undefined
  }
}

export class PluginApiError extends Error implements PluginApiErrorShape {
  readonly name = 'PluginApiError' as const
  readonly code: PluginApiErrorCode
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly details?: Record<string, string | number | boolean>

  constructor(
    code: PluginApiErrorCode,
    message: string,
    options: {
      retryable?: boolean
      retryAfterMs?: number
      details?: Record<string, string | number | boolean>
    } = {},
  ) {
    super(message)
    this.code = code
    this.retryable = options.retryable ?? false
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.details !== undefined) this.details = { ...options.details }
  }
}

export function isPluginApiErrorShape(value: unknown): value is PluginApiErrorShape {
  return snapshotPluginApiError(value) !== undefined
}

export function serializePluginApiError(error: unknown): PluginApiErrorShape {
  return snapshotPluginApiError(error) ?? internalPluginApiError()
}

export function deserializePluginApiError(value: unknown): PluginApiError {
  const shape = serializePluginApiError(value)
  return new PluginApiError(shape.code, shape.message, {
    retryable: shape.retryable,
    retryAfterMs: shape.retryAfterMs,
    details: shape.details,
  })
}
