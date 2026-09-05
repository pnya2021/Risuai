import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PartialEditController from './PartialEditController.svelte'

vi.mock('@lucide/svelte', () => ({ CheckIcon: () => {}, XIcon: () => {} }))
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: { zoomsize: 100, lineHeight: 1.25 } } }))
vi.mock('src/lang', () => ({ language: {
    cancel: 'Cancel', confirm: 'Confirm',
    partialEdit: {
        editButtonTooltip: 'Edit', deleteButtonTooltip: 'Delete', editModalTitle: 'Edit text',
        deleteModalTitle: 'Delete text', deleteConfirmMessage: 'Delete selected text?',
        deleteYes: 'Delete', deleteNo: 'Cancel', save: 'Save', cancel: 'Cancel',
        saveShortcut: 'Save', cancelShortcut: 'Cancel', matchFound: (method: string) => method,
        lineNumber: (line: number) => String(line),
    },
} }))

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
})

async function openPartialEdit(target: 'original' | 'translation', operation: 'save' | 'delete') {
    vi.stubGlobal('IntersectionObserver', class {
        constructor(private callback: IntersectionObserverCallback) {}
        observe(element: Element) { this.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
        disconnect() {}
    })
    const bodyRoot = document.createElement('div')
    const block = document.createElement('p')
    block.textContent = 'Selected paragraph'
    bodyRoot.appendChild(block)
    document.body.appendChild(bodyRoot)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(block)
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const state = $state({ messageData: 'Selected paragraph\n\nOriginal tail' })
    const saved = vi.fn()
    const component = mount(PartialEditController, {
        target: document.body,
        props: {
            get messageData() { return state.messageData },
            chatIndex: 0, bodyRoot, blockEditEnabled: true,
            translatedView: target === 'translation',
            getTranslationEditContext: async () => ({ key: 'translation-key', data: 'Selected paragraph\n\nTranslated tail' }),
        },
        events: { save: saved },
    })
    cleanups.push(() => unmount(component))
    flushSync()
    bodyRoot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }))
    await vi.waitFor(() => expect(document.querySelector('.partial-edit-btn-edit')).not.toBeNull())
    const action = operation === 'save' ? '.partial-edit-btn-edit' : '.partial-edit-btn-delete'
    document.querySelector<HTMLButtonElement>(action)!.click()
    await vi.waitFor(() => expect(document.querySelector(operation === 'save' ? '.partial-edit-modal' : '.partial-delete-modal')).not.toBeNull())
    // Let the existing delayed focus/scroll lifecycle finish before closing its textarea.
    if (operation === 'save') await vi.waitFor(() => expect(scrolled).toHaveBeenCalled())
    return { state, saved }
}

describe('PartialEditController concurrent Inlay preservation', () => {
    it.each(['save', 'delete'] as const)('preserves an Inlay appended while original %s is open', async (operation) => {
        const { state, saved } = await openPartialEdit('original', operation)
        state.messageData += '\n\n{{inlay::owned-image}}'
        flushSync()
        if (operation === 'save') {
            const textarea = document.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')!
            textarea.value = 'Edited paragraph'
            textarea.dispatchEvent(new Event('input', { bubbles: true }))
        }
        document.querySelector<HTMLButtonElement>(operation === 'save' ? '.partial-edit-save-btn' : '.partial-delete-confirm-btn')!.click()
        expect(saved).toHaveBeenCalledOnce()
        expect(saved.mock.calls[0][0].detail).toEqual({
            newData: operation === 'save'
                ? 'Edited paragraph\n\nOriginal tail\n\n{{inlay::owned-image}}'
                : 'Original tail\n\n{{inlay::owned-image}}',
            target: 'original', translationKey: undefined,
        })
    })

    it.each(['save', 'delete'] as const)('keeps captured translation text and key for translation %s', async (operation) => {
        const { state, saved } = await openPartialEdit('translation', operation)
        state.messageData += '\n\n{{inlay::owned-image}}'
        flushSync()
        if (operation === 'save') {
            const textarea = document.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')!
            textarea.value = 'Edited translation'
            textarea.dispatchEvent(new Event('input', { bubbles: true }))
        }
        document.querySelector<HTMLButtonElement>(operation === 'save' ? '.partial-edit-save-btn' : '.partial-delete-confirm-btn')!.click()
        expect(saved).toHaveBeenCalledOnce()
        expect(saved.mock.calls[0][0].detail).toEqual({
            newData: operation === 'save' ? 'Edited translation\n\nTranslated tail' : 'Translated tail',
            target: 'translation', translationKey: 'translation-key',
        })
        expect(state.messageData).toBe('Selected paragraph\n\nOriginal tail\n\n{{inlay::owned-image}}')
    })
})
