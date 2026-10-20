import type { LitiDatabase } from '../adapter'
import type { LitiConfig } from '../config'

export const assertLitiSchema = (database: LitiDatabase, config: LitiConfig): Promise<void> =>
    database.bind(config).assertSchema()
