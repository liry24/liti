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

// Environment plugin arrays replace complete declarations, including their inferred type.
const opaqueEnvironment = defineLitiConfig({
    plugins: [{ id: 'original', apiVersion: 1, models: { oldMarker: { fields: { value: text() } } } }],
    $production: {
        plugins: [{ id: 'production', apiVersion: 1, models: { replacement: { fields: { value: text() } } } }],
    },
})
declare const resolvedOpaque: ResolvedLitiConfig<typeof opaqueEnvironment, readonly ['production']>
const replacedPlugin: 'text' = resolvedOpaque.plugins[0].models.replacement.fields.value.kind
// @ts-expect-error The replacement plugin does not retain the previous plugin's keys.
void resolvedOpaque.plugins[0].models.oldMarker
void replacedPlugin

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
