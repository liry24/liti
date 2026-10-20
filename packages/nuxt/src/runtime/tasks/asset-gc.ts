import { defineTask } from 'nitropack/runtime'
import { useLitiRuntime } from '../../nuxt/server'
import { runLitiTask } from '../tasks'

export default defineTask({
    meta: { name: 'liti:asset-gc', description: 'Collect unreferenced liti assets.' },
    run: async ({ context }) => ({ result: await runLitiTask('assetGC', useLitiRuntime(), context) }),
})
