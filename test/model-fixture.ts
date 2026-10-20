import { createLitiDescriptor } from '../packages/liti/src/descriptor'
import { ref, shallowRef } from 'vue'
import { defineLitiConfig, image, images, object, select, text } from '../packages/liti/src'
import { createLitiManagementClient, type LitiEntry, type LitiClientOptions } from '../packages/liti/src/client'
import {
    createLitiModel,
    type LitiModelState,
    type LitiSessionDraft,
    type EntryPrepareContext,
} from '../packages/vue/src/model'
import type { ModelDescriptor } from '../packages/liti/src/descriptor'

export const formConfig = defineLitiConfig({
    models: {
        posts: {
            sortable: true,
            fields: {
                slug: text(),
                title: text({ required: true, minLength: 1 }),
                optional: text(),
                image: image(),
                gallery: images(),
                publication: object({ slug: select(['auto', 'manual']) }),
            },
        },
    },
})
export const formDescriptor = createLitiDescriptor(formConfig).models.posts!
export const modelEntry = (
    id = 'one',
    version = 1,
    data: Record<string, unknown> = { title: 'Initial' },
): LitiEntry => ({
    id,
    version,
    model: 'posts',
    data,
    locale: '',
    defaultLocale: '',
    translations: {},
    createdAt: '',
    updatedAt: '',
    currentRevisionId: 'revision',
    revisionId: 'revision',
    publishedRevisionId: null,
    publishedAt: null,
    firstPublishedAt: null,
    scheduledAt: null,
    scheduledRevisionId: null,
    sortOrder: null,
})
export const modelFixture = (
    request: NonNullable<LitiClientOptions['fetch']>,
    initial: LitiEntry | null = modelEntry(),
    drafts: Record<string, LitiSessionDraft> = {},
    options: {
        model: string
        descriptor: ModelDescriptor
        defaultLocale?: string
        prepare?: (context: EntryPrepareContext) => Promise<void>
    } = { model: 'posts', descriptor: formDescriptor },
) => {
    const identity = ref('alice:posts:' + (initial?.id ?? 'new'))
    const id = ref(initial?.id ?? null)
    const state: LitiModelState<Record<string, unknown>> = {
        data: shallowRef(initial),
        status: ref('success'),
        error: shallowRef(),
        refresh: async () => {},
    }
    const client = createLitiManagementClient<Record<string, Record<string, unknown>>>({
        origin: 'http://site.test',
        fetch: request,
    })
    const actions = createLitiModel(state, {
        model: options.model,
        ...(options.defaultLocale ? { defaultLocale: options.defaultLocale } : {}),
        id,
        identity,
        group: identity,
        scope: 'alice',
        descriptor: shallowRef(options.descriptor),
        locale: ref(undefined),
        client,
        drafts,
        ...(options.prepare ? { prepare: options.prepare } : {}),
    })
    return { state, resource: Object.assign(state, actions), client, identity, id, drafts }
}
