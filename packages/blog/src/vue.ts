import { computed, shallowRef, watch } from 'vue'
import { LitiError } from 'liti'
import type { LitiFormExtensionFactory, LitiFormExtensionRegistry } from 'liti/vue'
import type { BlogEditorOptions } from './index'
import { validateProofreading, type ProofreadingOptions } from './proofreading'

export const createBlogForm =
    (protection: ProofreadingOptions = {}) =>
    (context: Parameters<LitiFormExtensionFactory>[0]) => {
        const options = computed(() => context.descriptor.value?.editor?.blog as BlogEditorOptions | undefined)
        const content = () => String(context.values.value[options.value?.fields.content ?? 'content'] ?? '')
        const status = shallowRef<'idle' | 'pending' | 'success' | 'error'>('idle')
        const error = shallowRef<unknown>()
        const original = shallowRef<string | null>(null)
        const proposal = shallowRef<string | null>(null)
        const invalid = shallowRef(false)
        const applying = shallowRef(false)
        const decision = shallowRef<'pending' | 'applied' | 'discarded'>('pending')
        const reviewedContent = shallowRef<string | null>(null)
        let sequence = 0
        let identity = ''
        let controller: AbortController | undefined
        const cancel = () => {
            sequence++
            controller?.abort()
            controller = undefined
            applying.value = false
        }
        const reset = () => {
            cancel()
            status.value = 'idle'
            error.value = undefined
            original.value = proposal.value = reviewedContent.value = null
            invalid.value = false
            applying.value = false
            decision.value = 'pending'
        }
        watch(context.identity, reset, { flush: 'sync' })
        context.signal.addEventListener('abort', cancel, { once: true })
        const stale = computed(
            () => original.value !== null && (identity !== context.identity.value || content() !== original.value),
        )
        const available = computed(() => Boolean(options.value?.proofreading))
        const review = computed(() => ({
            availability: available.value ? ('available' as const) : ('unavailable' as const),
            reason: available.value ? null : options.value ? 'not-configured' : 'not-ready',
            status: status.value,
            original: original.value,
            proposal: proposal.value,
            stale: decision.value === 'pending' && stale.value,
            invalid: invalid.value,
            applied: decision.value === 'applied',
            applying: applying.value,
            discarded: decision.value === 'discarded',
            canApply:
                status.value === 'success' &&
                proposal.value !== null &&
                decision.value === 'pending' &&
                !stale.value &&
                !invalid.value &&
                !context.busy.value &&
                !applying.value,
            error: error.value,
        }))
        const failure = (message: string): never => {
            const failureError = new LitiError('LITI_INVALID_INPUT', message)
            context.report(failureError)
            throw failureError
        }
        const publicationBlocked = () => {
            if (applying.value) return 'applying-proofreading'
            if (status.value === 'pending') return 'proofreading'
            if (options.value?.guard === 'none') return undefined
            if (proposal.value !== null && decision.value === 'pending') return 'review-pending'
            if (options.value?.guard === 'required' && reviewedContent.value !== content()) return 'review-required'
            return undefined
        }
        const namespace = {
            review,
            async proofread(this: void): Promise<void> {
                if (!available.value) return failure('Proofreading is not configured for this model.')
                if (context.busy.value || applying.value)
                    return failure('Wait for the current form operation before proofreading.')
                if (!content().trim()) return failure('Write content before proofreading.')
                cancel()
                const token = sequence
                controller = new AbortController()
                const signal = AbortSignal.any([controller.signal, context.signal])
                identity = context.identity.value
                original.value = content()
                const source = original.value
                proposal.value = null
                invalid.value = false
                decision.value = 'pending'
                error.value = undefined
                status.value = 'pending'
                try {
                    const result = await context.executeAction(
                        options.value!.proofreading!,
                        { content: source },
                        { signal },
                    )
                    signal.throwIfAborted()
                    if (token !== sequence || identity !== context.identity.value) return
                    const candidate =
                        result.data && typeof result.data === 'object' && 'content' in result.data
                            ? result.data.content
                            : undefined
                    if (typeof candidate !== 'string')
                        throw new LitiError('LITI_ACTION_OUTPUT_INVALID', 'Proofreading returned no content.')
                    const valid = await validateProofreading(source, candidate, protection)
                    signal.throwIfAborted()
                    if (token !== sequence) return
                    proposal.value = candidate
                    invalid.value = !valid
                    status.value = 'success'
                } catch (cause) {
                    if (signal.aborted || token !== sequence) return
                    status.value = 'error'
                    error.value = context.report(cause)
                    throw cause
                }
            },
            async applyProofreading(this: void): Promise<void> {
                if (!review.value.canApply || proposal.value === null || original.value === null)
                    return failure('This proofreading proposal cannot be applied to the current content.')
                const token = sequence,
                    candidate = proposal.value,
                    source = original.value
                applying.value = true
                try {
                    if (!(await validateProofreading(source, candidate, protection))) {
                        invalid.value = true
                        return failure('Protected Markdown must remain unchanged.')
                    }
                    if (token !== sequence || identity !== context.identity.value || context.signal.aborted) return
                    if (content() !== source || context.busy.value)
                        return failure('Content changed before proofreading could be applied.')
                    context.setField(options.value!.fields.content, candidate)
                    decision.value = 'applied'
                    reviewedContent.value = candidate
                } finally {
                    if (token === sequence) applying.value = false
                }
            },
            discardProofreading(this: void): void {
                if (original.value !== null && !stale.value && !invalid.value && status.value === 'success')
                    reviewedContent.value = original.value
                cancel()
                decision.value = 'discarded'
                if (status.value === 'pending') status.value = 'idle'
            },
        }
        return {
            namespace,
            state: computed(() => {
                const reason = publicationBlocked()
                return {
                    busy: status.value === 'pending' || applying.value,
                    can: {
                        proofread:
                            available.value &&
                            !context.busy.value &&
                            !applying.value &&
                            status.value !== 'pending' &&
                            Boolean(content().trim()),
                        applyProofreading: review.value.canApply,
                        discardProofreading:
                            !context.busy.value &&
                            (status.value === 'pending' || (proposal.value !== null && decision.value === 'pending')),
                        publish: !reason,
                        schedule: !reason,
                    },
                    blocked: {
                        ...(reason ? { publish: reason, schedule: reason } : {}),
                        ...(!available.value ? { proofread: options.value ? 'not-configured' : 'not-ready' } : {}),
                        ...(stale.value
                            ? { applyProofreading: 'stale' }
                            : invalid.value
                              ? { applyProofreading: 'invalid' }
                              : {}),
                    },
                }
            }),
            beforeSubmit(operation: 'save' | 'publish' | 'schedule') {
                if (applying.value) failure('Wait for proofreading to finish applying.')
                if (operation !== 'save' && publicationBlocked())
                    failure('Resolve proofreading before publishing or scheduling.')
            },
        }
    }

export type BlogForm = ReturnType<ReturnType<typeof createBlogForm>>['namespace']
declare module 'liti/vue' {
    interface LitiFormExtensionTypes {
        blog: BlogForm
    }
}
export default { blog: createBlogForm() } satisfies LitiFormExtensionRegistry
