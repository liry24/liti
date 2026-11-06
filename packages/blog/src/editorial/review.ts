import { ModelError } from '@litijs/model'
import { validateProofreading, type ProofreadingOptions } from './markdown'

export interface EditorialSource {
    identity: string
    body: string
    revision?: string
}
export interface EditorialProposal {
    body: string
}
export interface EditorialState {
    status: 'idle' | 'pending' | 'proposed' | 'applied' | 'discarded' | 'error'
    source: EditorialSource | null
    proposal: EditorialProposal | null
    error: unknown
}
export function createEditorialReview(
    options: ProofreadingOptions & { changed?(state: Readonly<EditorialState>): void } = {},
) {
    let state: Readonly<EditorialState> = Object.freeze({ status: 'idle', source: null, proposal: null, error: null })
    let sequence = 0,
        controller: AbortController | undefined,
        applying = false
    const change = (value: EditorialState) => {
        state = Object.freeze(value)
        options.changed?.(state)
    }
    const cancel = () => {
        sequence++
        controller?.abort()
        controller = undefined
    }
    const reset = () => {
        cancel()
        change({ status: 'idle', source: null, proposal: null, error: null })
    }
    const matches = (current: EditorialSource) =>
        current.identity === state.source?.identity &&
        current.body === state.source.body &&
        current.revision === state.source.revision
    return {
        get state() {
            return state
        },
        cancel: reset,
        reset,
        stale: (current: EditorialSource) => state.source !== null && !matches(current),
        async propose(
            this: void,
            source: EditorialSource,
            execute: (input: EditorialProposal, signal: AbortSignal) => Promise<unknown>,
            input: { signal?: AbortSignal; timeout?: number } = {},
        ) {
            cancel()
            if (input.timeout !== undefined && (!Number.isSafeInteger(input.timeout) || input.timeout <= 0))
                throw new ModelError('LITI_INVALID_INPUT', 'Provide a positive proofreading timeout.')
            if (!source.body.trim()) throw new ModelError('LITI_INVALID_INPUT', 'Write content before proofreading.')
            const token = sequence
            controller = new AbortController()
            const signal = AbortSignal.any([
                controller.signal,
                ...(input.signal ? [input.signal] : []),
                ...(input.timeout ? [AbortSignal.timeout(input.timeout)] : []),
            ])
            const captured = Object.freeze({ ...source })
            change({ status: 'pending', source: captured, proposal: null, error: null })
            try {
                signal.throwIfAborted()
                let aborted: (() => void) | undefined
                let value: unknown
                try {
                    value = await Promise.race([
                        execute({ body: source.body }, signal),
                        new Promise<never>((_resolve, reject) => {
                            aborted = () => reject(signal.reason)
                            signal.addEventListener('abort', aborted, { once: true })
                            if (signal.aborted) aborted()
                        }),
                    ])
                } finally {
                    if (aborted) signal.removeEventListener('abort', aborted)
                }
                signal.throwIfAborted()
                if (
                    !value ||
                    typeof value !== 'object' ||
                    !('body' in value) ||
                    typeof value.body !== 'string' ||
                    Object.keys(value).some((key) => key !== 'body')
                )
                    throw new ModelError('LITI_INVALID_INPUT', 'Proofreading returned invalid structured output.')
                if (!(await validateProofreading(source.body, value.body, options)))
                    throw new ModelError('LITI_INVALID_INPUT', 'Proofreading changed protected Markdown.')
                signal.throwIfAborted()
                if (token === sequence)
                    change({
                        status: 'proposed',
                        source: captured,
                        proposal: Object.freeze({ body: value.body }),
                        error: null,
                    })
            } catch (error) {
                if (token === sequence) change({ status: 'error', source: captured, proposal: null, error })
                throw error
            }
        },
        async apply(this: void, read: () => EditorialSource, write: (body: string) => void) {
            if (applying || state.status !== 'proposed' || !state.proposal || !state.source || !matches(read()))
                throw new ModelError('LITI_CONFLICT', 'Review the current article before applying proofreading.')
            const token = sequence,
                proposal = state.proposal,
                source = state.source
            applying = true
            try {
                if (!(await validateProofreading(source.body, proposal.body, options)))
                    throw new ModelError('LITI_INVALID_INPUT', 'Proofreading changed protected Markdown.')
                if (token !== sequence || state.status !== 'proposed' || !matches(read()))
                    throw new ModelError('LITI_CONFLICT', 'The article changed while applying proofreading.')
                write(proposal.body)
                change({ status: 'applied', source, proposal, error: null })
            } finally {
                applying = false
            }
        },
        discard(this: void) {
            cancel()
            change({ ...state, status: 'discarded', error: null })
        },
    }
}
