import { defineEventHandler } from 'nuxt/server'
import { handleActionRequest } from '../../../liti/src/server/actions-http'
import { useLitiRuntime } from '../nuxt/server'
import { LitiError } from '../../../liti/src/errors'
import { withLitiContext } from './context'

export default defineEventHandler((event) => {
    const runtime = useLitiRuntime()
    return withLitiContext(event.context, () =>
        handleActionRequest(event.req, runtime.managementBase, (name, input) => {
            if (!runtime.executeAction) throw new LitiError('LITI_AI_UNAVAILABLE', 'Actions are unavailable.')
            return runtime.executeAction(event, name, input)
        }),
    )
})
