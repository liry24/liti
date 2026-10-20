import { defineEventHandler } from 'nuxt/server'
import { handleManagementRequest } from '../../../liti/src/server/http'
import { useLitiRuntime } from '../nuxt/server'
import { withLitiContext } from './context'

export default defineEventHandler(async (event) => {
    const runtime = useLitiRuntime()
    return withLitiContext(event.context, async () =>
        handleManagementRequest(await runtime.getLiti(event), event.req, runtime.managementBase, event),
    )
})
