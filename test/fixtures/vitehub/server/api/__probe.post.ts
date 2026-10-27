import { createError, defineEventHandler, getHeader } from 'h3'
import { verifyContentContracts } from '../utils/contracts'
import { verifyRecords } from '../utils/records'
import { verifyAgents } from '../utils/agents'
import { verifySchedules } from '../utils/schedules'

export default defineEventHandler(async (event) => {
    const token = process.env.LITI_PROBE_TOKEN
    if (!token || getHeader(event, 'x-liti-probe') !== token)
        throw createError({ status: 403, message: 'Probe authorization required' })
    const result = await verifyContentContracts()
    result.checks.push(...(await verifyRecords()))
    result.checks.push(...(await verifyAgents()))
    result.checks.push(...(await verifySchedules()))
    return result
})
