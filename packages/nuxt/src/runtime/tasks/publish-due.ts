import { defineTask } from 'nitropack/runtime'
import { useLitiRuntime } from '../../nuxt/server'
import { runLitiTask } from '../tasks'

export default defineTask({
    meta: { name: 'liti:publish-due', description: 'Publish due liti revisions.' },
    run: async ({ context }) => ({ result: await runLitiTask('publishDue', useLitiRuntime(), context) }),
})
