import { content } from '../../content'

export default defineEventHandler(async (event) => {
    const document = await content.collection('posts').get(getRouterParam(event, 'id')!)
    if (!document) throw createError({ statusCode: 404 })
    return document
})
