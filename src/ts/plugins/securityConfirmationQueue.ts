import { writable, type Readable } from 'svelte/store'

export type SecurityConfirmationKind =
    | 'permission' | 'secret-placement' | 'secret-replacement'
    | 'model-install' | 'model-remove' | 'lifecycle-delete' | 'lifecycle-reassociate'

export interface SecurityConfirmationRequest {
    kind: SecurityConfirmationKind
    principalId: string
    instanceId?: string
    action: string
    scopeDigest?: string
    policyDigest?: string
    profileDigest?: string
    copyVersion: number
    displayName: string
    internalName: string
    title?: string
    description?: string
    allowLabel?: string
    denyLabel?: string
}

export interface SecurityConfirmationView {
    digest: string
    presentationId: string
    request: SecurityConfirmationRequest
    title: string
    copy: string
    allowLabel: string
    denyLabel: string
}

type QueueEntry = {
    view: SecurityConfirmationView
    resolve: (decision: boolean) => void
    signal?: AbortSignal
    abort?: () => void
}

const canonicalDigest = (request: SecurityConfirmationRequest) => JSON.stringify([
    request.kind, request.principalId, request.action, request.scopeDigest ?? '',
    request.policyDigest ?? '', request.profileDigest ?? '', request.copyVersion,
])

export class SecurityConfirmationQueue {
    private entries: QueueEntry[] = []
    private active?: QueueEntry
    private viewStore = writable<SecurityConfirmationView | null>(null)
    readonly view: Readable<SecurityConfirmationView | null> = { subscribe: this.viewStore.subscribe }
    private presentationWaiters: Array<() => void> = []

    request(request: SecurityConfirmationRequest, signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) return Promise.resolve(false)
        const digest = canonicalDigest(request)
        const copy = request.description
            ?? `${request.displayName} (${request.internalName}) requests ${request.action}.`
        const view: SecurityConfirmationView = {
            digest, presentationId: crypto.randomUUID(), request: { ...request }, title: request.title ?? 'Plugin permission', copy,
            allowLabel: request.allowLabel ?? 'Allow', denyLabel: request.denyLabel ?? 'Deny',
        }
        return new Promise<boolean>((resolve) => {
            const entry: QueueEntry = { view, resolve, signal }
            entry.abort = () => this.cancel(entry)
            signal?.addEventListener('abort', entry.abort, { once: true })
            this.entries.push(entry)
            this.presentNext()
        })
    }

    current() { return this.active?.view ?? null }

    decide(digest: string, presentationId: string, decision: boolean) {
        if (!this.active || this.active.view.digest !== digest || this.active.view.presentationId !== presentationId) return false
        this.finish(this.active, decision)
        return true
    }

    whenPresented() {
        if (this.active) return Promise.resolve()
        return new Promise<void>((resolve) => this.presentationWaiters.push(resolve))
    }

    clearForTests() {
        for (const entry of [...this.entries]) this.cancel(entry)
        if (this.active) this.finish(this.active, false)
    }

    private presentNext() {
        if (this.active) return
        while (this.entries.length && this.entries[0].signal?.aborted) this.cancel(this.entries[0])
        this.active = this.entries.shift()
        this.viewStore.set(this.active?.view ?? null)
        if (this.active) this.presentationWaiters.splice(0).forEach((resolve) => resolve())
    }

    private cancel(entry: QueueEntry) {
        if (entry === this.active) this.finish(entry, false)
        else {
            const index = this.entries.indexOf(entry)
            if (index >= 0) this.entries.splice(index, 1)
            entry.signal?.removeEventListener('abort', entry.abort!)
            entry.resolve(false)
        }
    }

    private finish(entry: QueueEntry, decision: boolean) {
        entry.signal?.removeEventListener('abort', entry.abort!)
        if (this.active === entry) this.active = undefined
        entry.resolve(decision)
        this.viewStore.set(null)
        queueMicrotask(() => this.presentNext())
    }
}

export const securityConfirmationQueue = new SecurityConfirmationQueue()
export const securityConfirmationView = securityConfirmationQueue.view
