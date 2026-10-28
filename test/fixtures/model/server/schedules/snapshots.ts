import { defineSchedule } from 'vite-hub/schedule'
import { models } from '../utils/models'
export default defineSchedule({
    cron: '* * * * *',
    handler: async ({ scheduledAt }) => {
        const result = await models.publishDue({ actor: { id: 'scheduler' } }, scheduledAt)
        if (result.failed.length) throw new AggregateError(result.failed.map((item) => item.error))
    },
})
