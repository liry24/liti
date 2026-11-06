import { expect, it } from 'vite-plus/test'
import { defineArticle } from '../packages/blog/src/model/article'
import { validateData } from '../packages/model/src/definition/validation'

it('uses the native Blob reference and picker schema for an optional article cover', async () => {
    const article = defineArticle({ name: 'articles', authorize: () => true })
    const data = { title: 'Picture', slug: 'picture', tags: [] }
    const cover = { pathname: 'images/cover.png', contentType: 'image/png', size: 68 }
    expect((await validateData(article.fields, { ...data, cover })).cover).toEqual(cover)
    expect((await validateData(article.fields, data)).cover).toBeUndefined()
    expect(article.fields.cover.schema['~standard'].jsonSchema.output({ target: 'draft-2020-12' })).toHaveProperty(
        'x-vitehub-blob.kind',
        'image',
    )
    await expect(validateData(article.fields, { ...data, cover: 'https://example.com/cover.png' })).rejects.toThrow(
        'Model validation failed',
    )
})
