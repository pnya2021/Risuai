import { beforeEach, describe, expect, it } from 'vitest'
import {
    clearPrincipalTombstonesForTests,
    invalidatePluginPrincipal,
    isCanonicalPluginPrincipalId,
    normalizePluginPrincipals,
    preparePluginRecord,
    reconcileProgrammaticPluginRecords,
    stripPluginPrincipal,
} from './pluginPrincipal'

const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
]

const record = (name = 'demo', script = 'one') => ({
    name, script, arguments: {}, realArg: {}, customLink: [], argMeta: {},
})

describe('plugin principals', () => {
    beforeEach(() => clearPrincipalTombstonesForTests())

    it('assigns a host UUID to a fresh install and strips an incoming ID', () => {
        const installed = preparePluginRecord({ ...record(), principalId: ids[3] }, undefined, {
            kind: 'fresh-install', randomUUID: () => ids[0],
        })
        expect(installed.principalId).toBe(ids[0])
        expect(isCanonicalPluginPrincipalId(installed.principalId)).toBe(true)
    })

    it('retains identity for a trusted in-place update and hot reload', () => {
        const current = { ...record(), principalId: ids[0] }
        expect(preparePluginRecord(record('demo', 'two'), current, { kind: 'trusted-update' }).principalId).toBe(ids[0])
        expect(preparePluginRecord(record('demo', 'three'), current, { kind: 'hot-reload' }).principalId).toBe(ids[0])
    })

    it('isolates manual replacement and changed untrusted programmatic replacement', () => {
        const current = { ...record(), principalId: ids[0] }
        expect(preparePluginRecord(record('demo', 'two'), current, { kind: 'manual-replacement', randomUUID: () => ids[1] }).principalId).toBe(ids[1])
        expect(preparePluginRecord(record('demo', 'two'), current, { kind: 'programmatic', randomUUID: () => ids[2] }).principalId).toBe(ids[2])
        expect(preparePluginRecord(record(), current, { kind: 'programmatic' }).principalId).toBe(ids[0])
    })

    it('repairs missing, malformed, duplicate and tombstoned IDs', () => {
        invalidatePluginPrincipal(ids[0])
        const input = [
            { ...record('a'), principalId: ids[0] },
            { ...record('b'), principalId: 'not-a-uuid' },
            { ...record('c'), principalId: ids[1] },
            { ...record('d'), principalId: ids[1] },
        ]
        let i = 0
        const repaired = normalizePluginPrincipals(input, { randomUUID: () => ids[i++ + 2] ?? crypto.randomUUID() })
        expect(repaired.changed).toBe(true)
        expect(new Set(repaired.records.map((item) => item.principalId)).size).toBe(4)
        expect(repaired.records.every((item) => isCanonicalPluginPrincipalId(item.principalId))).toBe(true)
        expect(repaired.records.map((item) => item.principalId)).not.toContain(ids[0])
    })

    it('retries when a generated repair ID collides with one already seen in the pass', () => {
        let generated = 0
        const repaired = normalizePluginPrincipals([
            { ...record('a'), principalId: ids[0] },
            { ...record('b'), principalId: 'not-a-uuid' },
        ], { randomUUID: () => [ids[0], ids[1]][generated++] })

        expect(repaired.records.map((item) => item.principalId)).toEqual([ids[0], ids[1]])
    })

    it('prevents an invalidated principal from reactivating through an old save', () => {
        invalidatePluginPrincipal(ids[0])
        const restored = normalizePluginPrincipals([{ ...record(), principalId: ids[0] }], { randomUUID: () => ids[1] })
        expect(restored.records[0].principalId).toBe(ids[1])
    })

    it('reconciles a programmatic plugin-array replacement without trusting supplied IDs', () => {
        const current = [
            { ...record('same', 'one'), principalId: ids[0] },
            { ...record('changed', 'old'), principalId: ids[1] },
            { ...record('removed', 'gone'), principalId: ids[2] },
        ]
        let i = 0
        const next = reconcileProgrammaticPluginRecords(current, [
            { ...record('same', 'one'), principalId: ids[3] },
            { ...record('changed', 'new'), principalId: ids[1] },
            { ...record('fresh', 'new'), principalId: ids[0] },
        ], { randomUUID: () => [ids[3], '55555555-5555-4555-8555-555555555555'][i++] })
        expect(next.records[0].principalId).toBe(ids[0])
        expect(next.records[1].principalId).toBe(ids[3])
        expect(next.records[2].principalId).toBe('55555555-5555-4555-8555-555555555555')
        expect(next.invalidatedPrincipalIds).toEqual([ids[1], ids[2]])
    })

    it('never exposes the Host principal in a public plugin record', () => {
        const installed = { ...record(), principalId: ids[0] }
        expect(stripPluginPrincipal(installed)).toEqual(record())
        expect(installed.principalId).toBe(ids[0])
    })

    it('does not retain one principal for duplicate incoming records', () => {
        const current = [{ ...record('duplicate'), principalId: ids[0] }]
        const next = reconcileProgrammaticPluginRecords(current, [record('duplicate'), record('duplicate')], {
            randomUUID: () => ids[1],
        })
        expect(next.records.map((plugin) => plugin.principalId)).toEqual([ids[0], ids[1]])
        expect(next.invalidatedPrincipalIds).toEqual([])
    })
})
