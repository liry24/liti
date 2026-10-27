import { createError, defineEventHandler, getHeader } from 'h3'
import { verifyContentContracts } from '../utils/contracts'

export default defineEventHandler(async (event) => {
    const token = process.env.LITI_PROBE_TOKEN
    if (!token || getHeader(event, 'x-liti-probe') !== token)
        throw createError({ status: 403, message: 'Probe authorization required' })
    return await verifyContentContracts()
})
