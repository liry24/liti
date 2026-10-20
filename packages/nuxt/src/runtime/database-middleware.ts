import { defineEventHandler } from 'nuxt/server'
import { useLitiRuntime } from '../nuxt/server'

export default defineEventHandler(async (event) => {
    await useLitiRuntime().initializeRequest?.(event)
})
