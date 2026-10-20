import { defineEventHandler } from 'nuxt/server'
import { runTask } from 'nitropack/runtime'

export default defineEventHandler(async () => (await runTask('liti:publish-due')).result)
