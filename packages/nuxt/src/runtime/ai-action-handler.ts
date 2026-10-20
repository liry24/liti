import { defineEventHandler } from 'nuxt/server'
import { handleAiActionRequest } from '../../../liti/src/server/ai-actions-http'
import { useLitiRuntime } from '../nuxt/server'
import { LitiError } from '../../../liti/src/errors'
import { withLitiContext } from './context'

export default defineEventHandler((event) => {
    const runtime = useLitiRuntime()
    return withLitiContext(event.context, () =>
        handleAiActionRequest(event.req, runtime.managementBase, (name, input) => {
            if (!runtime.runAiAction) throw new LitiError('LITI_AI_UNAVAILABLE', 'AI actions are unavailable.')
            return runtime.runAiAction(event, name, input)
        }),
    )
})
