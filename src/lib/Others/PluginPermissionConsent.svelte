<script lang="ts">
    import { securityConfirmationQueue, securityConfirmationView } from '../../ts/plugins/securityConfirmationQueue'

    const decide = (digest: string, presentationId: string, decision: boolean) =>
        securityConfirmationQueue.decide(digest, presentationId, decision)
    const modalDialog = (node: HTMLDialogElement) => {
        const previousFocus = document.activeElement as HTMLElement | null
        if (typeof node.showModal === 'function') node.showModal()
        else node.setAttribute('open', '')
        return { destroy: () => {
            if (node.open && typeof node.close === 'function') node.close()
            previousFocus?.focus()
        } }
    }
    const initialFocus = (node: HTMLButtonElement) => {
        queueMicrotask(() => node.focus())
    }
    const dialogKey = (event: KeyboardEvent, digest: string, presentationId: string) => {
        if (event.key === 'Escape') {
            event.preventDefault()
            decide(digest, presentationId, false)
        }
    }
</script>

{#if $securityConfirmationView}
    <div class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4">
        <dialog
            use:modalDialog
            role="alertdialog"
            aria-modal="true"
            aria-label={$securityConfirmationView.title}
            aria-describedby="plugin-permission-description"
            class="w-full max-w-lg rounded-lg border border-darkborderc bg-bgcolor p-5 text-textcolor shadow-xl"
            onkeydown={(event) => $securityConfirmationView && dialogKey(event, $securityConfirmationView.digest, $securityConfirmationView.presentationId)}
        >
            <h2 class="text-xl font-bold">{$securityConfirmationView.title}</h2>
            <p id="plugin-permission-description" class="mt-3 whitespace-pre-wrap text-textcolor2">
                {$securityConfirmationView.copy}
            </p>
            <div class="mt-5 flex justify-end gap-3">
                <button
                    use:initialFocus
                    type="button"
                    class="rounded border border-darkborderc px-4 py-2"
                    onclick={() => decide($securityConfirmationView!.digest, $securityConfirmationView!.presentationId, false)}
                >{$securityConfirmationView.denyLabel}</button>
                <button
                    type="button"
                    class="rounded bg-selected px-4 py-2"
                    onclick={() => decide($securityConfirmationView!.digest, $securityConfirmationView!.presentationId, true)}
                >{$securityConfirmationView.allowLabel}</button>
            </div>
        </dialog>
    </div>
{/if}
