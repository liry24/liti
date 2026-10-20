import {
    defineLitiConfig,
    text,
    type ResolvedLitiConfig,
    type InferLitiModels,
    type InferLitiPublicModels,
} from '../packages/liti/src'

const common = defineLitiConfig({
    models: { posts: { fields: { slug: text(), title: text({ required: true }) } } },
    assets: { storage: 'content' },
    $production: { assets: { maxUploadSize: 2 } },
    $env: { staging: { assets: { maxUploadSize: 3 } } },
})
const required: true = common.models.posts.fields.title.required
void required

const environmentModels = defineLitiConfig({
    models: { posts: { fields: { slug: text(), title: text({ required: true }) } } },
    $production: {
        models: {
            posts: { public: false, fields: { slug: text(), summary: text({ required: true }) } },
            pages: { fields: { slug: text(), title: text({ required: true }) } },
        },
    },
})
type Production = ResolvedLitiConfig<typeof environmentModels, readonly ['production']>
const post: InferLitiModels<Production>['posts'] = { title: 'Title', summary: 'Summary' }
const page: InferLitiModels<Production>['pages'] = { title: 'Page' }
// @ts-expect-error Production adds the required summary field.
const missingSummary: InferLitiModels<Production>['posts'] = { title: 'Title' }
// @ts-expect-error Production marks posts private.
type PrivatePublicPost = InferLitiPublicModels<Production>['posts']
void post
void page
void missingSummary
const noPrivatePost: PrivatePublicPost = undefined
void noPrivatePost

// Application-owned adapters and SDK models replace as opaque values, including inferred types.
declare const originalModel: import('ai/test').MockLanguageModelV4 & { oldMarker: true }
declare const productionModel: import('ai/test').MockLanguageModelV4 & { replacement: true }
const opaqueEnvironment = defineLitiConfig({
    models: {},
    ai: { model: originalModel },
    $production: { ai: { model: productionModel } },
})
declare const resolvedOpaque: ResolvedLitiConfig<typeof opaqueEnvironment, readonly ['production']>
const replacedModel: true = resolvedOpaque.ai.model.replacement
// @ts-expect-error Replaced SDK model does not retain the old instance's keys.
void resolvedOpaque.ai.model.oldMarker
void replacedModel

// @ts-expect-error An environment replaces the whole SDK model, never a partial provider descriptor.
defineLitiConfig({ models: {}, $production: { ai: { model: { specificationVersion: 'v4' } } } })

const seoImageEnvironment = defineLitiConfig({
    models: {},
    seo: { image: { component: 'First', props: { old: true } } },
    $production: { seo: { image: { component: 'Second', props: { replacement: true } } } },
})
declare const resolvedImage: ResolvedLitiConfig<typeof seoImageEnvironment, readonly ['production']>
// @ts-expect-error Replaced component descriptors do not retain old props.
void resolvedImage.seo.image.props.old
const productionImage: true = resolvedImage.seo.image.props.replacement
void productionImage
// @ts-expect-error An environment image override must be a complete component descriptor.
defineLitiConfig({ models: {}, $production: { seo: { image: { props: { title: 'Incomplete' } } } } })
