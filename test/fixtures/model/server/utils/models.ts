import { createModelContent } from '@litijs/model/content'
import { createModelRecords } from '@litijs/model/records'
import { content } from '../content'
import { posts, works, cards, games, gameStats, tables } from '../models/definitions'

export const records = createModelRecords({
    models: [games, gameStats],
    tables,
    database: 'default',
    contentModels: [posts, works],
})
export const models = createModelContent({ content, workspace: 'content', models: [posts, works, cards], records })
