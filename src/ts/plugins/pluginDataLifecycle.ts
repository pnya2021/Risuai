export type PluginDataLifecycleAction = 'summarize' | 'purge' | 'quarantine' | 'delete' | 'reassociate'

export interface PluginDataLifecycleContext {
    principalId: string
    action: PluginDataLifecycleAction
    operationId: string
    targetPrincipalId?: string
}

export type PluginDataLifecycleHook = (context: PluginDataLifecycleContext) => void | Promise<void>

export interface PluginDataLifecycleResult {
    principalId: string
    action: PluginDataLifecycleAction | 'uninstall'
    operationId: string
    failures: Array<{ resourceKind: string; action: PluginDataLifecycleAction; message: string }>
}

export class PluginDataLifecycleRegistry {
    private hooks: Array<{ resourceKind: string; action: PluginDataLifecycleAction; hook: PluginDataLifecycleHook }> = []
    private operations = new Map<string, Promise<PluginDataLifecycleResult>>()
    private tails = new Map<string, Promise<unknown>>()
    private instanceStops = new Map<string, Map<string, () => void | Promise<void>>>()
    private retiringPrincipals = new Set<string>()
    private activeRetirementCounts = new Map<string, number>()

    isRetiring(principalId: string) { return this.retiringPrincipals.has(principalId) }
    isRetirementInProgress(principalId: string) { return (this.activeRetirementCounts.get(principalId) ?? 0) > 0 }

    private enqueue(principalId: string, work: () => Promise<PluginDataLifecycleResult>) {
        const previous = this.tails.get(principalId) ?? Promise.resolve()
        const operation = previous.catch(() => undefined).then(work)
        this.tails.set(principalId, operation)
        return operation
    }

    private async executeAction(
        principalId: string,
        action: PluginDataLifecycleAction,
        operationId: string,
        targetPrincipalId?: string,
    ): Promise<PluginDataLifecycleResult> {
        const failures: PluginDataLifecycleResult['failures'] = []
        const hooks = this.hooks.filter((entry) => entry.action === action)
        for (const entry of hooks) {
            try {
                await entry.hook({ principalId, action, operationId, targetPrincipalId })
            } catch {
                failures.push({ resourceKind: entry.resourceKind, action, message: 'Lifecycle hook failed'.slice(0, 256) })
            }
        }
        return { principalId, action, operationId, failures }
    }

    register(resourceKind: string, action: PluginDataLifecycleAction, hook: PluginDataLifecycleHook) {
        const entry = { resourceKind, action, hook }
        this.hooks.push(entry)
        return () => {
            const index = this.hooks.indexOf(entry)
            if (index >= 0) this.hooks.splice(index, 1)
        }
    }

    registerInstanceStop(principalId: string, instanceId: string, stop: () => void | Promise<void>) {
        if (this.retiringPrincipals.has(principalId)) {
            void Promise.resolve().then(stop).catch(() => undefined)
            return () => undefined
        }
        let instances = this.instanceStops.get(principalId)
        if (!instances) this.instanceStops.set(principalId, instances = new Map())
        instances.set(instanceId, stop)
        return () => {
            instances?.delete(instanceId)
            if (instances?.size === 0) this.instanceStops.delete(principalId)
        }
    }

    async stopPrincipalInstances(principalId: string) {
        const instances = this.instanceStops.get(principalId)
        if (!instances) return
        this.instanceStops.delete(principalId)
        const stops = [...instances.values()]
        for (const stop of stops) {
            try { await stop() } catch { /* stopping one instance must not block the rest */ }
        }
    }

    run(principalId: string, action: PluginDataLifecycleAction, options: { operationId?: string; targetPrincipalId?: string } = {}) {
        const operationId = options.operationId ?? crypto.randomUUID()
        const key = `${principalId}\u0000${action}\u0000${operationId}`
        const existing = this.operations.get(key)
        if (existing) return existing
        const operation = this.enqueue(principalId, () =>
            this.executeAction(principalId, action, operationId, options.targetPrincipalId))
        this.operations.set(key, operation)
        return operation
    }

    async uninstall(principalId: string, options: { operationId?: string } = {}): Promise<PluginDataLifecycleResult> {
        const operationId = options.operationId ?? crypto.randomUUID()
        const key = `${principalId}\u0000uninstall\u0000${operationId}`
        const existing = this.operations.get(key)
        if (existing) return existing
        const operation = this.enqueue(principalId, async () => {
            const failures: PluginDataLifecycleResult['failures'] = []
            for (const action of ['summarize', 'purge', 'quarantine'] as const) {
                const result = await this.executeAction(principalId, action, operationId)
                failures.push(...result.failures)
            }
            return { principalId, action: 'uninstall' as const, operationId, failures }
        })
        this.operations.set(key, operation)
        return operation
    }

    retirePrincipal(principalId: string, options: {
        operationId?: string
        invalidate: () => void | Promise<void>
        remove?: () => void | Promise<void>
    }) {
        this.retiringPrincipals.add(principalId)
        const operationId = options.operationId ?? crypto.randomUUID()
        const key = `${principalId}\u0000retire\u0000${operationId}`
        const existing = this.operations.get(key)
        if (existing) return existing
        this.activeRetirementCounts.set(principalId, (this.activeRetirementCounts.get(principalId) ?? 0) + 1)
        const operation = this.enqueue(principalId, async () => {
            const failures: PluginDataLifecycleResult['failures'] = []
            for (const action of ['summarize', 'purge', 'quarantine'] as const) {
                const result = await this.executeAction(principalId, action, operationId)
                failures.push(...result.failures)
            }
            try { await options.invalidate() } catch {
                failures.push({ resourceKind: 'principal', action: 'quarantine', message: 'Lifecycle hook failed' })
            }
            await this.stopPrincipalInstances(principalId)
            try { await options.remove?.() } catch {
                failures.push({ resourceKind: 'installed-record', action: 'delete', message: 'Lifecycle hook failed' })
            }
            return { principalId, action: 'uninstall' as const, operationId, failures }
        }).finally(() => {
            const remaining = (this.activeRetirementCounts.get(principalId) ?? 1) - 1
            if (remaining > 0) this.activeRetirementCounts.set(principalId, remaining)
            else this.activeRetirementCounts.delete(principalId)
        })
        this.operations.set(key, operation)
        return operation
    }
}

export const pluginDataLifecycle = new PluginDataLifecycleRegistry()
