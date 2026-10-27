import { createModelContent } from '@litijs/model/content'
import { createModelRecords } from '@litijs/model/records'
import { content } from '../content'
import { games, stats, notes, tables } from '../models/definitions'
export const records = createModelRecords({
    models: [games, stats],
    tables,
    database: 'default',
    contentModels: [notes],
})
export const models = createModelContent({ content, workspace: 'content', models: [notes], records })
