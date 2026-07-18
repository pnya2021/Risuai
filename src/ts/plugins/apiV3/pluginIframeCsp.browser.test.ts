import { afterEach, describe, expect, it } from 'vitest'

import { SandboxHost } from './factory'

type BrowserSandbox = {
  host: SandboxHost
  iframe: HTMLIFrameElement
  reports: any[]
}

const sandboxes: BrowserSandbox[] = []

function startSandbox(
  userCode: string,
  apiFactory: Record<string, (...args: any[]) => any> = {},
): BrowserSandbox {
  const reports: any[] = []
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  document.body.appendChild(iframe)
  const host = new SandboxHost({
    _getPropertiesForInitialization: async () => ({ list: [] }),
    _getAliases: async () => ({}),
    report: async (value: unknown) => { reports.push(value) },
    ...apiFactory,
  })
  host.run(iframe, userCode)
  const sandbox = { host, iframe, reports }
  sandboxes.push(sandbox)
  return sandbox
}

async function waitForReport<T = any>(sandbox: BrowserSandbox, predicate: (value: any) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = sandbox.reports.find(predicate)
    if (match !== undefined) return match as T
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for browser sandbox report; received ${JSON.stringify(sandbox.reports)}`)
}

afterEach(() => {
  while (sandboxes.length) sandboxes.pop()?.host.terminate()
  document.body.replaceChildren()
})

describe('V3 plugin guest error normalization', () => {
  it('settles execute failures as INTERNAL without invoking error accessors', async () => {
    const sandbox = startSandbox(`await risuai.report({ kind: 'guest-ready' });`)
    await waitForReport(sandbox, (value) => value.kind === 'guest-ready')

    const outcome = await Promise.race([
      sandbox.host.executeInIframe(`
        const error = {};
        Object.defineProperty(error, 'name', {
          enumerable: true,
          get() {
            void risuai.report({ kind: 'execute-error-getter-invoked' });
            throw new Error('guest execute accessor ran');
          }
        });
        throw error;
      `).then(
        () => ({ status: 'resolved' as const }),
        (error: any) => ({
          status: 'rejected' as const,
          error: {
            name: error?.name,
            code: error?.code,
            message: error?.message,
            retryable: error?.retryable,
          },
        }),
      ),
      new Promise<{ status: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ status: 'timeout' }), 1_500)
      }),
    ])

    expect(outcome).toEqual({
      status: 'rejected',
      error: {
        name: 'PluginApiError',
        code: 'INTERNAL',
        message: 'Internal plugin API error',
        retryable: false,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(sandbox.reports.some((value) => value.kind === 'execute-error-getter-invoked')).toBe(false)
  }, 10_000)

  it('settles callback failures as INTERNAL without invoking error accessors', async () => {
    const sandbox = startSandbox(`
      let getterInvoked = false;
      const outcome = await risuai.invokeCallback(async () => {
        const error = {};
        Object.defineProperty(error, 'name', {
          enumerable: true,
          get() {
            getterInvoked = true;
            throw new Error('guest accessor ran');
          }
        });
        throw error;
      }).then(
        () => ({ status: 'resolved' }),
        (error) => ({
          status: 'rejected',
          error: {
            name: error && error.name,
            code: error && error.code,
            message: error && error.message,
            retryable: error && error.retryable,
          }
        })
      );
      await risuai.report({ kind: 'guest-callback-error', getterInvoked, outcome });
    `, {
      invokeCallback: async (callback: () => Promise<unknown>) => callback(),
    })

    const result = await waitForReport<any>(
      sandbox,
      (value) => value.kind === 'guest-callback-error',
      2_000,
    )
    expect(result.getterInvoked).toBe(false)
    expect(result.outcome).toEqual({
      status: 'rejected',
      error: {
        name: 'PluginApiError',
        code: 'INTERNAL',
        message: 'Internal plugin API error',
        retryable: false,
      },
    })
  }, 10_000)
})

describe('V3 plugin iframe CSP and direct Worker sandbox', () => {
  it('keeps the opaque nonce-only iframe while allowing only tracked Blob Worker entry URLs', async () => {
    const sandbox = startSandbox(`
      const outcomes = {};
      outcomes.sharedWorkerType = typeof SharedWorker;
      try {
        new SharedWorker(URL.createObjectURL(new Blob(['onconnect = () => {}'])));
        outcomes.sharedWorkerBlocked = false;
      } catch (error) {
        outcomes.sharedWorkerBlocked = true;
        outcomes.sharedWorkerCode = error && error.code;
      }

      const blockedEntries = [
        'https://example.invalid/worker.js',
        'data:text/javascript,postMessage(1)',
        '/same-origin-worker.js',
      ];
      outcomes.entryBlocks = blockedEntries.map((entry) => {
        try { new Worker(entry); return false; }
        catch { return true; }
      });

      const inlineUrl = URL.createObjectURL(new Blob([
        'postMessage("inline-ready")'
      ], { type: 'text/javascript' }));
      outcomes.inlineReady = await new Promise((resolve) => {
        try {
          const worker = new Worker(inlineUrl);
          const timer = setTimeout(() => { worker.terminate(); resolve(false); }, 1500);
          worker.onmessage = (event) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(event.data === 'inline-ready');
          };
          worker.onerror = (event) => {
            clearTimeout(timer);
            outcomes.inlineError = { message: event.message, filename: event.filename };
            worker.terminate();
            resolve(false);
          };
        } catch { resolve(false); }
      });
      URL.revokeObjectURL(inlineUrl);
      await risuai.report({ kind: 'entry-policy', ...outcomes });
    `)

    const csp = sandbox.iframe.getAttribute('csp') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain('worker-src blob:')
    expect(sandbox.iframe.sandbox.contains('allow-same-origin')).toBe(false)
    expect(sandbox.iframe.srcdoc.match(/<script\b/g)).toHaveLength(1)
    expect(sandbox.iframe.srcdoc).toMatch(/<script nonce="[^"]+">/)

    const result = await waitForReport<any>(sandbox, (value) => value.kind === 'entry-policy')
    expect(result.inlineError).toBeUndefined()
    expect(result).toMatchObject({
      sharedWorkerType: 'function',
      sharedWorkerBlocked: true,
      entryBlocks: [true, true, true],
      inlineReady: true,
    })
  }, 15_000)

  it('allows four active direct Workers, rejects the fifth, and returns quota on terminate/revoke', async () => {
    const sandbox = startSandbox(`
      const urls = [];
      const workers = [];
      const createReadyWorker = async () => {
        const url = URL.createObjectURL(new Blob([
          'postMessage("ready"); setInterval(() => {}, 1000)'
        ], { type: 'text/javascript' }));
        urls.push(url);
        try {
          const worker = new Worker(url);
          workers.push(worker);
          const ready = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), 1500);
            worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data === 'ready'); };
            worker.onerror = () => { clearTimeout(timer); resolve(false); };
          });
          return ready;
        } catch { return false; }
      };

      const firstFour = [];
      for (let index = 0; index < 4; index++) firstFour.push(await createReadyWorker());
      let fifthBlocked = false;
      let fifthCode;
      const fifthUrl = URL.createObjectURL(new Blob(['setInterval(() => {}, 1000)']));
      try { new Worker(fifthUrl); }
      catch (error) { fifthBlocked = true; fifthCode = error && error.code; }
      URL.revokeObjectURL(fifthUrl);

      workers[0]?.terminate();
      URL.revokeObjectURL(urls[0]);
      const replacementReady = await createReadyWorker();

      for (const worker of workers) worker.terminate();
      for (const url of urls) URL.revokeObjectURL(url);
      await risuai.report({ kind: 'worker-count', firstFour, fifthBlocked, fifthCode, replacementReady });
    `)

    const result = await waitForReport<any>(sandbox, (value) => value.kind === 'worker-count')
    expect(result.firstFour).toEqual([true, true, true, true])
    expect(result.fifthBlocked).toBe(true)
    expect(result.fifthCode).toBe('RESOURCE_LIMIT')
    expect(result.replacementReady).toBe(true)
  }, 20_000)

  it('does not expose the native Worker through constructor or descriptor escape paths', async () => {
    const nestedProbeSource = `
      (() => {
        const nestedUrl = URL.createObjectURL(new Blob(['postMessage("nested-ready")']));
        let nestedBlocked = false;
        try {
          const nested = new Worker(nestedUrl);
          nested.terminate();
        } catch {
          nestedBlocked = true;
        }
        URL.revokeObjectURL(nestedUrl);
        postMessage({ nestedBlocked });
      })();
    `
    const sandbox = startSandbox(`
      const idleUrl = URL.createObjectURL(new Blob(['setInterval(() => {}, 1000)'], { type: 'text/javascript' }));
      const probe = new Worker(idleUrl);
      const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
      const prototypeDescriptor = Object.getOwnPropertyDescriptor(Worker, 'prototype');
      const constructorDescriptor = Object.getOwnPropertyDescriptor(Worker.prototype, 'constructor');
      const candidates = {
        prototypeOfGlobal: Object.getPrototypeOf(Worker),
        prototypeConstructor: Worker.prototype.constructor,
        returnedConstructor: probe.constructor,
        descriptorConstructor: constructorDescriptor && constructorDescriptor.value,
        descriptorPrototypeConstructor: prototypeDescriptor && prototypeDescriptor.value && prototypeDescriptor.value.constructor,
      };
      const invariants = {
        globalWorkerLocked: workerDescriptor && workerDescriptor.value === Worker && workerDescriptor.writable === false && workerDescriptor.configurable === false,
        workerPrototypeLocked: prototypeDescriptor && prototypeDescriptor.value === Worker.prototype && prototypeDescriptor.writable === false && prototypeDescriptor.configurable === false,
        workerConstructorLocked: constructorDescriptor && constructorDescriptor.value === Worker && constructorDescriptor.writable === false && constructorDescriptor.configurable === false,
        safeFunctionPrototype: Object.getPrototypeOf(Worker) === Function.prototype,
        safePrototypeConstructor: Worker.prototype.constructor === Worker,
        safeReturnedConstructor: probe.constructor === Worker,
      };
      probe.terminate();

      const quotaWorkers = [];
      for (let index = 0; index < 4; index++) quotaWorkers.push(new Worker(idleUrl));
      const directQuotaBypass = {};
      const reflectQuotaBypass = {};
      for (const [name, Candidate] of Object.entries(candidates)) {
        try {
          const escaped = new Candidate(idleUrl);
          directQuotaBypass[name] = true;
          escaped.terminate?.();
        } catch {
          directQuotaBypass[name] = false;
        }
        try {
          const escaped = Reflect.construct(Candidate, [idleUrl]);
          reflectQuotaBypass[name] = true;
          escaped.terminate?.();
        } catch {
          reflectQuotaBypass[name] = false;
        }
      }
      for (const worker of quotaWorkers) worker.terminate();

      const LIMIT = 8 * 1024 * 1024;
      const oversizedUrl = URL.createObjectURL(new Blob([
        '/*', new Uint8Array(LIMIT), '*/'
      ], { type: 'text/javascript' }));
      const oversizedBypass = {};
      for (const [name, Candidate] of Object.entries(candidates)) {
        try {
          const escaped = Reflect.construct(Candidate, [oversizedUrl]);
          oversizedBypass[name] = true;
          escaped.terminate?.();
        } catch {
          oversizedBypass[name] = false;
        }
      }

      const nestedEntry = URL.createObjectURL(new Blob([${JSON.stringify(nestedProbeSource)}], { type: 'text/javascript' }));
      const nestedGuarded = {};
      for (const [name, Candidate] of Object.entries(candidates)) {
        nestedGuarded[name] = await new Promise((resolve) => {
          let outer;
          try {
            outer = Reflect.construct(Candidate, [nestedEntry]);
          } catch {
            resolve(true);
            return;
          }
          const timer = setTimeout(() => {
            outer.terminate?.();
            resolve(false);
          }, 2500);
          outer.onmessage = (event) => {
            clearTimeout(timer);
            outer.terminate?.();
            resolve(event.data && event.data.nestedBlocked === true);
          };
          outer.onerror = () => {
            clearTimeout(timer);
            outer.terminate?.();
            resolve(false);
          };
        });
      }

      for (const url of [idleUrl, oversizedUrl, nestedEntry]) URL.revokeObjectURL(url);
      await risuai.report({
        kind: 'native-worker-escape',
        invariants,
        directQuotaBypass,
        reflectQuotaBypass,
        oversizedBypass,
        nestedGuarded,
      });
    `)

    const result = await waitForReport<any>(sandbox, (value) => value.kind === 'native-worker-escape', 25_000)
    expect(result.invariants).toEqual({
      globalWorkerLocked: true,
      workerPrototypeLocked: true,
      workerConstructorLocked: true,
      safeFunctionPrototype: true,
      safePrototypeConstructor: true,
      safeReturnedConstructor: true,
    })
    for (const attempts of [result.directQuotaBypass, result.reflectQuotaBypass, result.oversizedBypass]) {
      expect(Object.values(attempts)).toEqual([false, false, false, false, false])
    }
    expect(Object.values(result.nestedGuarded)).toEqual([true, true, true, true, true])
  }, 30_000)

  it('releases count and payload budgets when Workers self-close without allowing stale cleanup to underflow', async () => {
    const sandbox = startSandbox(`
      const LIMIT = 8 * 1024 * 1024;
      const PER_WORKER = LIMIT / 4;
      const closingSource = 'postMessage("ready");onmessage=()=>{postMessage("closing");close();close()};setInterval(()=>{},1000);';
      const sizedWorkerBlob = () => new Blob([
        closingSource,
        '/*',
        new Uint8Array(PER_WORKER - closingSource.length - 4),
        '*/',
      ], { type: 'text/javascript' });
      const closingUrl = URL.createObjectURL(sizedWorkerBlob());
      const replacementUrl = URL.createObjectURL(sizedWorkerBlob());
      const closingWorkers = [];
      const readyPromises = [];
      const closingPromises = [];
      for (let index = 0; index < 4; index++) {
        const worker = new Worker(closingUrl);
        closingWorkers.push(worker);
        let resolveReady;
        let resolveClosing;
        readyPromises.push(new Promise((resolve) => { resolveReady = resolve; }));
        closingPromises.push(new Promise((resolve) => { resolveClosing = resolve; }));
        worker.onmessage = (event) => {
          if (event.data === 'ready') resolveReady(true);
          if (event.data === 'closing') resolveClosing(true);
        };
      }
      await Promise.all(readyPromises);
      for (const worker of closingWorkers) worker.postMessage('close');
      await Promise.all(closingPromises);

      const replacements = [];
      const createWithRetry = async () => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try { return new Worker(replacementUrl); }
          catch (error) {
            if (!error || error.code !== 'RESOURCE_LIMIT') throw error;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        return null;
      };
      for (let index = 0; index < 4; index++) {
        const replacement = await createWithRetry();
        if (!replacement) break;
        replacements.push(replacement);
      }

      for (const worker of closingWorkers) {
        worker.terminate();
        worker.terminate();
      }
      URL.revokeObjectURL(closingUrl);
      URL.revokeObjectURL(closingUrl);

      let fifthBlocked = false;
      try {
        const fifth = new Worker(replacementUrl);
        fifth.terminate();
      } catch (error) {
        fifthBlocked = error && error.code === 'RESOURCE_LIMIT';
      }
      for (const worker of replacements) worker.terminate();
      URL.revokeObjectURL(replacementUrl);
      await risuai.report({ kind: 'worker-self-close', replacementCount: replacements.length, fifthBlocked });
    `)

    const result = await waitForReport<any>(sandbox, (value) => value.kind === 'worker-self-close', 15_000)
    expect(result).toEqual({ kind: 'worker-self-close', replacementCount: 4, fifthBlocked: true })
  }, 20_000)

  it('enforces the exact 8 MiB aggregate initial direct Blob payload boundary', async () => {
    const sandbox = startSandbox(`
      const LIMIT = 8 * 1024 * 1024;
      const sizedScript = (size) => size < 4
        ? new Blob([' '.repeat(size)], { type: 'text/javascript' })
        : new Blob(['/*', new Uint8Array(size - 4), '*/'], { type: 'text/javascript' });
      const urls = [
        URL.createObjectURL(sizedScript(LIMIT / 2)),
        URL.createObjectURL(sizedScript(LIMIT / 2)),
      ];
      const workers = [];
      let exactAccepted = true;
      try { workers.push(new Worker(urls[0]), new Worker(urls[1])); }
      catch { exactAccepted = false; }

      const extraUrl = URL.createObjectURL(sizedScript(1));
      let aggregateOneOverBlocked = false;
      try { workers.push(new Worker(extraUrl)); }
      catch (error) { aggregateOneOverBlocked = error && error.code === 'RESOURCE_LIMIT'; }

      for (const worker of workers) worker.terminate();
      for (const url of [...urls, extraUrl]) URL.revokeObjectURL(url);

      const singleOverUrl = URL.createObjectURL(sizedScript(LIMIT + 1));
      let singleOneOverBlocked = false;
      try { new Worker(singleOverUrl); }
      catch (error) { singleOneOverBlocked = error && error.code === 'RESOURCE_LIMIT'; }
      URL.revokeObjectURL(singleOverUrl);
      await risuai.report({ kind: 'worker-bytes', exactAccepted, aggregateOneOverBlocked, singleOneOverBlocked });
    `)

    const result = await waitForReport<any>(sandbox, (value) => value.kind === 'worker-bytes', 15_000)
    expect(result).toEqual({
      kind: 'worker-bytes',
      exactAccepted: true,
      aggregateOneOverBlocked: true,
      singleOneOverBlocked: true,
    })
  }, 20_000)

  it('freezes nested Worker constructors and keeps Worker fetch/WebSocket connections blocked', async () => {
    const workerSource = `
      (async () => {
        const nestedUrl = URL.createObjectURL(new Blob(['postMessage("nested")']));
        let nestedWorkerBlocked = false;
        let nestedSharedWorkerBlocked = false;
        try { new Worker(nestedUrl); } catch { nestedWorkerBlocked = true; }
        try { new SharedWorker(nestedUrl); } catch { nestedSharedWorkerBlocked = true; }
        URL.revokeObjectURL(nestedUrl);

        const fetchBlocked = await fetch('https://example.invalid/rpc-sentinel')
          .then(() => false, () => true);
        const webSocketBlocked = await new Promise((resolve) => {
          try {
            const socket = new WebSocket('wss://example.invalid/rpc-sentinel');
            const timer = setTimeout(() => { socket.close(); resolve(false); }, 1500);
            socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(false); };
            socket.onerror = () => { clearTimeout(timer); resolve(true); };
          } catch { resolve(true); }
        });
        postMessage({ nestedWorkerBlocked, nestedSharedWorkerBlocked, fetchBlocked, webSocketBlocked });
      })();
    `
    const sandbox = startSandbox(`
      const url = URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], { type: 'text/javascript' }));
      const result = await new Promise((resolve) => {
        try {
          const worker = new Worker(url);
          const timer = setTimeout(() => { worker.terminate(); resolve({ timeout: true }); }, 4000);
          worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); resolve(event.data); };
          worker.onerror = () => { clearTimeout(timer); worker.terminate(); resolve({ workerError: true }); };
        } catch { resolve({ constructorBlocked: true }); }
      });
      URL.revokeObjectURL(url);
      await risuai.report({ kind: 'nested-and-connect', ...result });
    `)

    const result = await waitForReport<any>(sandbox, (value) => value.kind === 'nested-and-connect')
    expect(result).toMatchObject({
      nestedWorkerBlocked: true,
      nestedSharedWorkerBlocked: true,
      fetchBlocked: true,
      webSocketBlocked: true,
    })
  }, 15_000)

  it('does not count later importScripts or dynamic Blob imports as initial direct Worker payload', async () => {
    const sandbox = startSandbox(`
      const LIMIT = 8 * 1024 * 1024;
      const classicImport = URL.createObjectURL(new Blob([
        'postMessage("classic-imported");/*', new Uint8Array(LIMIT + 1), '*/'
      ], { type: 'text/javascript' }));
      const classicEntry = URL.createObjectURL(new Blob([
        'importScripts(' + JSON.stringify(classicImport) + ')'
      ], { type: 'text/javascript' }));

      const moduleImport = URL.createObjectURL(new Blob([
        'postMessage("module-imported"); export {};/*', new Uint8Array(LIMIT + 1), '*/'
      ], { type: 'text/javascript' }));
      const moduleEntry = URL.createObjectURL(new Blob([
        'import(' + JSON.stringify(moduleImport) + ')'
      ], { type: 'text/javascript' }));

      const waitFor = (url, options, expected) => new Promise((resolve) => {
        try {
          const worker = new Worker(url, options);
          const timer = setTimeout(() => {
            worker.terminate();
            resolve({ constructed: true, imported: false, timedOut: true });
          }, 5000);
          worker.onmessage = (event) => {
            clearTimeout(timer);
            worker.terminate();
            resolve({ constructed: true, imported: event.data === expected });
          };
          worker.onerror = () => {
            clearTimeout(timer);
            worker.terminate();
            resolve({ constructed: true, imported: false, cspBlocked: true });
          };
        } catch (error) {
          resolve({ constructed: false, imported: false, code: error && error.code });
        }
      });
      const classic = await waitFor(classicEntry, undefined, 'classic-imported');
      const module = await waitFor(moduleEntry, { type: 'module' }, 'module-imported');
      for (const url of [classicImport, classicEntry, moduleImport, moduleEntry]) URL.revokeObjectURL(url);
      await risuai.report({ kind: 'later-imports', classic, module });
    `)

    const result = await waitForReport<any>(sandbox, (value) => value.kind === 'later-imports', 15_000)
    expect(result).toMatchObject({
      kind: 'later-imports',
      classic: { constructed: true, imported: false, cspBlocked: true },
      module: { constructed: true, imported: false, cspBlocked: true },
    })
  }, 20_000)

  it('terminates tracked Workers when the plugin iframe is unloaded and removed', async () => {
    const sandbox = startSandbox(`
      const url = URL.createObjectURL(new Blob([
        'postMessage("ready"); setInterval(() => postMessage("tick"), 20)'
      ], { type: 'text/javascript' }));
      const worker = new Worker(url);
      worker.onmessage = (event) => { risuai.report({ kind: 'heartbeat', value: event.data }); };
    `)

    await waitForReport(sandbox, (value) => value.kind === 'heartbeat' && value.value === 'tick')
    sandbox.host.terminate()
    expect(sandbox.iframe.isConnected).toBe(false)
    const reportCount = sandbox.reports.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(sandbox.reports).toHaveLength(reportCount)
  }, 15_000)
})
