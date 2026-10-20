import { defineEventHandler } from 'nuxt/server'
import { handlePublicRequest } from '../../../liti/src/server/http'
import { useLitiRuntime } from '../nuxt/server'
import { withLitiContext } from './context'

export default defineEventHandler(async (event) => {
    const runtime = useLitiRuntime()
    return withLitiContext(event.context, async () =>
        handlePublicRequest(await runtime.getLiti(event), event.req, runtime.publicBase),
    )
})
