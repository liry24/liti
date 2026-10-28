import { betterAuth } from 'better-auth'

export const auth = betterAuth({
    secret: 'synthetic-schema-generation-key-2026-10-27',
    emailAndPassword: { enabled: true },
})
