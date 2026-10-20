import { defineLitiConfig, defineLitiPlugin, resolveLitiConfig, text } from '../packages/liti/src'
import type { InferLitiModels } from '../packages/liti/src'
import { z } from 'zod'

const config = resolveLitiConfig(
    defineLitiConfig({
        plugins: [
            defineLitiPlugin({
                id: 'example',
                apiVersion: 1,
                models: { posts: { fields: { title: text({ required: true }) } } },
                actions: {
                    slug: {
                        input: z.object({ title: z.string() }),
                        output: z.object({ slug: z.string() }),
                        execute: ({ title }: { title: string }) => ({ slug: title }),
                    },
                },
            }),
        ],
    }),
    [],
)

const title: true = config.models.posts.fields.title.required
const post: InferLitiModels<typeof config>['posts'] = { title: 'Title' }
// @ts-expect-error Plugin model fields retain their required values.
const missingTitle: InferLitiModels<typeof config>['posts'] = {}
// @ts-expect-error Plugin model names do not widen into an arbitrary dictionary.
type UnknownModel = InferLitiModels<typeof config>['unknown']
// @ts-expect-error A provider belongs to exactly one role.
defineLitiConfig({ adapter: { auth: { id: 'db', role: 'database', connect: () => null } } })
// @ts-expect-error Environment overrides replace whole database providers.
defineLitiConfig({ $production: { adapter: { database: { id: 'partial' } } } })
void title
void post
void missingTitle
declare const unknown: UnknownModel
void unknown
