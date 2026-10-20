import { LitiError } from '../../../liti/src/errors'
import type { Liti } from '../../../liti/src/server/liti'
import { withLitiContext } from './context'
import type { LitiTaskOptions, LitiTaskName } from '../../../liti/src/tasks'
export type { LitiTaskOptions, LitiTaskName } from '../../../liti/src/tasks'

type TaskLiti = Pick<Liti, 'publishDue' | 'runAssetGC' | 'syncAssetCopies' | 'rebuildSearch'>

export interface LitiTaskRuntime {
    tasks?: LitiTaskOptions
    getLiti(event?: undefined, platformContext?: object): TaskLiti | Promise<TaskLiti>
}

/** Run existing use cases without changing their revision, ownership, lease, or conflict handling. */
export const runLitiTask = async (name: LitiTaskName, runtime: LitiTaskRuntime, platformContext?: object) =>
    withLitiContext(platformContext, async () => {
        const enabled = runtime.tasks?.[name]
        if (enabled !== true && !(typeof enabled === 'string' && enabled.trim()))
            throw new LitiError('LITI_FORBIDDEN', `liti task "${name}" is disabled.`)
        const admin = await runtime.getLiti(undefined, platformContext)
        switch (name) {
            case 'publishDue':
                return admin.publishDue()
            case 'assetGC':
                return admin.runAssetGC()
            case 'rebuildSearch':
                return admin.rebuildSearch()
            case 'syncAssets':
                return admin.syncAssetCopies()
        }
    })
