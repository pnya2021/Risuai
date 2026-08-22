import type { PluginApiErrorShape } from './illustration/contracts'
import {
    deserializePluginApiError,
    PluginApiError,
    serializePluginApiError,
} from './illustration/errors'
import { GUEST_RPC_CODEC_SCRIPT, prepareRpcMessage } from './illustration/rpcCodec'
import {
    takeStudioCardRpcFinalizer,
    type StudioCardRpcFinalizer,
} from './studioCardRpcTransport'

type MsgType =
    | 'CALL_ROOT'
    | 'CALL_INSTANCE'
    | 'INVOKE_CALLBACK'
    | 'CALLBACK_RETURN'
    | 'RESPONSE'
    | 'RELEASE_INSTANCE'
    | 'RELEASE_CALLBACK'
    | 'ABORT_SIGNAL'
    | 'EXECUTE_CODE'
    | 'EXEC_RESULT'
    | 'READY'
    | 'START'
    | 'TERMINATE'
    | 'TERMINATE_ACK';

const RPC_MESSAGE_TYPES = new Set<string>([
    'CALL_ROOT', 'CALL_INSTANCE', 'INVOKE_CALLBACK', 'CALLBACK_RETURN',
    'RESPONSE', 'RELEASE_INSTANCE', 'RELEASE_CALLBACK', 'ABORT_SIGNAL',
    'EXECUTE_CODE', 'EXEC_RESULT', 'READY', 'START', 'TERMINATE', 'TERMINATE_ACK'
]);

const rpcLogType = (value: unknown) =>
    typeof value === 'string' && RPC_MESSAGE_TYPES.has(value) ? value : 'UNKNOWN';

interface RpcMessage {
    type: MsgType;
    reqId?: string;
    id?: string;
    method?: string;
    args?: any[];
    result?: any;
    error?: PluginApiErrorShape;
    abortId?: string;
}

interface RemoteRef {
    __type: 'REMOTE_REF';
    id: string;
}

interface CallbackRef {
    __type: 'CALLBACK_REF';
    id: string;
}

interface AbortSignalRef {
    __type: 'ABORT_SIGNAL_REF';
    abortId: string;
    aborted: boolean;
}

const CLEANUP_CALLBACK_INVOKER = Symbol('cleanupCallbackInvoker')
const invokedCleanupCallbacks = new WeakSet<Function>()
const sandboxCallbackInvocationCancellations = new WeakMap<object, () => boolean>()
type CallbackWrapper = ((...args: any[]) => Promise<any>) & {
    release: () => void
    [CLEANUP_CALLBACK_INVOKER]: (...args: any[]) => Promise<any>
};

export function invokeSandboxCleanupCallback(callback: (...args: any[]) => unknown, ...args: any[]) {
    const wrapper = callback as CallbackWrapper
    if (typeof wrapper[CLEANUP_CALLBACK_INVOKER] !== 'function') return Promise.resolve()
    if (invokedCleanupCallbacks.has(wrapper)) return Promise.resolve()
    invokedCleanupCallbacks.add(wrapper)
    return wrapper[CLEANUP_CALLBACK_INVOKER](...args)
}

/** Rejects one in-flight guest callback RPC without releasing its shared callback registration. */
export function cancelSandboxCallbackInvocation(invocation: unknown) {
    if ((typeof invocation !== 'object' && typeof invocation !== 'function') || invocation === null) return false
    return sandboxCallbackInvocationCancellations.get(invocation)?.() ?? false
}

interface CallbackWrapperEntry {
    wrapper: CallbackWrapper;
    refCount: number;
}

const NESTED_WORKER_GUARD_SOURCE = `
(() => {
    const deny = (name) => {
        const error = new Error(name + ' is unavailable inside a plugin Worker');
        error.name = 'PluginApiError';
        error.code = 'UNSUPPORTED';
        error.retryable = false;
        throw error;
    };
    function Worker() { deny('Worker'); }
    function SharedWorker() { deny('SharedWorker'); }
    Object.freeze(Worker.prototype);
    Object.freeze(SharedWorker.prototype);
    Object.freeze(Worker);
    Object.freeze(SharedWorker);
    Object.defineProperty(globalThis, 'Worker', { value: Worker, writable: false, configurable: false });
    Object.defineProperty(globalThis, 'SharedWorker', { value: SharedWorker, writable: false, configurable: false });
})();
`;


const GUEST_BRIDGE_SCRIPT = `
await (async function() {
    const pendingRequests = new Map();
    const callbackRegistry = new Map();
    const callbackIdByFunction = new WeakMap();
    const callbackRefCounts = new Map();
    const proxyRefRegistry = new Map();
    const abortControllers = new Map();

    const pluginApiErrorCodes = new Set([
        'UNSUPPORTED', 'PERMISSION_DENIED', 'NOT_FOUND', 'INVALID_ARGUMENT',
        'ABORTED', 'QUOTA_EXCEEDED', 'RESOURCE_LIMIT', 'CONFLICT', 'NETWORK',
        'INTEGRITY_MISMATCH', 'DECODE_FAILED', 'PROVIDER_ERROR', 'INTERNAL'
    ]);
    const missingErrorDataProperty = Symbol('missingErrorDataProperty');
    const nativeObjectEntries = Object.entries;
    const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const nativeObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
    const nativeArrayIsArray = Array.isArray;

    function internalPluginError() {
        return { name: 'PluginApiError', code: 'INTERNAL', message: 'Internal plugin API error', retryable: false };
    }

    function ownErrorDataProperty(value, key) {
        const descriptor = nativeObjectGetOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) return missingErrorDataProperty;
        return descriptor.value;
    }

    function snapshotPluginError(value) {
        try {
            if (!value || typeof value !== 'object') return null;

            const name = ownErrorDataProperty(value, 'name');
            const code = ownErrorDataProperty(value, 'code');
            const message = ownErrorDataProperty(value, 'message');
            const retryable = ownErrorDataProperty(value, 'retryable');
            if (name !== 'PluginApiError'
                || typeof code !== 'string'
                || !pluginApiErrorCodes.has(code)
                || typeof message !== 'string'
                || typeof retryable !== 'boolean') return null;

            const retryAfterMs = ownErrorDataProperty(value, 'retryAfterMs');
            if (retryAfterMs !== missingErrorDataProperty
                && retryAfterMs !== undefined
                && typeof retryAfterMs !== 'number') return null;

            const detailsValue = ownErrorDataProperty(value, 'details');
            let details;
            if (detailsValue !== missingErrorDataProperty && detailsValue !== undefined) {
                if (!detailsValue || typeof detailsValue !== 'object' || nativeArrayIsArray(detailsValue)) return null;
                details = {};
                const descriptors = nativeObjectGetOwnPropertyDescriptors(detailsValue);
                for (const [key, descriptor] of nativeObjectEntries(descriptors)) {
                    if (!descriptor.enumerable) continue;
                    if (!('value' in descriptor)) return null;
                    const detail = descriptor.value;
                    if (!['string', 'number', 'boolean'].includes(typeof detail)) return null;
                    details[key] = detail;
                }
            }

            const shape = { name: 'PluginApiError', code, message, retryable };
            if (retryAfterMs !== missingErrorDataProperty && retryAfterMs !== undefined) {
                shape.retryAfterMs = retryAfterMs;
            }
            if (details !== undefined) shape.details = details;
            return shape;
        } catch {
            return null;
        }
    }

    function isPluginApiErrorShape(value) {
        return snapshotPluginError(value) !== null;
    }

    function serializePluginError(error) {
        return snapshotPluginError(error) || internalPluginError();
    }

    function deserializePluginError(value) {
        const shape = serializePluginError(value);
        const error = new Error(shape.message);
        error.name = 'PluginApiError';
        error.code = shape.code;
        error.retryable = shape.retryable;
        if (shape.retryAfterMs !== undefined) error.retryAfterMs = shape.retryAfterMs;
        if (shape.details !== undefined) error.details = { ...shape.details };
        return error;
    }

    function makePluginError(code, message, details) {
        return deserializePluginError({
            name: 'PluginApiError',
            code,
            message,
            retryable: false,
            ...(details ? { details } : {})
        });
    }

    ${GUEST_RPC_CODEC_SCRIPT}

    const NativeWorker = globalThis.Worker;
    const NativeBlob = globalThis.Blob;
    const NativeHeaders = globalThis.Headers;
    const NativeFormData = globalThis.FormData;
    const NativeURLSearchParams = globalThis.URLSearchParams;
    const NativeRequest = globalThis.Request;
    const NativeReadableStream = globalThis.ReadableStream;
    const NativeEventTarget = globalThis.EventTarget;
    const NativeMessageEvent = globalThis.MessageEvent;
    const NativeErrorEvent = globalThis.ErrorEvent;
    const NativeUint32Array = globalThis.Uint32Array;
    const NativeMap = globalThis.Map;
    const NativeWeakMap = globalThis.WeakMap;
    const NativeSet = globalThis.Set;
    const nativeReflectApply = Reflect.apply;
    const nativeJsonStringify = JSON.stringify;
    const nativeNumberToString = Number.prototype.toString;
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const nativeGetRandomValues = globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function'
        ? globalThis.crypto.getRandomValues.bind(globalThis.crypto)
        : null;
    const nativeBlobSizeGetter = NativeBlob
        ? Object.getOwnPropertyDescriptor(NativeBlob.prototype, 'size')?.get
        : null;
    const nativeWorkerPrototype = typeof NativeWorker === 'function' ? NativeWorker.prototype : null;
    const nativeWorkerTerminate = nativeWorkerPrototype?.terminate;
    const nativeWorkerPostMessage = nativeWorkerPrototype?.postMessage;
    const nativeWorkerAddEventListener = nativeWorkerPrototype?.addEventListener;
    const nativeWorkerRemoveEventListener = nativeWorkerPrototype?.removeEventListener;
    const nativeEventTargetAddEventListener = NativeEventTarget.prototype.addEventListener;
    const nativeEventTargetRemoveEventListener = NativeEventTarget.prototype.removeEventListener;
    const nativeEventTargetDispatchEvent = NativeEventTarget.prototype.dispatchEvent;
    const nativeMapGet = NativeMap.prototype.get;
    const nativeMapSet = NativeMap.prototype.set;
    const nativeMapDelete = NativeMap.prototype.delete;
    const nativeMapClear = NativeMap.prototype.clear;
    const nativeMapForEach = NativeMap.prototype.forEach;
    const nativeMapSizeGetter = Object.getOwnPropertyDescriptor(NativeMap.prototype, 'size')?.get;
    const nativeWeakMapGet = NativeWeakMap.prototype.get;
    const nativeWeakMapSet = NativeWeakMap.prototype.set;
    const nativeSetAdd = NativeSet.prototype.add;
    const nativeSetDelete = NativeSet.prototype.delete;
    const nativeSetForEach = NativeSet.prototype.forEach;
    const trackedBlobUrls = new NativeMap();
    const activeWorkers = new NativeMap();
    const workerStates = new NativeWeakMap();
    const MAX_DIRECT_WORKERS = 4;
    const MAX_DIRECT_WORKER_BYTES = 8 * 1024 * 1024;
    let activeWorkerBytes = 0;
    let workerControlCounter = 0;

    function privateMapGet(map, key) {
        return nativeReflectApply(nativeMapGet, map, [key]);
    }

    function privateMapSet(map, key, value) {
        nativeReflectApply(nativeMapSet, map, [key, value]);
    }

    function privateMapDelete(map, key) {
        nativeReflectApply(nativeMapDelete, map, [key]);
    }

    function privateMapClear(map) {
        nativeReflectApply(nativeMapClear, map, []);
    }

    function privateMapForEach(map, callback) {
        nativeReflectApply(nativeMapForEach, map, [callback]);
    }

    function privateMapSize(map) {
        return nativeReflectApply(nativeMapSizeGetter, map, []);
    }

    function privateWeakMapGet(map, key) {
        return nativeReflectApply(nativeWeakMapGet, map, [key]);
    }

    function privateWeakMapSet(map, key, value) {
        nativeReflectApply(nativeWeakMapSet, map, [key, value]);
    }

    function privateSetAdd(set, value) {
        nativeReflectApply(nativeSetAdd, set, [value]);
    }

    function privateSetDelete(set, value) {
        nativeReflectApply(nativeSetDelete, set, [value]);
    }

    function privateSetForEach(set, callback) {
        nativeReflectApply(nativeSetForEach, set, [callback]);
    }

    function createWorkerControlToken() {
        if (!nativeGetRandomValues) {
            throw makePluginError('UNSUPPORTED', 'Secure Worker control tokens are unavailable');
        }
        const words = new NativeUint32Array(4);
        nativeGetRandomValues(words);
        workerControlCounter += 1;
        let token = nativeReflectApply(nativeNumberToString, workerControlCounter, [36]);
        for (let index = 0; index < words.length; index += 1) {
            token += '-' + nativeReflectApply(nativeNumberToString, words[index], [36]);
        }
        return token;
    }

    function createWorkerCloseGuardSource(controlToken) {
        const tokenLiteral = nativeJsonStringify(controlToken);
        return '(() => {\\n'
            + '    const controlToken = ' + tokenLiteral + ';\\n'
            + '    const nativeClose = globalThis.close.bind(globalThis);\\n'
            + '    const nativePostMessage = globalThis.postMessage.bind(globalThis);\\n'
            + '    let controlSent = false;\\n'
            + '    const safeClose = () => {\\n'
            + '        if (!controlSent) {\\n'
            + '            controlSent = true;\\n'
            + '            nativePostMessage({ __risuWorkerControl: controlToken, action: "close" });\\n'
            + '        }\\n'
            + '        nativeClose();\\n'
            + '    };\\n'
            + '    Object.freeze(safeClose);\\n'
            + '    Object.defineProperty(globalThis, "close", { value: safeClose, writable: false, configurable: false });\\n'
            + '})();\\n';
    }

    function nativeBlobSize(value) {
        if (!nativeBlobSizeGetter) return null;
        try {
            const size = nativeReflectApply(nativeBlobSizeGetter, value, []);
            return typeof size === 'number' && size >= 0 ? size : null;
        } catch {
            return null;
        }
    }

    function getWorkerState(worker) {
        const state = privateWeakMapGet(workerStates, worker);
        if (!state) throw new TypeError('Illegal invocation');
        return state;
    }

    function setWorkerEventHandler(worker, type, value) {
        const state = getWorkerState(worker);
        const previous = state.eventHandlers[type];
        if (previous) {
            nativeReflectApply(nativeEventTargetRemoveEventListener, worker, [type, previous]);
        }
        const next = typeof value === 'function' ? value : null;
        state.eventHandlers[type] = next;
        if (next) {
            nativeReflectApply(nativeEventTargetAddEventListener, worker, [type, next]);
        }
    }

    function createForwardedWorkerEvent(event) {
        if (event.type === 'error') {
            return new NativeErrorEvent('error', {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                error: event.error,
                cancelable: event.cancelable
            });
        }
        return new NativeMessageEvent(event.type, {
            data: event.data,
            origin: event.origin,
            lastEventId: event.lastEventId,
            source: event.source,
            ports: event.ports
        });
    }

    function forwardNativeWorkerEvent(worker, event) {
        const record = privateMapGet(activeWorkers, worker);
        if (!record) return;
        if (event.type === 'message'
            && event.data
            && event.data.__risuWorkerControl === record.controlToken
            && event.data.action === 'close') {
            if (!record.controlConsumed) {
                record.controlConsumed = true;
                releaseWorker(worker, true);
            }
            return;
        }
        const forwarded = createForwardedWorkerEvent(event);
        const allowed = nativeReflectApply(nativeEventTargetDispatchEvent, worker, [forwarded]);
        if (event.type === 'error' && !allowed) event.preventDefault();
    }

    function releaseWorker(worker, terminate) {
        const record = privateMapGet(activeWorkers, worker);
        if (!record) return;
        privateMapDelete(activeWorkers, worker);
        activeWorkerBytes -= record.payloadBytes;
        if (activeWorkerBytes < 0) activeWorkerBytes = 0;
        privateSetDelete(record.source.workers, worker);
        for (let index = 0; index < record.forwarders.length; index += 1) {
            const type = record.forwarders[index][0];
            const listener = record.forwarders[index][1];
            try {
                nativeReflectApply(nativeWorkerRemoveEventListener, record.nativeWorker, [type, listener]);
            } catch { /* already detached */ }
        }
        const state = privateWeakMapGet(workerStates, worker);
        if (state) {
            state.released = true;
            state.nativePostMessage = null;
        }
        if (terminate) {
            try { record.nativeTerminate(); } catch { /* already terminated */ }
        }
        try { nativeRevokeObjectURL(record.bootstrapUrl); } catch { /* already revoked */ }
    }

    function revokeTrackedObjectURL(url) {
        const key = String(url);
        const source = privateMapGet(trackedBlobUrls, key);
        if (source) {
            privateSetForEach(source.workers, (worker) => releaseWorker(worker, true));
            privateMapDelete(trackedBlobUrls, key);
        }
        nativeRevokeObjectURL(key);
    }

    function cleanupPluginWorkers() {
        privateMapForEach(activeWorkers, (_record, worker) => releaseWorker(worker, true));
        privateMapForEach(trackedBlobUrls, (_source, url) => {
            try { nativeRevokeObjectURL(url); } catch { /* already revoked */ }
        });
        privateMapClear(trackedBlobUrls);
        activeWorkerBytes = 0;
    }

    Object.defineProperty(URL, 'createObjectURL', {
        configurable: false,
        writable: false,
        value(object) {
            const url = nativeCreateObjectURL(object);
            const payloadBytes = nativeBlobSize(object);
            if (payloadBytes !== null) {
                privateMapSet(trackedBlobUrls, url, { blob: object, payloadBytes, workers: new NativeSet() });
            }
            return url;
        }
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: false,
        writable: false,
        value: revokeTrackedObjectURL
    });

    class WorkerFacade extends NativeEventTarget {}

    function SafeWorker(scriptURL, options) {
        if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator");
        if (typeof NativeWorker !== 'function'
            || typeof nativeWorkerTerminate !== 'function'
            || typeof nativeWorkerPostMessage !== 'function') {
            throw makePluginError('UNSUPPORTED', 'Worker is unavailable');
        }
        const sourceUrl = String(scriptURL);
        const source = privateMapGet(trackedBlobUrls, sourceUrl);
        if (!source) throw makePluginError('INVALID_ARGUMENT', 'Worker entry must be a tracked Blob URL');
        if (privateMapSize(activeWorkers) >= MAX_DIRECT_WORKERS) {
            throw makePluginError('RESOURCE_LIMIT', 'Direct Worker limit exceeded', { limit: MAX_DIRECT_WORKERS });
        }
        if (activeWorkerBytes + source.payloadBytes > MAX_DIRECT_WORKER_BYTES) {
            throw makePluginError('RESOURCE_LIMIT', 'Direct Worker initial payload limit exceeded', {
                limitBytes: MAX_DIRECT_WORKER_BYTES,
                activeBytes: activeWorkerBytes
            });
        }

        const controlToken = createWorkerControlToken();
        const closeGuardSource = createWorkerCloseGuardSource(controlToken);
        const nestedWorkerGuardSource = ${JSON.stringify(NESTED_WORKER_GUARD_SOURCE)};
        const bootstrapUrl = nativeCreateObjectURL(new NativeBlob([
            closeGuardSource,
            nestedWorkerGuardSource,
            '\\n',
            source.blob
        ], { type: 'text/javascript' }));
        let nativeWorker;
        try {
            nativeWorker = new NativeWorker(bootstrapUrl, options);
        } catch (error) {
            nativeRevokeObjectURL(bootstrapUrl);
            throw error;
        }

        const worker = new WorkerFacade();
        const state = {
            eventHandlers: { message: null, messageerror: null, error: null },
            nativePostMessage: (message, transferOrOptions, hasSecondArgument) => nativeReflectApply(
                nativeWorkerPostMessage,
                nativeWorker,
                hasSecondArgument ? [message, transferOrOptions] : [message]
            ),
            released: false
        };
        privateWeakMapSet(workerStates, worker, state);
        const forwarders = [
            ['message', (event) => forwardNativeWorkerEvent(worker, event)],
            ['messageerror', (event) => forwardNativeWorkerEvent(worker, event)],
            ['error', (event) => forwardNativeWorkerEvent(worker, event)]
        ];
        try {
            for (let index = 0; index < forwarders.length; index += 1) {
                const type = forwarders[index][0];
                const listener = forwarders[index][1];
                nativeReflectApply(nativeWorkerAddEventListener, nativeWorker, [type, listener]);
            }
        } catch (error) {
            try { nativeReflectApply(nativeWorkerTerminate, nativeWorker, []); } catch { /* construction cleanup */ }
            nativeRevokeObjectURL(bootstrapUrl);
            throw error;
        }

        activeWorkerBytes += source.payloadBytes;
        privateMapSet(activeWorkers, worker, {
            bootstrapUrl,
            controlConsumed: false,
            controlToken,
            forwarders,
            nativeTerminate: () => nativeReflectApply(nativeWorkerTerminate, nativeWorker, []),
            nativeWorker,
            payloadBytes: source.payloadBytes,
            source
        });
        privateSetAdd(source.workers, worker);
        return worker;
    }

    Object.defineProperties(WorkerFacade.prototype, {
        constructor: { configurable: false, writable: false, value: SafeWorker },
        postMessage: {
            configurable: false,
            writable: false,
            value(message, transferOrOptions) {
                const state = getWorkerState(this);
                if (state.released || !state.nativePostMessage) return undefined;
                return state.nativePostMessage(message, transferOrOptions, arguments.length > 1);
            }
        },
        terminate: {
            configurable: false,
            writable: false,
            value() { releaseWorker(this, true); }
        },
        onmessage: {
            configurable: false,
            get() { return getWorkerState(this).eventHandlers.message; },
            set(value) { setWorkerEventHandler(this, 'message', value); }
        },
        onmessageerror: {
            configurable: false,
            get() { return getWorkerState(this).eventHandlers.messageerror; },
            set(value) { setWorkerEventHandler(this, 'messageerror', value); }
        },
        onerror: {
            configurable: false,
            get() { return getWorkerState(this).eventHandlers.error; },
            set(value) { setWorkerEventHandler(this, 'error', value); }
        }
    });
    Object.defineProperty(SafeWorker, 'prototype', {
        configurable: false,
        writable: false,
        value: WorkerFacade.prototype
    });
    Object.freeze(WorkerFacade.prototype);
    Object.freeze(SafeWorker);

    function SafeSharedWorker() {
        throw makePluginError('UNSUPPORTED', 'SharedWorker is unavailable in the plugin sandbox');
    }
    Object.freeze(SafeSharedWorker.prototype);
    Object.freeze(SafeSharedWorker);
    Object.defineProperty(globalThis, 'Worker', { value: SafeWorker, writable: false, configurable: false });
    Object.defineProperty(globalThis, 'SharedWorker', { value: SafeSharedWorker, writable: false, configurable: false });
    addEventListener('pagehide', cleanupPluginWorkers, { once: true });
    addEventListener('unload', cleanupPluginWorkers, { once: true });

    function serializeArg(arg) {
        if (typeof arg === 'function') {
            const existingId = callbackIdByFunction.get(arg);
            if (existingId) {
                callbackRegistry.set(existingId, arg);
                callbackRefCounts.set(existingId, (callbackRefCounts.get(existingId) || 0) + 1);
                return { __type: 'CALLBACK_REF', id: existingId };
            }
            const id = 'cb_' + Math.random().toString(36).substring(2);
            callbackRegistry.set(id, arg);
            callbackIdByFunction.set(arg, id);
            callbackRefCounts.set(id, 1);
            return { __type: 'CALLBACK_REF', id: id };
        }
        if (arg && typeof arg === 'object') {
            const refId = proxyRefRegistry.get(arg);
            if (refId) {
                return { __type: 'REMOTE_REF', id: refId };
            }
            if (arg.constructor === Object) {
                let out = null;
                for (const [key, val] of Object.entries(arg)) {
                    if (val instanceof AbortSignal) {
                        if (!out) out = { ...arg };
                        const abortId = 'abort_' + Math.random().toString(36).substring(2);

                        if (!val.aborted) {
                            val.addEventListener('abort', () => {
                                send({ type: 'ABORT_SIGNAL', abortId });
                            }, { once: true });
                        }

                        out[key] = { __type: 'ABORT_SIGNAL_REF', abortId, aborted: val.aborted };
                    }
                }
                if (out) return out;
            }
        }
        return arg;
    }

    function deserializeResult(val) {
        if (val && typeof val === 'object' && val.__type === 'REMOTE_REF') {
            const proxy = new Proxy({}, {
                get: (target, prop) => {
                    if (prop === 'then') return undefined;
                    if (prop === 'release') {
                        return () => send({ type: 'RELEASE_INSTANCE', id: val.id });
                    }
                    return (...args) => sendRequest('CALL_INSTANCE', {
                        id: val.id,
                        method: prop,
                        args: args
                    });
                }
            });
            // Store the mapping so we can serialize it back
            proxyRefRegistry.set(proxy, val.id);
            return proxy;
        }
        if (val && typeof val === 'object' && val.__type === 'CALLBACK_STREAMS') {
            //specialType, one of
            // - Response
            // - none
            const specialType = val.__specialType;
            if (specialType === 'Response') {
                return new Response(val.value, val.init);
            }
            return val.value;
        }
        return val;
    }

    function collectTransferables(obj, transferables = []) {
        if (!obj || typeof obj !== 'object') return transferables;

        if (obj instanceof ArrayBuffer ||
            obj instanceof MessagePort ||
            obj instanceof ImageBitmap ||
            (typeof OffscreenCanvas !== 'undefined' && obj instanceof OffscreenCanvas)) {
            transferables.push(obj);
        }
        else if (ArrayBuffer.isView(obj) && obj.buffer instanceof ArrayBuffer) {
            transferables.push(obj.buffer);
        }
        else if (Array.isArray(obj)) {
            obj.forEach(item => collectTransferables(item, transferables));
        }
        else if (obj.constructor === Object) {
            Object.values(obj).forEach(value => collectTransferables(value, transferables));
        }

        return transferables;
    }

    function replaceStreamsWithPorts(obj) {
        const ports = [];
        const cleanups = [];
        if (!obj || typeof obj !== 'object') return { result: obj, ports, cleanups };

        function replace(val) {
            if (!(val instanceof ReadableStream)) return val;

            const ch = new MessageChannel();
            ports.push(ch.port2);

            const reader = val.getReader();
            let credits = 0;
            let reading = false;
            let finished = false;

            function finish() {
                finished = true;
                ch.port1.onmessage = null;
                ch.port1.close();
            }

            cleanups.push(() => {
                reader.cancel().catch(() => {});
                finish();
            });

            async function pump() {
                if (reading || finished) return;
                reading = true;
                try {
                    while (credits > 0 && !finished) {
                        credits--;
                        const { done, value } = await reader.read();
                        if (finished) return;
                        if (done) { ch.port1.postMessage({ done: true }); finish(); return; }
                        ch.port1.postMessage({ done: false, value });
                    }
                } catch (e) {
                    try { ch.port1.postMessage({ done: true, error: e.message }); } catch(_) {}
                    finish();
                } finally {
                    reading = false;
                }
            }

            ch.port1.onmessage = (e) => {
                if (e.data?.cancel) {
                    reader.cancel();
                    finish();
                } else if (e.data?.pull) {
                    credits++;
                    pump();
                }
            };

            return { __type: 'STREAM_PORT', portIndex: ports.length - 1 };
        }

        if (obj instanceof ReadableStream) return { result: replace(obj), ports, cleanups };
        if (obj.constructor === Object) {
            const out = {};
            for (const k of Object.keys(obj)) out[k] = replace(obj[k]);
            return { result: out, ports, cleanups };
        }

        return { result: obj, ports, cleanups };
    }

    function reconstructStreamsFromPorts(obj, ports) {
        if (!obj || typeof obj !== 'object') return obj;

        function reconstruct(val) {
            if (!val || val.__type !== 'STREAM_PORT' || typeof val.portIndex !== 'number') return val;

            const port = ports[val.portIndex];
            if (!port) throw new Error('Stream port at index ' + val.portIndex + ' not received');

            return new ReadableStream({
                start(controller) {
                    port.onmessage = (e) => {
                        if (e.data.done) {
                            if (e.data.error) controller.error(new Error(e.data.error));
                            else controller.close();
                            port.onmessage = null;
                            port.close();
                        } else {
                            controller.enqueue(e.data.value);
                        }
                    };
                },
                pull() {
                    port.postMessage({ pull: true });
                },
                cancel() {
                    port.postMessage({ cancel: true });
                    port.onmessage = null;
                    port.close();
                }
            });
        }

        if (obj.__type === 'STREAM_PORT') return reconstruct(obj);
        if (obj.constructor === Object) {
            const out = {};
            for (const k of Object.keys(obj)) out[k] = reconstruct(obj[k]);
            return out;
        }

        return obj;
    }

    function send(payload, transferables = []) {
        const prepared = rpcPrepareMessage(payload);
        const allTransferables = [...new Set([...transferables, ...prepared.transferables])];
        window.parent.postMessage(prepared.message, '*', allTransferables);
    }

    function sendRequest(type, payload) {
        return new Promise((resolve, reject) => {
            const reqId = Math.random().toString(36).substring(7);
            pendingRequests.set(reqId, { resolve, reject });


            if (payload.args) {
                payload.args = payload.args.map(serializeArg);
            }

            const message = { type: type, reqId: reqId, ...payload };
            try {
                send(message);
            } catch {
                pendingRequests.delete(reqId);
                reject(deserializePluginError(undefined));
            }
        });
    }

    const MAX_GUEST_NATIVE_FETCH_BODY_BYTES = 64 * 1024 * 1024;
    function guestBodySizeError() {
        return makePluginError('RESOURCE_LIMIT', 'nativeFetch body exceeds 67108864 bytes', {
            key: 'body', maximum: MAX_GUEST_NATIVE_FETCH_BODY_BYTES
        });
    }
    function guestHeaderTuples(headers) {
        if (headers === undefined) return [];
        if (typeof NativeHeaders === 'function' && headers instanceof NativeHeaders) {
            return Array.from(headers.entries(), ([name, value]) => [name, value]);
        }
        if (Array.isArray(headers)) return headers.map((entry) => [entry[0], entry[1]]);
        if (headers && typeof headers === 'object') return Object.entries(headers);
        throw makePluginError('INVALID_ARGUMENT', 'Invalid nativeFetch headers');
    }
    function guestSetContentType(headers, contentType) {
        if (!contentType || headers.some(([name]) => String(name).toLowerCase() === 'content-type')) return;
        headers.push(['content-type', contentType]);
    }
    async function normalizeGuestNativeFetch(url, options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw makePluginError('INVALID_ARGUMENT', 'Invalid nativeFetch options');
        }
        const normalized = { ...options };
        const headers = guestHeaderTuples(options.headers);
        normalized.headers = headers;
        const body = options.body;
        if (body === undefined) return sendRequest('CALL_ROOT', { method: 'nativeFetch', args: [url, normalized] });
        if (typeof body === 'string') {
            if (new TextEncoder().encode(body).byteLength > MAX_GUEST_NATIVE_FETCH_BODY_BYTES) throw guestBodySizeError();
        } else if (body instanceof ArrayBuffer) {
            if (body.byteLength > MAX_GUEST_NATIVE_FETCH_BODY_BYTES) throw guestBodySizeError();
            normalized.body = rpcMarkOwnedTransfer(new Uint8Array(body.slice(0)));
        } else if (ArrayBuffer.isView(body) && body.buffer instanceof ArrayBuffer) {
            if (body.byteLength > MAX_GUEST_NATIVE_FETCH_BODY_BYTES) throw guestBodySizeError();
            normalized.body = rpcMarkOwnedTransfer(new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)));
        } else if (typeof NativeBlob === 'function' && body instanceof NativeBlob) {
            if (body.size > MAX_GUEST_NATIVE_FETCH_BODY_BYTES) throw guestBodySizeError();
            normalized.body = rpcMarkOwnedTransfer(new Uint8Array(await body.arrayBuffer()));
            guestSetContentType(headers, body.type);
        } else if (typeof NativeURLSearchParams === 'function' && body instanceof NativeURLSearchParams) {
            normalized.body = body.toString();
            if (new TextEncoder().encode(normalized.body).byteLength > MAX_GUEST_NATIVE_FETCH_BODY_BYTES) throw guestBodySizeError();
            guestSetContentType(headers, 'application/x-www-form-urlencoded;charset=UTF-8');
        } else if (typeof NativeFormData === 'function' && body instanceof NativeFormData) {
            const request = new NativeRequest('https://multipart.invalid/', { method: 'POST', body });
            const declared = Number(request.headers.get('content-length') || 0);
            if (declared > MAX_GUEST_NATIVE_FETCH_BODY_BYTES) throw guestBodySizeError();
            normalized.body = rpcMarkOwnedTransfer(new Uint8Array(await request.arrayBuffer()));
            if (normalized.body.byteLength > MAX_GUEST_NATIVE_FETCH_BODY_BYTES) throw guestBodySizeError();
            guestSetContentType(headers, request.headers.get('content-type'));
        } else if (typeof NativeReadableStream === 'function' && body instanceof NativeReadableStream) {
            throw makePluginError('INVALID_ARGUMENT', 'ReadableStream bodies are not supported by nativeFetch');
        } else {
            throw makePluginError('INVALID_ARGUMENT', 'Unsupported nativeFetch body type');
        }
        return sendRequest('CALL_ROOT', { method: 'nativeFetch', args: [url, normalized] });
    }

    
    
    
    window.addEventListener('message', async (event) => {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data) return;


        if (data.type === 'RESPONSE' && data.reqId) {
            const req = pendingRequests.get(data.reqId);
            if (req) {
                if (data.error) req.reject(deserializePluginError(data.error));
                else {
                    try {
                        req.resolve(deserializeResult(reconstructStreamsFromPorts(data.result, event.ports)));
                    } catch (e) {
                        req.reject(e);
                    }
                }
                pendingRequests.delete(data.reqId);
            }
        }

        else if (data.type === 'EXECUTE_CODE' && data.reqId) {
            const response = { type: 'EXEC_RESULT', reqId: data.reqId };
            try {
                const result = await eval('(async () => {' + data.code + '})()');
                response.result = result;
            } catch (e) {
                response.error = serializePluginError(e);
            }
            try {
                send(response);
            } catch {
                send({ type: 'EXEC_RESULT', reqId: data.reqId, error: serializePluginError(undefined) });
            }
        }

        else if (data.type === 'ABORT_SIGNAL' && data.abortId) {
            const controller = abortControllers.get(data.abortId);
            if (controller) {
                controller.abort();
                abortControllers.delete(data.abortId);
            }
        }

        else if (data.type === 'RELEASE_CALLBACK' && data.id) {
            const refCount = callbackRefCounts.get(data.id) || 0;
            if (refCount <= 1) {
                callbackRefCounts.delete(data.id);
                callbackRegistry.delete(data.id);
            } else {
                callbackRefCounts.set(data.id, refCount - 1);
            }
        }

        else if (data.type === 'INVOKE_CALLBACK' && data.id) {
            const fn = callbackRegistry.get(data.id);
            const response = { type: 'CALLBACK_RETURN', reqId: data.reqId };
            const usedAbortIds = [];
            let transferables = [];
            let streamCleanups = [];

            const rollbackStreams = () => {
                for (const cleanup of streamCleanups) {
                    try { cleanup(); } catch(_) {}
                }
                streamCleanups = [];
            };

            try {
                if (!fn) throw makePluginError('NOT_FOUND', 'Callback not found or released');
                const deserializedArgs = (data.args || []).map(function(a) {
                    if (a && typeof a === 'object' && a.__type === 'ABORT_SIGNAL_REF') {
                        const controller = new AbortController();
                        abortControllers.set(a.abortId, controller);
                        usedAbortIds.push(a.abortId);
                        if (a.aborted) { controller.abort(); }
                        return controller.signal;
                    }
                    return a;
                });
                const result = await fn(...deserializedArgs);
                response.result = result;
                const { result: streamResult, ports: streamPorts, cleanups } = replaceStreamsWithPorts(response.result);
                response.result = streamResult;
                streamCleanups = cleanups;
                transferables = streamPorts;
            } catch (e) {
                rollbackStreams();
                delete response.result;
                response.error = serializePluginError(e);
            }
            // Clean up abort controllers after callback completes
            for (const id of usedAbortIds) {
                abortControllers.delete(id);
            }
            try {
                send(response, transferables);
            } catch {
                rollbackStreams();
                try {
                    send({ type: 'CALLBACK_RETURN', reqId: data.reqId, error: serializePluginError(undefined) });
                } catch { /* parent may already be gone */ }
            }
        }

        else if (data.type === 'TERMINATE') {
            const terminationError = makePluginError('ABORTED', 'Plugin sandbox terminated');
            for (const pending of pendingRequests.values()) pending.reject(terminationError);
            pendingRequests.clear();
            for (const controller of abortControllers.values()) controller.abort();
            abortControllers.clear();
            callbackRegistry.clear();
            callbackRefCounts.clear();
            cleanupPluginWorkers();
            try { send({ type: 'TERMINATE_ACK' }); } catch { /* iframe is being removed */ }
        }
    });





    const propertyCache = new Map();

    window.risuai = new Proxy({}, {
        get: (target, prop) => {
            if (propertyCache.has(prop)) {
                return propertyCache.get(prop);
            }
            return (...args) => sendRequest('CALL_ROOT', { method: prop, args: args });
        }
    });
    window.Risuai = window.risuai;

    try {
        // Initialize cached properties
        const propsToInit = await window.risuai._getPropertiesForInitialization();
        for (let i = 0; i < propsToInit.list.length; i++) {
            const key = propsToInit.list[i];
            const value = propsToInit[key];
            propertyCache.set(key, value);
        }

        // Initialize aliases
        const aliases = await window.risuai._getAliases();
        const aliasKeys = Object.keys(aliases);
        for (let i = 0; i < aliasKeys.length; i++) {
            const aliasKey = aliasKeys[i];
            const childrens = Object.keys(aliases[aliasKey]);
            const aliasObj = {};
            for (let j = 0; j < childrens.length; j++) {
                const childKey = childrens[j];
                aliasObj[childKey] = risuai[aliases[aliasKey][childKey]];
            }
            propertyCache.set(aliasKey, aliasObj);
        }

        // Initialize helper functions defined in the guest

        propertyCache.set('unwarpSafeArray', async (safeArray) => {
            const length = await safeArray.length();
            const result = [];
            for (let i = 0; i < length; i++) {
                const item = await safeArray.at(i);
                result.push(item);
            }
            return result;
        });
        propertyCache.set('nativeFetch', normalizeGuestNativeFetch);
    } catch (e) {
        console.error('[V3 RPC] guest initialization failed');
    }

    window.initOldApiGlobal = () => {
        const keys = risuai._getOldKeys()
        for(const key of keys){
            window[key] = risuai[key];
        }
    }

    Object.freeze(window.postMessage);
})();
`;

export class SandboxHost {
    private iframe!: HTMLIFrameElement;
    private apiFactory: any;
    private nonce = crypto.randomUUID();
    private csp = `connect-src 'none'; script-src 'nonce-${this.nonce}' 'wasm-unsafe-eval'; worker-src blob:; frame-src 'none'; object-src 'none'; style-src * 'unsafe-inline'; default-src 'none'; img-src * data: blob:; font-src * data: blob:; media-src * data: blob:; base-uri 'none';`;

    private instanceRegistry = new Map<string, any>();
    private abortControllers = new Map<string, AbortController>();
    private callbackWrapperCache = new Map<string, CallbackWrapperEntry>();
    private pendingCallbacks = new Map<string, {
        resolve: (value: any) => void
        reject: (reason?: any) => void
        cleanup: boolean
        runGeneration: number
    }>();
    private pendingExecutions = new Map<string, { resolve: (value: any) => void, reject: (reason?: any) => void }>();
    private messageHandler?: (event: MessageEvent) => void;
    private terminated = false;
    private runGeneration = 0;

    // Streams bridged over MessagePort need explicit teardown when the iframe ends.
    private activeStreamCleanups = new Set<() => void>();

    constructor(
        apiFactory: any,
        private readonly authorizeRequest: () => boolean = () => true,
        private readonly onAuthorizationFailure: () => void = () => undefined,
        private readonly authorizeCallback: () => boolean = authorizeRequest,
    ) {
        this.apiFactory = apiFactory;
    }

    private isAuthorized() {
        try { return this.authorizeRequest() } catch { return false }
    }

    private isCallbackAuthorized() {
        try { return this.authorizeCallback() } catch { return false }
    }

    private terminateUnauthorized() {
        try { this.onAuthorizationFailure() } catch { /* authorization failure stays fail-closed */ }
        this.terminate()
    }

    public executeInIframe(code: string): Promise<any> {
        if (this.terminated || !this.iframe?.contentWindow || !this.isAuthorized()) {
            if (!this.terminated && !this.isAuthorized()) this.terminateUnauthorized()
            return Promise.reject(new PluginApiError('ABORTED', 'Plugin sandbox terminated'));
        }
        return new Promise((resolve, reject) => {
            const reqId = 'exec_' + Math.random().toString(36).substring(2);
            this.pendingExecutions.set(reqId, { resolve, reject });
            try {
                this.postToGuest({ type: 'EXECUTE_CODE', reqId, code } as RpcMessage & { code: string });
            } catch {
                this.pendingExecutions.delete(reqId);
                reject(deserializePluginApiError(undefined));
            }
        });
    }

    private postToGuest(
        message: RpcMessage | (RpcMessage & Record<string, unknown>),
        transferables: Transferable[] = [],
    ) {
        const target = this.iframe?.contentWindow;
        if (!target) throw new PluginApiError('ABORTED', 'Plugin sandbox terminated');
        const prepared = prepareRpcMessage(message);
        const allTransferables = [...new Set([...transferables, ...prepared.transferables])];
        console.log('[V3 RPC]', {
            direction: 'host-to-guest',
            type: rpcLogType(message.type),
            transferCount: allTransferables.length,
        });
        target.postMessage(prepared.message, '*', allTransferables);
    }

    private isCurrentRun(runGeneration: number) {
        return !this.terminated && this.runGeneration === runGeneration;
    }

    private postResponse(response: RpcMessage, runGeneration: number, transferables: Transferable[] = []) {
        if (!this.isCurrentRun(runGeneration)) return false;
        try {
            this.postToGuest(response, transferables);
            return true;
        } catch {
            if (!this.isCurrentRun(runGeneration)) return false;
            try {
                this.postToGuest({
                    type: response.type,
                    reqId: response.reqId,
                    error: serializePluginApiError(undefined),
                });
            } catch {
                console.error('[V3 RPC] postMessage failed', { type: response.type });
            }
            return false;
        }
    }


    private serialize(val: any, runGeneration?: number): any {
        if (
            val &&
            (typeof val === 'object' || typeof val === 'function') &&
            val.__classType === 'REMOTE_REQUIRED'
        ) {
            if (runGeneration !== undefined && !this.isCurrentRun(runGeneration)) return undefined;
            if (val === null) return null;
            if (Array.isArray(val)) return val;


            const id = 'ref_' + Math.random().toString(36).substring(2);
            this.instanceRegistry.set(id, val);
            return { __type: 'REMOTE_REF', id } as RemoteRef;
        }

        if(val instanceof Response) {
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'Response',
                value: val.body,
                init: {
                    status: val.status,
                    statusText: val.statusText,
                    headers: Array.from(val.headers.entries())
                }
            };
        }

        if(
            val instanceof WritableStream
            || val instanceof TransformStream
        ) {
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'none',
                value: val
            };
        }
        return val;
    }


    private deserializeArgs(args: any[], usedAbortIds?: string[], runGeneration = this.runGeneration) {
        return args.map(arg => {
            if (arg && arg.__type === 'CALLBACK_REF') {
                const cbRef = arg as CallbackRef;

                const cached = this.callbackWrapperCache.get(cbRef.id);
                if (cached) {
                    cached.refCount += 1;
                    return cached.wrapper;
                }

                const invoke = (cleanup: boolean, innerArgs: any[]) => {
                    if (!this.isCurrentRun(runGeneration) || (!cleanup && !this.isCallbackAuthorized())) {
                        if (this.isCurrentRun(runGeneration)) this.terminateUnauthorized()
                        return Promise.reject(new PluginApiError('ABORTED', 'Plugin sandbox terminated'));
                    }
                    const reqId = 'cb_req_' + Math.random().toString(36).substring(2);
                    const invocation = new Promise((resolve, reject) => {
                        this.pendingCallbacks.set(reqId, { resolve, reject, cleanup, runGeneration });

                        // AbortSignal cannot be structured-cloned for postMessage.
                        // Convert to a serializable ref and forward abort events
                        // via a separate ABORT_SIGNAL message.
                        const sanitizedArgs = innerArgs.map(arg => {
                            if (arg instanceof AbortSignal) {
                                const abortId = 'abort_' + Math.random().toString(36).substring(2);
                                const ref: AbortSignalRef = {
                                    __type: 'ABORT_SIGNAL_REF',
                                    abortId,
                                    aborted: arg.aborted
                                };
                                if (!arg.aborted) {
                                    arg.addEventListener('abort', () => {
                                        if (!this.isCurrentRun(runGeneration)) return;
                                        try {
                                            this.postToGuest({
                                                type: 'ABORT_SIGNAL',
                                                abortId
                                            });
                                        } catch (_) { /* iframe already removed */ }
                                    }, { once: true });
                                }
                                return ref;
                            }
                            return arg;
                        });

                        const message = {
                            type: 'INVOKE_CALLBACK',
                            id: cbRef.id,
                            reqId,
                            args: sanitizedArgs
                        };
                        try {
                            this.postToGuest(message as RpcMessage);
                        } catch {
                            this.pendingCallbacks.delete(reqId);
                            reject(deserializePluginApiError(undefined));
                        }
                    });
                    sandboxCallbackInvocationCancellations.set(invocation, () => {
                        const pending = this.pendingCallbacks.get(reqId)
                        if (!pending || pending.runGeneration !== runGeneration) return false
                        this.pendingCallbacks.delete(reqId)
                        pending.reject(new PluginApiError('ABORTED', 'Plugin callback invocation cancelled'))
                        return true
                    })
                    void invocation.then(
                        () => { sandboxCallbackInvocationCancellations.delete(invocation) },
                        () => { sandboxCallbackInvocationCancellations.delete(invocation) },
                    )
                    return invocation
                }
                const wrapper = ((...innerArgs: any[]) => invoke(false, innerArgs)) as CallbackWrapper;
                wrapper[CLEANUP_CALLBACK_INVOKER] = (...innerArgs: any[]) => invoke(true, innerArgs)
                wrapper.release = () => {
                    const entry = this.callbackWrapperCache.get(cbRef.id);
                    if (!entry || entry.wrapper !== wrapper || entry.refCount <= 0) return;
                    entry.refCount -= 1;
                    try { this.postToGuest({ type: 'RELEASE_CALLBACK', id: cbRef.id }); } catch { /* unloading */ }
                    if (entry.refCount === 0 && this.callbackWrapperCache.get(cbRef.id)?.wrapper === wrapper) {
                        this.callbackWrapperCache.delete(cbRef.id);
                    }
                };
                this.callbackWrapperCache.set(cbRef.id, { wrapper, refCount: 1 });
                return wrapper;
            }
            if (arg && arg.__type === 'REMOTE_REF') {
                const remoteRef = arg as RemoteRef;
                const instance = this.instanceRegistry.get(remoteRef.id);
                if (instance) {
                    return instance;
                }
            }
            if (arg && typeof arg === 'object' && arg.constructor === Object) {
                let out: any = null;
                for (const [key, val] of Object.entries<any>(arg)) {
                    if (val && val.__type === 'ABORT_SIGNAL_REF') {
                        if (!out) out = { ...arg };
                        const abortRef = val as AbortSignalRef, controller = new AbortController();

                        if (abortRef.aborted) controller.abort();
                        else this.abortControllers.set(abortRef.abortId, controller);

                        usedAbortIds?.push(abortRef.abortId);
                        out[key] = controller.signal;
                    }
                }
                if (out) return out;
            }
            return arg;
        });
    }

    private replaceStreamsWithPorts(obj: any): { result: any, ports: MessagePort[], cleanups: (() => void)[] } {
        const ports: MessagePort[] = [];
        const cleanups: (() => void)[] = [];
        if (!obj || typeof obj !== 'object') return { result: obj, ports, cleanups };

        const replace = (val: any): any => {
            if (!(val instanceof ReadableStream)) return val;

            const ch = new MessageChannel();
            ports.push(ch.port2);

            const reader = val.getReader();
            let credits = 0;
            let reading = false;
            let finished = false;

            const finish = () => {
                finished = true;
                ch.port1.onmessage = null;
                ch.port1.close();
                this.activeStreamCleanups.delete(cleanup);
            };

            const cleanup = () => {
                reader.cancel().catch(() => {});
                finish();
            };
            this.activeStreamCleanups.add(cleanup);
            cleanups.push(cleanup);

            const pump = async () => {
                if (reading || finished) return;
                reading = true;
                try {
                    while (credits > 0 && !finished) {
                        credits--;
                        const { done, value } = await reader.read();
                        if (finished) return;
                        if (done) { ch.port1.postMessage({ done: true }); finish(); return; }
                        ch.port1.postMessage({ done: false, value });
                    }
                } catch (e: any) {
                    try { ch.port1.postMessage({ done: true, error: e.message }); } catch(_) {}
                    finish();
                } finally {
                    reading = false;
                }
            };

            ch.port1.onmessage = (e: MessageEvent) => {
                if (e.data?.cancel) {
                    reader.cancel();
                    finish();
                } else if (e.data?.pull) {
                    credits++;
                    pump();
                }
            };

            return { __type: 'STREAM_PORT', portIndex: ports.length - 1 };
        };

        if (obj instanceof ReadableStream) return { result: replace(obj), ports, cleanups };
        if (obj.constructor === Object) {
            const out: any = {};
            for (const k of Object.keys(obj)) out[k] = replace(obj[k]);
            return { result: out, ports, cleanups };
        }

        return { result: obj, ports, cleanups };
    }

    private reconstructStreamsFromPorts(obj: any, ports: readonly MessagePort[]): any {
        if (!obj || typeof obj !== 'object') return obj;

        const reconstruct = (val: any): any => {
            if (val?.__type !== 'STREAM_PORT' || typeof val.portIndex !== 'number') return val;

            const port = ports[val.portIndex];
            if (!port) throw new Error(`Stream port at index ${val.portIndex} not received`);

            const cleanups = this.activeStreamCleanups;
            let cleanup: (() => void) | null = null;
            const unregister = () => {
                if (cleanup) {
                    cleanups.delete(cleanup);
                    cleanup = null;
                }
            };

            return new ReadableStream({
                start(controller) {
                    port.onmessage = (e: MessageEvent) => {
                        if (e.data.done) {
                            if (e.data.error) controller.error(new Error(e.data.error));
                            else controller.close();
                            port.onmessage = null;
                            port.close();
                            unregister();
                        } else {
                            controller.enqueue(e.data.value);
                        }
                    };
                    cleanup = () => {
                        controller.error(new Error('Sandbox terminated'));
                        port.onmessage = null;
                        port.close();
                    };
                    cleanups.add(cleanup);
                },
                pull() {
                    port.postMessage({ pull: true });
                },
                cancel() {
                    port.postMessage({ cancel: true });
                    port.onmessage = null;
                    port.close();
                    unregister();
                }
            });
        };

        if (obj.__type === 'STREAM_PORT') return reconstruct(obj);
        if (obj.constructor === Object) {
            const out: any = {};
            for (const k of Object.keys(obj)) out[k] = reconstruct(obj[k]);
            return out;
        }

        return obj;
    }

    private closeActiveStreams() {
        for (const cleanup of [...this.activeStreamCleanups]) {
            try { cleanup(); } catch(_) {}
        }
        this.activeStreamCleanups.clear();
    }

    public run(container: HTMLElement|HTMLIFrameElement, userCode: string) {
        if(container instanceof HTMLIFrameElement) {
            this.iframe = container;
        } else {
            this.iframe = document.createElement('iframe');
            container.appendChild(this.iframe);
        }

        this.iframe.style.width = "100%";
        this.iframe.style.height = "100%";
        this.iframe.style.border = "none";

        this.iframe.style.backgroundColor = "transparent";
        this.iframe.setAttribute('allowTransparency', 'true');

        this.iframe.sandbox.add('allow-scripts');
        this.iframe.sandbox.add('allow-modals')
        this.iframe.sandbox.add('allow-downloads')

        this.iframe.setAttribute('csp', this.csp);

        this.terminated = false;
        const runGeneration = ++this.runGeneration;
        const messageHandler = async (event: MessageEvent) => {
            if (!this.isCurrentRun(runGeneration)) return;
            if (event.source !== this.iframe.contentWindow) return;
            const data = event.data as RpcMessage;
            if (!data || typeof data !== 'object') return;

            const requiresActiveAuthorization = data.type === 'READY'
                || data.type === 'CALL_ROOT'
                || data.type === 'CALL_INSTANCE'
            if (requiresActiveAuthorization && !this.isAuthorized()) {
                this.terminateUnauthorized()
                return
            }

            console.log('[V3 RPC]', { direction: 'guest-to-host', type: rpcLogType(data.type) });

            if (data.type === 'READY') {
                this.postToGuest({ type: 'START' })
                return
            }

            if (data.type === 'EXEC_RESULT') {
                const pending = this.pendingExecutions.get(data.reqId!);
                if (pending) {
                    this.pendingExecutions.delete(data.reqId!);
                    if (data.error) pending.reject(deserializePluginApiError(data.error));
                    else pending.resolve(data.result);
                }
                return;
            }


            if (data.type === 'CALLBACK_RETURN') {
                const req = this.pendingCallbacks.get(data.reqId!);
                if (req) {
                    this.pendingCallbacks.delete(data.reqId!);
                    if (!req.cleanup && (!this.isCurrentRun(req.runGeneration) || !this.isCallbackAuthorized())) {
                        req.reject(new PluginApiError('ABORTED', 'Plugin sandbox terminated'))
                        if (this.isCurrentRun(req.runGeneration)) this.terminateUnauthorized()
                        return
                    }
                    if (data.error) req.reject(deserializePluginApiError(data.error));
                    else {
                        try {
                            req.resolve(this.reconstructStreamsFromPorts(data.result, event.ports));
                        } catch (error) {
                            req.reject(error);
                        }
                    }
                }
                return;
            }

            if (data.type === 'ABORT_SIGNAL') {
                const controller = this.abortControllers.get(data.abortId!);
                if (controller) {
                    controller.abort();
                    this.abortControllers.delete(data.abortId!);
                }
                return;
            }


            if (data.type === 'RELEASE_INSTANCE') {
                this.instanceRegistry.delete(data.id!);
                return;
            }


            if (data.type === 'CALL_ROOT' || data.type === 'CALL_INSTANCE') {
                const response: RpcMessage = { type: 'RESPONSE', reqId: data.reqId };
                const usedAbortIds: string[] = [];
                let transferables: Transferable[] = [];
                let streamCleanups: (() => void)[] = [];
                let resourceFinalizer: StudioCardRpcFinalizer | undefined;

                const rollbackStreams = () => {
                    for (const cleanup of streamCleanups) {
                        try { cleanup(); } catch(_) {}
                    }
                    streamCleanups = [];
                };
                const rollbackResult = () => {
                    rollbackStreams();
                    const finalizer = resourceFinalizer;
                    resourceFinalizer = undefined;
                    if (!finalizer) return;
                    try { finalizer.rollback(); } catch { /* sanitized best effort */ }
                };
                const commitResult = () => {
                    const finalizer = resourceFinalizer;
                    resourceFinalizer = undefined;
                    if (!finalizer) return;
                    try { finalizer.commit(); } catch { /* finalized response cannot be recovered */ }
                };

                try {

                    const args = this.deserializeArgs(data.args || [], usedAbortIds, runGeneration);
                    let result: any;


                    if (data.type === 'CALL_ROOT') {
                        const fn = this.apiFactory[data.method!];
                        if (typeof fn !== 'function') throw new PluginApiError('NOT_FOUND', 'API method not found');
                        result = await fn(...args);
                    } else {
                        const instance = this.instanceRegistry.get(data.id!);
                        if (!instance) throw new PluginApiError('NOT_FOUND', 'Instance not found or released');
                        if (typeof instance[data.method!] !== 'function') throw new PluginApiError('NOT_FOUND', 'Instance method not found');
                        result = await instance[data.method!](...args);
                    }
                    resourceFinalizer = takeStudioCardRpcFinalizer(result);

                    if (!this.isCurrentRun(runGeneration)) {
                        rollbackResult();
                        return;
                    }
                    if (!this.isAuthorized()) {
                        rollbackResult();
                        this.terminateUnauthorized()
                        return
                    }

                    response.result = this.serialize(result, runGeneration);
                    const { result: streamResult, ports: streamPorts, cleanups } = this.replaceStreamsWithPorts(response.result);
                    response.result = streamResult;
                    streamCleanups = cleanups;
                    transferables = streamPorts;

                } catch (err: any) {
                    rollbackResult();
                    delete response.result;
                    if (!this.isCurrentRun(runGeneration)) return;
                    if (!this.isAuthorized()) {
                        this.terminateUnauthorized()
                        return
                    }
                    response.error = serializePluginApiError(err);
                } finally {
                    for (const id of usedAbortIds) this.abortControllers.delete(id);
                }

                if (!this.isCurrentRun(runGeneration)) {
                    rollbackResult();
                    return;
                }
                if (this.postResponse(response, runGeneration, transferables)) commitResult();
                else rollbackResult();
            }
        };

        this.messageHandler = messageHandler;
        window.addEventListener('message', messageHandler);


        const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${this.csp}" id="csp-meta">
      </head>
      <body>
        <style>
            body {
                background-color: transparent;
            }
        </style>
        <script nonce="${this.nonce}">
            document.querySelector('meta#csp-meta')?.remove();
            (async () => {
                ${GUEST_BRIDGE_SCRIPT}

                await new Promise((resolve) => {
                    const onStart = (event) => {
                        if (event.source !== window.parent || !event.data || event.data.type !== 'START') return;
                        window.removeEventListener('message', onStart);
                        resolve();
                    };
                    window.addEventListener('message', onStart);
                    window.parent.postMessage({ type: 'READY' }, '*');
                });

                (async () => {
                    ${userCode}
                })()
            })();
        </script>
      </body>
      </html>
    `;

        this.iframe.srcdoc = html;

        return () => this.terminate();
    }

    public terminate() {
        if (this.terminated) return;
        this.terminated = true;
        this.runGeneration += 1;

        try { this.postToGuest({ type: 'TERMINATE' }); } catch { /* iframe may already be gone */ }
        const terminationError = new PluginApiError('ABORTED', 'Plugin sandbox terminated');
        for (const pending of this.pendingCallbacks.values()) pending.reject(terminationError);
        for (const pending of this.pendingExecutions.values()) pending.reject(terminationError);
        for (const controller of this.abortControllers.values()) controller.abort();

        if (this.messageHandler) window.removeEventListener('message', this.messageHandler);
        this.messageHandler = undefined;
        this.iframe?.remove();
        this.closeActiveStreams();
        this.instanceRegistry.clear();
        this.pendingCallbacks.clear();
        this.pendingExecutions.clear();
        this.abortControllers.clear();
        this.callbackWrapperCache.clear();
    }
}
