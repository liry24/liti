import { defineAuth } from 'vite-hub/auth'
import { useDatabase } from 'vite-hub/database/drizzle'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import * as authSchema from './database/auth-schema'

export default defineAuth({
    database: true,
    emailAndPassword: { enabled: true },
    runtime: ({ requestOrigin }) => ({
        secret: process.env.LITI_PROBE_TOKEN,
        baseURL: requestOrigin,
        database: drizzleAdapter(useDatabase('default').db, { provider: 'sqlite', schema: authSchema }),
    }),
})
