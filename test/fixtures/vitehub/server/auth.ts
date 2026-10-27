import { defineAuth } from 'vite-hub/auth'

export default defineAuth({
    database: true,
    emailAndPassword: { enabled: true },
    runtime: ({ requestOrigin }) => ({
        secret: process.env.LITI_PROBE_TOKEN,
        baseURL: requestOrigin,
    }),
})
