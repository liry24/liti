import { defineEventHandler } from 'nuxt/server'
import { useAdmin } from 'liti/nuxt/server'
export default defineEventHandler((event) => useAdmin(event).actions.run('proofread', { content: 'Server helper' }))
