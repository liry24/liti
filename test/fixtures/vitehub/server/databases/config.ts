import { defineDatabase } from 'vite-hub/database'
import { user, session, account, verification } from '../database/auth-schema'

export default defineDatabase({ schema: { user, session, account, verification } })
