import { describe, expect, it } from 'vitest'
import { languageEnglish } from '../../lang/en'
import { languageKorean } from '../../lang/ko'
import { canonicalizePluginSecretPolicy } from './apiV3/illustration/secretPolicy'
import { pluginSecretConsentCopy } from './pluginSecretPrompt.svelte'

const input = {
    displayName: 'Illustrator', internalName: 'illustrator', secretId: 'nai-key', replacement: false,
    policy: canonicalizePluginSecretPolicy({
        allowedOrigins: ['https://api.example.com'],
        uses: [
            { kind: 'header', name: 'authorization', prefix: 'Bearer ' },
            { kind: 'json-body', pointer: '/api_key' },
        ],
    }),
}

describe('plugin Secret consent copy', () => {
    it('names plugin identity and every canonical placement in English and Korean without the value', () => {
        for (const locale of ['en', 'ko'] as const) {
            const copy = pluginSecretConsentCopy(locale, input)
            expect(copy.description).toContain('Illustrator (illustrator)')
            expect(copy.description).toContain('https://api.example.com')
            expect(copy.description).toContain('authorization')
            expect(copy.description).toContain('/api_key')
            expect(JSON.stringify(copy)).not.toContain('actual-secret-value')
        }
    })

    it('ships localized accessible UI labels', () => {
        expect(languageEnglish.pluginSecretConsent).toMatchObject({
            storeTitle: expect.any(String), replaceTitle: expect.any(String), cancel: expect.any(String),
        })
        expect(languageKorean.pluginSecretConsent).toMatchObject({
            storeTitle: expect.any(String), replaceTitle: expect.any(String), cancel: expect.any(String),
        })
    })
})
