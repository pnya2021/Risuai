import type { CanonicalPluginSecretPolicy } from './apiV3/illustration/secretPolicy'

export function pluginSecretConsentCopy(
    locale: 'en' | 'ko',
    input: {
        displayName: string
        internalName: string
        secretId: string
        replacement: boolean
        policy: CanonicalPluginSecretPolicy
    },
) {
    const uses = input.policy.uses.map((use) => use.kind === 'header'
        ? `${locale === 'ko' ? '· 헤더' : '· Header'}: ${use.name}${use.prefix === undefined ? '' : ` (${locale === 'ko' ? '접두사' : 'prefix'}: ${JSON.stringify(use.prefix)})`}`
        : `${locale === 'ko' ? '· JSON 본문' : '· JSON body'}: ${use.pointer || '<root>'}${use.prefix === undefined ? '' : ` (${locale === 'ko' ? '접두사' : 'prefix'}: ${JSON.stringify(use.prefix)})`}`)
    const origins = input.policy.allowedOrigins.map((origin) => `· ${origin}`)
    if (locale === 'ko') {
        return {
            title: input.replacement ? '쓰기 전용 비밀 교체' : '쓰기 전용 비밀 저장',
            description: [
                `${input.displayName} (${input.internalName}) 플러그인이 비밀 “${input.secretId}”을 ${input.replacement ? '교체' : '저장'}하려고 합니다.`,
                '플러그인은 저장된 값을 다시 읽을 수 없으며, 아래 위치에서만 요청에 사용됩니다.',
                '', '허용된 출처:', ...origins,
                '', '허용된 사용 위치:', ...uses,
            ].join('\n'),
            allowLabel: input.replacement ? '교체' : '저장',
            denyLabel: '취소',
        }
    }
    return {
        title: input.replacement ? 'Replace write-only Secret' : 'Store write-only Secret',
        description: [
            `${input.displayName} (${input.internalName}) wants to ${input.replacement ? 'replace' : 'store'} Secret “${input.secretId}”.`,
            'The plugin cannot read the stored value back. It may be used only at every placement listed below.',
            '', 'Allowed origins:', ...origins,
            '', 'Allowed placements:', ...uses,
        ].join('\n'),
        allowLabel: input.replacement ? 'Replace' : 'Store',
        denyLabel: 'Cancel',
    }
}
