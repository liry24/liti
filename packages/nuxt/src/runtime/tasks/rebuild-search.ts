import { defineTask } from 'nitropack/runtime'
import { useLitiRuntime } from '../../nuxt/server'
import { runLitiTask } from '../tasks'
export default defineTask({
    meta: {
        name: 'liti:rebuild-search',
        description: 'Rebuild the content search index after an explicit migration.',
    },
    run: async ({ context }) => ({ result: await runLitiTask('rebuildSearch', useLitiRuntime(), context) }),
})
