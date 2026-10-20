import { defineTask } from 'nitropack/runtime'
import { useLitiRuntime } from '../../nuxt/server'
import { runLitiTask } from '../tasks'

export default defineTask({
    meta: { name: 'liti:sync-assets', description: 'Retry liti draft/public asset synchronization.' },
    run: async ({ context }) => ({ result: await runLitiTask('syncAssets', useLitiRuntime(), context) }),
})
