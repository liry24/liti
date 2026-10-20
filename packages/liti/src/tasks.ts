/** `true` enables manual runs; a cron string also permits the host to schedule them. */
export interface LitiTaskOptions {
    publishDue?: boolean | string
    assetGC?: boolean | string
    syncAssets?: boolean | string
    rebuildSearch?: boolean
}

export type LitiTaskName = keyof LitiTaskOptions
