import {
    computed,
    getCurrentScope,
    onScopeDispose,
    shallowRef,
    toValue,
    watch,
    h,
    defineComponent,
    type MaybeRefOrGetter,
} from 'vue'
import { createEditorialReview, type EditorialProposal, type EditorialSource } from '../editorial/review'
import type { ProofreadingOptions } from '../editorial/markdown'
import { articleDates } from '../model/publication'
import type { ContentEntry } from '@litijs/model/content'

export function useArticleReview(
    options: ProofreadingOptions & {
        source: MaybeRefOrGetter<EditorialSource>
        execute(this: void, input: EditorialProposal, signal: AbortSignal): Promise<unknown>
        apply(this: void, body: string): void
    },
) {
    const controller = createEditorialReview({
        ...options,
        changed: (value) => {
            state.value = value
        },
    })
    const state = shallowRef(controller.state)
    const source = () => toValue(options.source)
    watch(() => source().identity, controller.reset, { flush: 'sync' })
    if (getCurrentScope()) onScopeDispose(controller.cancel)
    return {
        state,
        stale: computed(() => controller.stale(source())),
        canApply: computed(() => state.value.status === 'proposed' && !controller.stale(source())),
        propose: (input?: { signal?: AbortSignal; timeout?: number }) =>
            controller.propose(source(), options.execute, input),
        apply: () => controller.apply(source, options.apply),
        discard: controller.discard,
        cancel: controller.cancel,
    }
}

export const ArticleDate = defineComponent(
    (props: { entry: Pick<ContentEntry, 'data' | 'publication'>; locale?: string }) => () => {
        const date = articleDates(props.entry).date
        if (!date) return null
        return h(
            'time',
            { datetime: date },
            new Intl.DateTimeFormat(props.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date)),
        )
    },
    { name: 'LitiArticleDate', props: ['entry', 'locale'] },
)
