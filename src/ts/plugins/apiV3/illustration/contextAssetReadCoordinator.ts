import { PluginApiError } from './errors'

export type ContextAssetReadLane = 'thumbnail' | 'original' | 'digest'

export interface ContextAssetReadOwner {
    principalId: string
    instanceId: string
}

export interface ContextAssetReadRequest<T> {
    owner: ContextAssetReadOwner
    lane: ContextAssetReadLane
    signal?: AbortSignal
    run(signal: AbortSignal): Promise<T>
}

const MAX_ACTIVE_READS = 4
const MAX_ACTIVE_ORIGINAL_READS = 1
const MAX_QUEUED_READS = 128
const lanes: readonly ContextAssetReadLane[] = ['thumbnail', 'original', 'digest']

interface ReadJob {
    principalId: string
    instanceId: string
    lane: ContextAssetReadLane
    ticket: number
    callerSignal?: AbortSignal
    callerAbortListener?: () => void
    controller?: AbortController
    run?: (signal: AbortSignal) => Promise<unknown>
    resolve?: (value: unknown) => void
    reject?: (reason: unknown) => void
    state: 'queued' | 'active' | 'settled'
    cancelled: boolean
}

interface PrincipalReadState {
    principalId: string
    queues: Record<ContextAssetReadLane, ReadJob[]>
    active: Set<ReadJob>
    queuedCount: number
    activeCount: number
    activeOriginalCount: number
    retiring: boolean
}

type PhysicalReadOutcome =
    | { status: 'fulfilled', value: unknown }
    | { status: 'rejected', reason: unknown }

const abortedError = () => new PluginApiError('ABORTED', 'Context asset read was cancelled')

const queueLimitError = () => new PluginApiError(
    'RESOURCE_LIMIT',
    'Context asset read queue is full',
    { retryable: true },
)

export class ContextAssetReadCoordinator {
    private readonly principals = new Map<string, PrincipalReadState>()
    private nextTicket = 0

    schedule<T>(request: ContextAssetReadRequest<T>): Promise<T> {
        if (request.signal?.aborted) return Promise.reject(abortedError())

        let state = this.principals.get(request.owner.principalId)
        if (state?.retiring) return Promise.reject(abortedError())
        if (!state) {
            state = {
                principalId: request.owner.principalId,
                queues: { thumbnail: [], original: [], digest: [] },
                active: new Set(),
                queuedCount: 0,
                activeCount: 0,
                activeOriginalCount: 0,
                retiring: false,
            }
            this.principals.set(request.owner.principalId, state)
        }

        let job!: ReadJob
        const result = new Promise<T>((resolve, reject) => {
            job = {
                principalId: request.owner.principalId,
                instanceId: request.owner.instanceId,
                lane: request.lane,
                ticket: this.nextTicket,
                callerSignal: request.signal,
                run: request.run,
                resolve: resolve as (value: unknown) => void,
                reject,
                state: 'queued',
                cancelled: false,
            }
            this.nextTicket += 1
        })

        if (request.signal) {
            job.callerAbortListener = () => this.cancelJob(state!, job)
            request.signal.addEventListener('abort', job.callerAbortListener, { once: true })
            if (request.signal.aborted) {
                this.cancelJob(state, job)
                return result
            }
        }

        state.queues[request.lane].push(job)
        state.queuedCount += 1
        this.pump(state)

        if (job.state === 'queued' && state.queuedCount > MAX_QUEUED_READS) {
            this.removeQueuedJob(state, job)
            this.settleQueuedJob(state, job, queueLimitError())
        }

        return result
    }

    cancelInstance(owner: ContextAssetReadOwner): void {
        const state = this.principals.get(owner.principalId)
        if (!state) return

        for (const lane of lanes) {
            for (const job of [...state.queues[lane]]) {
                if (job.instanceId === owner.instanceId) this.cancelJob(state, job)
            }
        }
        for (const job of [...state.active]) {
            if (job.instanceId === owner.instanceId) this.cancelJob(state, job)
        }
    }

    retirePrincipal(principalId: string): void {
        const state = this.principals.get(principalId)
        if (!state) return

        state.retiring = true
        for (const lane of lanes) {
            for (const job of [...state.queues[lane]]) this.cancelJob(state, job)
        }
        for (const job of [...state.active]) this.cancelJob(state, job)
        this.removeIdleState(state)
    }

    private cancelJob(state: PrincipalReadState, job: ReadJob): void {
        if (job.state === 'settled' || job.cancelled) return
        job.cancelled = true
        this.removeCallerAbortListener(job)

        if (job.state === 'queued') {
            this.removeQueuedJob(state, job)
            this.settleQueuedJob(state, job, abortedError())
            return
        }

        job.controller?.abort()
        const reject = job.reject
        job.resolve = undefined
        job.reject = undefined
        reject?.(abortedError())
    }

    private removeQueuedJob(state: PrincipalReadState, job: ReadJob): void {
        if (job.state !== 'queued') return
        const queue = state.queues[job.lane]
        const index = queue.indexOf(job)
        if (index === -1) return
        queue.splice(index, 1)
        state.queuedCount -= 1
    }

    private settleQueuedJob(state: PrincipalReadState, job: ReadJob, error: PluginApiError): void {
        job.state = 'settled'
        this.removeCallerAbortListener(job)
        const reject = job.reject
        this.releaseJobReferences(job)
        reject?.(error)
        this.pump(state)
        this.removeIdleState(state)
    }

    private pump(state: PrincipalReadState): void {
        if (state.retiring) return
        while (state.activeCount < MAX_ACTIVE_READS) {
            const job = this.oldestEligibleHead(state)
            if (!job) return
            this.start(state, job)
        }
    }

    private oldestEligibleHead(state: PrincipalReadState): ReadJob | undefined {
        let oldest: ReadJob | undefined
        for (const lane of lanes) {
            if (lane === 'original' && state.activeOriginalCount >= MAX_ACTIVE_ORIGINAL_READS) continue
            const head = state.queues[lane][0]
            if (head && (!oldest || head.ticket < oldest.ticket)) oldest = head
        }
        return oldest
    }

    private start(state: PrincipalReadState, job: ReadJob): void {
        state.queues[job.lane].shift()
        state.queuedCount -= 1
        state.active.add(job)
        state.activeCount += 1
        if (job.lane === 'original') state.activeOriginalCount += 1
        job.state = 'active'
        job.controller = new AbortController()

        const run = job.run!
        job.run = undefined
        let physicalRead: Promise<unknown>
        try {
            physicalRead = Promise.resolve(run(job.controller.signal))
        } catch (error) {
            physicalRead = Promise.reject(error)
        }
        physicalRead.then(
            (value) => this.settleActiveJob(state, job, { status: 'fulfilled', value }),
            (reason: unknown) => this.settleActiveJob(state, job, { status: 'rejected', reason }),
        )
    }

    private settleActiveJob(
        state: PrincipalReadState,
        job: ReadJob,
        outcome: PhysicalReadOutcome,
    ): void {
        state.active.delete(job)
        state.activeCount -= 1
        if (job.lane === 'original') state.activeOriginalCount -= 1
        job.state = 'settled'
        this.removeCallerAbortListener(job)

        const resolve = job.resolve
        const reject = job.reject
        const cancelled = job.cancelled
        this.releaseJobReferences(job)
        if (cancelled) return this.finishPhysicalJob(state)
        if (outcome.status === 'rejected') reject?.(outcome.reason)
        else resolve?.(outcome.value)

        this.finishPhysicalJob(state)
    }

    private finishPhysicalJob(state: PrincipalReadState): void {
        this.pump(state)
        this.removeIdleState(state)
    }

    private removeCallerAbortListener(job: ReadJob): void {
        if (job.callerSignal && job.callerAbortListener) {
            job.callerSignal.removeEventListener('abort', job.callerAbortListener)
        }
        job.callerSignal = undefined
        job.callerAbortListener = undefined
    }

    private releaseJobReferences(job: ReadJob): void {
        job.run = undefined
        job.resolve = undefined
        job.reject = undefined
        job.controller = undefined
        job.callerSignal = undefined
        job.callerAbortListener = undefined
    }

    private removeIdleState(state: PrincipalReadState): void {
        if (
            state.activeCount === 0
            && state.queuedCount === 0
            && this.principals.get(state.principalId) === state
        ) this.principals.delete(state.principalId)
    }
}

export const contextAssetReadCoordinator = new ContextAssetReadCoordinator()
