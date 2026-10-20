import {
    defineLitiConfig,
    array,
    image,
    markdown,
    object,
    relation,
    text,
    type InferLitiModels,
    type InferLitiPublicModels,
} from '../packages/liti/src'
import { createPublicClient, createLitiManagementClient } from '../packages/liti/src/client'

const config = defineLitiConfig({
    models: {
        authors: { fields: { slug: text(), name: text({ required: true }), bio: markdown() } },
        posts: {
            fields: {
                slug: text(),
                cover: image(),
                title: text({ required: true }),
                body: markdown(),
                author: relation('authors'),
                sections: array(object({ body: markdown({ required: true }) })),
            },
        },
        private: { fields: { slug: text(), secret: text({ required: true }) }, public: false },
    },
})

declare module '../packages/liti/src/public-client' {
    interface LitiClientRegistry {
        actions: {
            prepare: { input: { text?: string }; output: { text: string } }
            proofread: { input: { content: string }; output: { content: string } }
        }
        managementModels: InferLitiModels<typeof config>
        publicModels: InferLitiPublicModels<typeof config>
    }
}

const checkGeneratedRegistry = async (): Promise<void> => {
    const publicClient = createPublicClient()
    const posts = await publicClient.list('posts')
    const title: string = posts[0]!.data.title
    const url: string | undefined = posts[0]!.data.cover?.url
    const markdownNodes: import('comark').Node[] | undefined = posts[0]!.data.body?.nodes
    const nestedMarkdownNodes: import('comark').Node[] | undefined = posts[0]!.data.sections?.[0]?.body.nodes
    const relatedMarkdown: string | null | undefined = posts[0]!.data.author?.data.bio
    // @ts-expect-error Public content HTTP Markdown is a Comark document, not the stored source string.
    const markdownSource: string | undefined = posts[0]!.data.body
    const managementMarkdownSource: string | null | undefined = (
        await createLitiManagementClient().listEntries('posts')
    ).items[0]!.data.body
    void [markdownNodes, nestedMarkdownNodes, relatedMarkdown, markdownSource, managementMarkdownSource]
    const authorName: string | undefined = (await publicClient.get('authors', 'author'))?.data.name
    // @ts-expect-error Unknown public model names must fail without explicit generics.
    await publicClient.list('missing')
    // @ts-expect-error Private models have no public HTTP projection.
    await publicClient.get('private', 'entry')
    // @ts-expect-error Required public field type is inferred.
    const invalid: number = posts[0]!.data.title

    const explicit = createPublicClient<InferLitiPublicModels<typeof config>>()
    const explicitTitle: string = (await explicit.list('posts'))[0]!.data.title
    // @ts-expect-error Empty public registries do not fall back to accepting every model.
    await createPublicClient<{}>().list('posts')

    const management = createLitiManagementClient()
    const page = await management.listEntries('posts')
    const managementTitle: string = page.items[0]!.data.title
    const allPosts = await management.listAllEntries('posts', { limit: 25, locale: 'ja', q: 'Title' })
    const allTitle: string = allPosts[0]!.data.title
    const allEntries = await management.listAllEntries()
    const entryVersion: number = allEntries[0]!.version
    // @ts-expect-error listAllEntries rejects unknown configured model names.
    await management.listAllEntries('missing')
    // @ts-expect-error listAllEntries starts at offset zero and owns pagination progress.
    await management.listAllEntries('posts', { offset: 100 })
    // @ts-expect-error The model-specific shape remains inferred after pagination.
    const invalidAllTitle: number = allPosts[0]!.data.title
    void [allTitle, entryVersion, invalidAllTitle]
    const assetId: string | undefined =
        typeof page.items[0]!.data.cover === 'string' ? page.items[0]!.data.cover : page.items[0]!.data.cover?.id
    const mutation = await management.createEntry('posts', { data: { slug: 'new', title: 'New' } })
    if ('data' in mutation) {
        const savedTitle: string = mutation.data.title
        void savedTitle
    }
    // @ts-expect-error A mutation may be a receipt for an actor without readDraft.
    void mutation.data.title
    await management.createEntry('private', { data: { secret: 'Private' } })
    // @ts-expect-error Unknown management models must fail.
    await management.createEntry('missing', { data: {} })
    // @ts-expect-error Model required fields must be present.
    await management.createEntry('posts', { data: {} })
    // @ts-expect-error Model fields must have inferred value types.
    await management.createEntry('posts', { data: { title: 123 } })
    // @ts-expect-error Optimistic versions are required on update.
    await management.updateEntry('entry', { data: { slug: 'updated', title: 'Updated' } })
    // @ts-expect-error Updates must match one of the configured management model shapes.
    await management.updateEntry('entry', { data: { irrelevant: true }, expectedVersion: 1 })
    // @ts-expect-error Private model is omitted from inferred public map.
    const privatePublicEntry: InferLitiPublicModels<typeof config>['private'] = {}
    void privatePublicEntry
    void [title, url, authorName, invalid, explicitTitle, managementTitle, assetId]
}
void checkGeneratedRegistry
