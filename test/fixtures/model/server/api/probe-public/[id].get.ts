import { models } from '../../utils/models'
export default defineEventHandler(async (event) => {
    const entry = await models.read('posts', getRouterParam(event, 'id')!, 'ja')
    if (!entry) throw createError({ statusCode: 404 })
    return entry
})
