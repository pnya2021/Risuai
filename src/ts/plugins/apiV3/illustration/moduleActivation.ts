export type ModuleActivationReason = 'global' | 'chat' | 'character' | 'persona' | 'integration'

export interface ModuleActivationCandidate {
    id: string
    namespace?: string
}
export interface ModuleActivationInputs<T extends ModuleActivationCandidate> {
    global?: readonly string[]
    chat?: readonly string[]
    character?: readonly string[]
    integration?: readonly string[]
    personaModule?: T | null
}

const ACTIVATION_ORDER = ['global', 'chat', 'character', 'persona', 'integration'] as const

const selectedBy = (candidate: ModuleActivationCandidate, selected: ReadonlySet<string>) =>
    selected.has(candidate.id) || (candidate.namespace !== undefined && selected.has(candidate.namespace))

export function resolveModuleActivations<T extends ModuleActivationCandidate>(
    installed: readonly T[],
    inputs: ModuleActivationInputs<T>,
): Array<{ module: T; activatedBy: ModuleActivationReason[] }> {
    const selections = {
        global: new Set(inputs.global ?? []),
        chat: new Set(inputs.chat ?? []),
        character: new Set(inputs.character ?? []),
        integration: new Set(inputs.integration ?? []),
    }
    const records = new Map<string, { module: T; reasons: Set<ModuleActivationReason> }>()
    for (const module of installed) {
        const reasons = new Set<ModuleActivationReason>()
        if (selectedBy(module, selections.global)) reasons.add('global')
        if (selectedBy(module, selections.chat)) reasons.add('chat')
        if (selectedBy(module, selections.character)) reasons.add('character')
        if (selectedBy(module, selections.integration)) reasons.add('integration')
        if (reasons.size > 0 && !records.has(module.id)) records.set(module.id, { module, reasons })
    }

    const personaModule = inputs.personaModule
    if (personaModule) {
        const existing = records.get(personaModule.id)
        if (existing) existing.reasons.add('persona')
        else records.set(personaModule.id, { module: personaModule, reasons: new Set(['persona']) })
    }

    return [...records.values()].map(({ module, reasons }) => ({
        module,
        activatedBy: ACTIVATION_ORDER.filter((reason) => reasons.has(reason)),
    }))
}
