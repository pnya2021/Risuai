import localforage from 'localforage'
import { pluginDataLifecycle } from '../../pluginDataLifecycle'
import { SecurityConfirmationQueue, securityConfirmationQueue } from '../../securityConfirmationQueue'
import { PluginApiError } from './errors'

export const ALL_PLUGIN_PERMISSIONS = [
    'fetchLogs', 'db', 'mainDom', 'replacer', 'provider', 'sendChat',
    'contextAssets', 'installedModulesRead', 'chatObserve', 'chatObserveAll',
    'chatWrite', 'chatWriteAll', 'inlayWrite', 'inlayRead', 'inlayManage',
    'secrets', 'localModelInference', 'pluginJobs',
] as const

export type PluginPermissionId = typeof ALL_PLUGIN_PERMISSIONS[number]
export type PluginPermissionState = 'not-requested' | 'granted' | 'denied'
export type PluginPermissionDecision = {
    state: Exclude<PluginPermissionState, 'not-requested'>
    decidedAt: number
}

export interface PluginExecutionContext {
    principalId: string
    instanceId: string
    displayName: string
    internalName?: string
    signal: AbortSignal
}

export function createPluginExecutionContext(plugin: { principalId: string; name: string; displayName?: string }) {
    const abortController = new AbortController()
    return {
        abortController,
        context: {
            principalId: plugin.principalId,
            instanceId: crypto.randomUUID(),
            displayName: plugin.displayName ?? plugin.name,
            internalName: plugin.name,
            signal: abortController.signal,
        } satisfies PluginExecutionContext,
    }
}

export interface PermissionPersistence {
    get(principalId: string, permission: PluginPermissionId): Promise<PluginPermissionDecision | null>
    set(principalId: string, permission: PluginPermissionId, decision: PluginPermissionDecision): Promise<void>
    clearPrincipal(principalId: string): Promise<void>
}

const keyOf = (principalId: string, permission: PluginPermissionId) => JSON.stringify([principalId, permission])

export class MemoryPermissionPersistence implements PermissionPersistence {
    private entries = new Map<string, PluginPermissionDecision>()
    async get(principalId: string, permission: PluginPermissionId) { return this.entries.get(keyOf(principalId, permission)) ?? null }
    async set(principalId: string, permission: PluginPermissionId, decision: PluginPermissionDecision | 'granted' | 'denied') {
        this.entries.set(keyOf(principalId, permission), typeof decision === 'string'
            ? { state: decision, decidedAt: Date.now() }
            : decision)
    }
    async clearPrincipal(principalId: string) {
        for (const key of this.entries.keys()) if (JSON.parse(key)[0] === principalId) this.entries.delete(key)
    }
}

class LocalForagePermissionPersistence implements PermissionPersistence {
    private store = localforage.createInstance({ name: 'plugin_permissions_v3', storeName: 'principal_permissions' })
    async get(principalId: string, permission: PluginPermissionId) {
        const value = await this.store.getItem<PluginPermissionDecision | PluginPermissionState>(keyOf(principalId, permission))
        return value && typeof value === 'object' && (value.state === 'granted' || value.state === 'denied')
            ? value
            : null
    }
    async set(principalId: string, permission: PluginPermissionId, decision: PluginPermissionDecision) {
        await this.store.setItem(keyOf(principalId, permission), decision)
    }
    async clearPrincipal(principalId: string) {
        const keys = await this.store.keys()
        await Promise.all(keys.filter((key) => {
            try { return JSON.parse(key)[0] === principalId } catch { return false }
        }).map((key) => this.store.removeItem(key)))
    }
}

const EN: Record<PluginPermissionId, string> = {
    fetchLogs: 'read diagnostic logs that may contain sensitive information',
    db: 'read the full Risu database',
    mainDom: 'access the main application interface',
    replacer: 'replace rendered chat content',
    provider: 'register and use an AI provider',
    sendChat: 'send chat messages and trigger model responses',
    contextAssets: 'read the current card, conversation, and active assets',
    installedModulesRead: 'read descriptive data and assets from installed modules',
    chatObserve: 'observe committed messages in the current conversation',
    chatObserveAll: 'observe committed messages across conversations',
    chatWrite: 'apply restricted changes to the current conversation',
    chatWriteAll: 'apply restricted changes to other authorized conversations',
    inlayWrite: 'create, read, and delete its own Inlays',
    inlayRead: 'read foreign or legacy Inlays',
    inlayManage: 'delete foreign Inlays or detach their references',
    secrets: 'store write-only secrets and use them in restricted requests',
    localModelInference: 'install and run the approved local image tagger',
    pluginJobs: 'publish visible background jobs and receive cancellation events',
}

const KO: Record<PluginPermissionId, string> = {
    fetchLogs: '민감한 정보가 포함될 수 있는 진단 로그를 읽기', db: '전체 Risu 데이터베이스를 읽기',
    mainDom: '앱의 기본 화면에 접근하기', replacer: '채팅에 표시되는 내용을 치환하기',
    provider: 'AI 제공자를 등록하고 사용하기', sendChat: '채팅 메시지를 보내고 모델 응답을 실행하기',
    contextAssets: '현재 카드, 대화, 활성 에셋을 읽기', installedModulesRead: '설치된 모듈의 설명과 에셋을 읽기',
    chatObserve: '현재 대화의 확정된 메시지를 관찰하기', chatObserveAll: '모든 대화의 확정된 메시지를 관찰하기',
    chatWrite: '현재 대화를 제한적으로 변경하기', chatWriteAll: '권한이 있는 다른 대화를 제한적으로 변경하기',
    inlayWrite: '자신의 Inlay를 생성·읽기·삭제하기', inlayRead: '다른 플러그인 또는 레거시 Inlay를 읽기',
    inlayManage: '다른 Inlay를 삭제하거나 참조를 분리하기', secrets: '쓰기 전용 비밀을 저장하고 제한된 요청에 사용하기',
    localModelInference: '승인된 로컬 이미지 태거를 설치하고 실행하기', pluginJobs: '표시 가능한 백그라운드 작업과 취소 콜백을 사용하기',
}

export function permissionCopy(locale: 'en' | 'ko', permission: PluginPermissionId, displayName: string, internalName: string) {
    const korean = locale === 'ko'
    return {
        title: korean ? '플러그인 권한 요청' : 'Plugin permission',
        description: korean
            ? `${displayName} (${internalName}) 플러그인이 다음 권한을 요청합니다: ${KO[permission]}.`
            : `${displayName} (${internalName}) requests permission to ${EN[permission]}.`,
        allowLabel: korean ? '허용' : 'Allow',
        denyLabel: korean ? '거부' : 'Deny',
    }
}

export const isPluginPermissionId = (value: string): value is PluginPermissionId =>
    (ALL_PLUGIN_PERMISSIONS as readonly string[]).includes(value)

export class PluginPermissionService {
    private inFlight = new Map<string, Promise<boolean>>()
    private generations = new Map<string, number>()
    private resets = new Map<string, Promise<void>>()
    private globalReset: Promise<void> | null = null
    private globalGeneration = 0
    private persistenceMutationTail: Promise<void> = Promise.resolve()
    private readonly now: () => number
    private readonly periodicReconfirmMs: number
    private readonly isPrincipalRetiring: (principalId: string) => boolean
    constructor(
        private persistence: PermissionPersistence,
        private queue: SecurityConfirmationQueue,
        options: { now?: () => number; periodicReconfirmMs?: number; isPrincipalRetiring?: (principalId: string) => boolean } = {},
    ) {
        this.now = options.now ?? Date.now
        this.periodicReconfirmMs = options.periodicReconfirmMs ?? 3 * 24 * 60 * 60 * 1000
        this.isPrincipalRetiring = options.isPrincipalRetiring ?? ((principalId) => pluginDataLifecycle.isRetiring(principalId))
    }

    async state(principalId: string, permission: PluginPermissionId): Promise<PluginPermissionState> {
        try { await this.waitForResets(principalId) } catch { return 'not-requested' }
        return (await this.persistence.get(principalId, permission))?.state ?? 'not-requested'
    }

    private async waitForResets(principalId: string) {
        const globalReset = this.globalReset
        if (globalReset) await globalReset
        const principalReset = this.resets.get(principalId)
        if (principalReset) await principalReset
    }

    private async withPersistenceMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
        let release!: () => void
        const previous = this.persistenceMutationTail
        this.persistenceMutationTail = new Promise<void>((resolve) => { release = resolve })
        await previous
        try { return await mutation() } finally { release() }
    }

    request(context: PluginExecutionContext, permission: PluginPermissionId, options: { reconfirm?: boolean | 'periodically'; locale?: 'en' | 'ko' } = {}) {
        const reconfirm = options.reconfirm ?? false
        const generation = this.generations.get(context.principalId) ?? 0
        const globalGeneration = this.globalGeneration
        const isCurrent = () => (this.generations.get(context.principalId) ?? 0) === generation
            && this.globalGeneration === globalGeneration
            && !this.isPrincipalRetiring(context.principalId)
        const key = JSON.stringify([context.principalId, context.instanceId, permission, reconfirm, generation, globalGeneration])
        const existing = this.inFlight.get(key)
        if (existing) return existing
        const operation = (async () => {
            if (context.signal.aborted || !isCurrent()) return false
            try { await this.waitForResets(context.principalId) } catch { return false }
            if (context.signal.aborted || !isCurrent()) return false
            const persisted = await this.persistence.get(context.principalId, permission)
            if (context.signal.aborted || !isCurrent()) return false
            if (reconfirm !== true && persisted) {
                if (persisted.state === 'denied') return false
                if (reconfirm !== 'periodically' || this.now() - persisted.decidedAt <= this.periodicReconfirmMs) return true
            }
            const copy = permissionCopy(options.locale ?? 'en', permission, context.displayName, context.internalName ?? context.displayName)
            const decision = await this.queue.request({
                kind: 'permission', principalId: context.principalId, instanceId: context.instanceId,
                action: permission, copyVersion: 1, displayName: context.displayName,
                internalName: context.internalName ?? context.displayName, ...copy,
            }, context.signal)
            if (context.signal.aborted || !isCurrent()) return false
            const stored = await this.withPersistenceMutation(async () => {
                if (context.signal.aborted || !isCurrent()) return false
                await this.persistence.set(context.principalId, permission, {
                    state: decision ? 'granted' : 'denied',
                    decidedAt: this.now(),
                })
                return !context.signal.aborted && isCurrent()
            })
            if (!stored) return false
            return decision
        })().finally(() => this.inFlight.delete(key))
        this.inFlight.set(key, operation)
        return operation
    }

    async require(context: PluginExecutionContext, permission: PluginPermissionId, options: { reconfirm?: boolean | 'periodically'; locale?: 'en' | 'ko' } = {}) {
        if (!await this.request(context, permission, options)) {
            throw new PluginApiError('PERMISSION_DENIED', `Permission denied: ${permission}`, { details: { permission } })
        }
    }

    resetPrincipal(principalId: string) {
        this.generations.set(principalId, (this.generations.get(principalId) ?? 0) + 1)
        const operation = this.withPersistenceMutation(() => this.persistence.clearPrincipal(principalId))
        this.resets.set(principalId, operation)
        void operation.then(() => {
            if (this.resets.get(principalId) === operation) this.resets.delete(principalId)
        }, () => undefined)
        return operation
    }

    resetAll(clearAll: () => Promise<void>) {
        this.globalGeneration++
        const operation = this.withPersistenceMutation(clearAll)
        this.globalReset = operation
        void operation.then(() => {
            if (this.globalReset === operation) this.globalReset = null
        }, () => undefined)
        return operation
    }
}

export const pluginPermissionService = new PluginPermissionService(new LocalForagePermissionPersistence(), securityConfirmationQueue)

pluginDataLifecycle.register('permission', 'purge', ({ principalId }) => pluginPermissionService.resetPrincipal(principalId))
