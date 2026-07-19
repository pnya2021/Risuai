import { describe, expect, it, vi } from 'vitest'
import { persistRestoredDatabaseAndInvalidateEncoder } from './restoredDatabaseState'

describe('restored database encoder state', () => {
    it('forces the first incremental save to rebuild from the restored durable snapshot', async () => {
        const reloadState = { state: false }
        const events: string[] = []
        await persistRestoredDatabaseAndInvalidateEncoder(async () => { events.push('persist-restored') }, reloadState)
        if (reloadState.state) events.push('reinitialize-before-save')
        expect(events).toEqual(['persist-restored', 'reinitialize-before-save'])
    })

    it('does not advertise a restored baseline when durable persistence fails', async () => {
        const reloadState = { state: false }
        await expect(persistRestoredDatabaseAndInvalidateEncoder(
            vi.fn(async () => { throw new Error('write failed') }), reloadState,
        )).rejects.toThrow('write failed')
        expect(reloadState.state).toBe(false)
    })
})
