import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n?/gu, '\n')

describe('Risu native plugin transport contracts', () => {
    it('uses Tauri camelCase command arguments and rejects pre-aborted requests before invoke', () => {
        const globalApi = source('src/ts/globalApi.svelte.ts')
        const start = globalApi.indexOf('export async function fetchPluginPolicyNative')
        const body = globalApi.slice(start, globalApi.indexOf('/**', start + 10))
        expect(body).toContain("invoke('cancel_plugin_policy_fetch', { requestId })")
        expect(body).toContain("invoke('plugin_policy_fetch', {\n                requestId,")
        expect(body).toContain('requestJson: JSON.stringify({')
        expect(body).not.toContain('request_id:')
        expect(body).not.toContain('request_json:')
        expect(body.indexOf('request.signal?.aborted')).toBeGreaterThan(-1)
        expect(body.indexOf('request.signal?.aborted')).toBeLessThan(body.indexOf('if (isNodeServer)'))
    })

    it('keeps Rust fetches off environment proxies and records bounded cancel-before-register tombstones', () => {
        const rust = source('src-tauri/src/plugin_fetch_policy.rs')
        expect(rust).toContain('.no_proxy()')
        expect(rust).toContain('MAX_PENDING_CANCELLATIONS')
        expect(rust).toContain('PENDING_CANCELLATION_TTL')
        expect(rust).toContain('pending_cancellations')
        expect(rust).toContain('register_or_consume_pending_cancel')
    })
})
