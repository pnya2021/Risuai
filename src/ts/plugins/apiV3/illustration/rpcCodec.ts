function cloneArrayBuffer(buffer: ArrayBuffer, seen: WeakMap<object, any>): ArrayBuffer {
  const cached = seen.get(buffer)
  if (cached) return cached
  const clone = buffer.slice(0)
  seen.set(buffer, clone)
  return clone
}

function cloneArrayBufferView(view: ArrayBufferView<ArrayBuffer>, seen: WeakMap<object, any>): ArrayBufferView<ArrayBuffer> {
  const cached = seen.get(view)
  if (cached) return cached
  const buffer = cloneArrayBuffer(view.buffer, seen)
  const clone = view instanceof DataView
    ? new DataView(buffer, view.byteOffset, view.byteLength)
    : new (view.constructor as any)(buffer, view.byteOffset, (view as any).length)
  seen.set(view, clone)
  return clone
}

export function cloneRpcPayload<T>(value: T, seen = new WeakMap<object, any>()): T {
  if (!value || typeof value !== 'object') return value
  const objectValue = value as object
  const cached = seen.get(objectValue)
  if (cached) return cached

  if (value instanceof ArrayBuffer) return cloneArrayBuffer(value, seen) as T
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    return cloneArrayBufferView(value as ArrayBufferView<ArrayBuffer>, seen) as T
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = []
    seen.set(objectValue, clone)
    for (const item of value) clone.push(cloneRpcPayload(item, seen))
    return clone as T
  }
  if (value instanceof Map) {
    const clone = new Map()
    seen.set(objectValue, clone)
    for (const [key, item] of value) clone.set(cloneRpcPayload(key, seen), cloneRpcPayload(item, seen))
    return clone as T
  }
  if (value instanceof Set) {
    const clone = new Set()
    seen.set(objectValue, clone)
    for (const item of value) clone.add(cloneRpcPayload(item, seen))
    return clone as T
  }
  if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    const clone = Object.create(Object.getPrototypeOf(value))
    seen.set(objectValue, clone)
    for (const [key, item] of Object.entries(value)) clone[key] = cloneRpcPayload(item, seen)
    return clone
  }
  return value
}

function transferableInstance(value: object, name: string) {
  const Constructor = (globalThis as any)[name]
  return typeof Constructor === 'function' && value instanceof Constructor
}

export function collectRpcTransferables(value: unknown): Transferable[] {
  const transferables = new Set<Transferable>()
  const seen = new WeakSet<object>()

  const visit = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return
    if (seen.has(candidate)) return
    seen.add(candidate)

    if (candidate instanceof ArrayBuffer) {
      transferables.add(candidate)
      return
    }
    if (ArrayBuffer.isView(candidate)) {
      if (candidate.buffer instanceof ArrayBuffer) transferables.add(candidate.buffer)
      return
    }
    if (
      transferableInstance(candidate, 'MessagePort')
      || transferableInstance(candidate, 'ImageBitmap')
      || transferableInstance(candidate, 'ReadableStream')
      || transferableInstance(candidate, 'WritableStream')
      || transferableInstance(candidate, 'TransformStream')
      || transferableInstance(candidate, 'OffscreenCanvas')
    ) {
      transferables.add(candidate as Transferable)
      return
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (candidate instanceof Map) {
      for (const [key, item] of candidate) { visit(key); visit(item) }
      return
    }
    if (candidate instanceof Set) {
      candidate.forEach(visit)
      return
    }
    if (Object.getPrototypeOf(candidate) === Object.prototype || Object.getPrototypeOf(candidate) === null) {
      Object.values(candidate).forEach(visit)
    }
  }

  visit(value)
  return [...transferables]
}

export function prepareRpcMessage<T>(message: T): { message: T, transferables: Transferable[] } {
  const clonedMessage = cloneRpcPayload(message)
  return {
    message: clonedMessage,
    transferables: collectRpcTransferables(clonedMessage),
  }
}

export const GUEST_RPC_CODEC_SCRIPT = String.raw`
    const rpcOwnedTransfers = new WeakSet();
    const rpcOwnedTransferAdd = WeakSet.prototype.add;
    const rpcOwnedTransferHas = WeakSet.prototype.has;
    const rpcReflectApply = Reflect.apply;

    function rpcMarkOwnedTransfer(value) {
        rpcReflectApply(rpcOwnedTransferAdd, rpcOwnedTransfers, [value]);
        return value;
    }

    function rpcIsOwnedTransfer(value) {
        return rpcReflectApply(rpcOwnedTransferHas, rpcOwnedTransfers, [value]);
    }

    function rpcClonePayload(value, seen = new WeakMap()) {
        if (!value || typeof value !== 'object') return value;
        if (seen.has(value)) return seen.get(value);
        if (rpcIsOwnedTransfer(value)) {
            seen.set(value, value);
            return value;
        }
        if (value instanceof ArrayBuffer) {
            const clone = value.slice(0);
            seen.set(value, clone);
            return clone;
        }
        if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
            let buffer = seen.get(value.buffer);
            if (!buffer) {
                buffer = value.buffer.slice(0);
                seen.set(value.buffer, buffer);
            }
            const clone = value instanceof DataView
                ? new DataView(buffer, value.byteOffset, value.byteLength)
                : new value.constructor(buffer, value.byteOffset, value.length);
            seen.set(value, clone);
            return clone;
        }
        if (Array.isArray(value)) {
            const clone = [];
            seen.set(value, clone);
            for (const item of value) clone.push(rpcClonePayload(item, seen));
            return clone;
        }
        if (value instanceof Map) {
            const clone = new Map();
            seen.set(value, clone);
            for (const [key, item] of value) clone.set(rpcClonePayload(key, seen), rpcClonePayload(item, seen));
            return clone;
        }
        if (value instanceof Set) {
            const clone = new Set();
            seen.set(value, clone);
            for (const item of value) clone.add(rpcClonePayload(item, seen));
            return clone;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype === Object.prototype || prototype === null) {
            const clone = Object.create(prototype);
            seen.set(value, clone);
            for (const [key, item] of Object.entries(value)) clone[key] = rpcClonePayload(item, seen);
            return clone;
        }
        return value;
    }

    function rpcCollectTransferables(value) {
        const transferables = new Set();
        const seen = new WeakSet();
        const isInstance = (candidate, name) => {
            const Constructor = globalThis[name];
            return typeof Constructor === 'function' && candidate instanceof Constructor;
        };
        const visit = (candidate) => {
            if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) return;
            seen.add(candidate);
            if (candidate instanceof ArrayBuffer) {
                transferables.add(candidate);
                return;
            }
            if (ArrayBuffer.isView(candidate)) {
                if (candidate.buffer instanceof ArrayBuffer) transferables.add(candidate.buffer);
                return;
            }
            if (['MessagePort', 'ImageBitmap', 'ReadableStream', 'WritableStream', 'TransformStream', 'OffscreenCanvas']
                .some((name) => isInstance(candidate, name))) {
                transferables.add(candidate);
                return;
            }
            if (Array.isArray(candidate)) return candidate.forEach(visit);
            if (candidate instanceof Map) {
                for (const [key, item] of candidate) { visit(key); visit(item); }
                return;
            }
            if (candidate instanceof Set) return candidate.forEach(visit);
            const prototype = Object.getPrototypeOf(candidate);
            if (prototype === Object.prototype || prototype === null) Object.values(candidate).forEach(visit);
        };
        visit(value);
        return [...transferables];
    }

    function rpcPrepareMessage(message) {
        const clonedMessage = rpcClonePayload(message);
        return { message: clonedMessage, transferables: rpcCollectTransferables(clonedMessage) };
    }
`
