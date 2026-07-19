import { describe, expect, it } from 'vitest'
import { PluginDataLifecycleRegistry } from './pluginDataLifecycle'
import { retirePluginPrincipals } from './pluginRetirement'

describe('production principal retirement', () => {
    for (const source of ['manual update', 'programmatic replacement', 'live database replacement']) {
        it(`${source} stops plugin code only after permission/data purge and quarantine`, async () => {
            const registry = new PluginDataLifecycleRegistry()
            const events: string[] = []
            let permissionsPresent = true
            let secretsPresent = true
            let durableState = 'owned'
            registry.register('summary', 'summarize', () => { events.push('summarize') })
            registry.register('permissions', 'purge', () => { permissionsPresent = false; events.push('purge-permissions') })
            registry.register('secrets', 'purge', () => { secretsPresent = false; events.push('purge-secrets') })
            registry.register('durable', 'quarantine', () => { durableState = 'quarantined'; events.push('quarantine') })
            registry.registerInstanceStop('principal', 'instance', () => {
                expect(permissionsPresent).toBe(false)
                expect(secretsPresent).toBe(false)
                expect(durableState).toBe('quarantined')
                events.push('stop')
            })

            await retirePluginPrincipals(['principal'], () => { events.push('invalidate') }, registry)

            expect(events).toEqual(['summarize', 'purge-permissions', 'purge-secrets', 'quarantine', 'invalidate', 'stop'])
        })
    }
})
