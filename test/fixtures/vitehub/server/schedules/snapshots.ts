import { defineSchedule } from 'vite-hub/schedule'
import { publishSnapshots } from '../utils/snapshots'

export default defineSchedule({
    cron: '* * * * *',
    handler: ({ scheduledAt }) => publishSnapshots(scheduledAt),
})
