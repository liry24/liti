import type { FilesEnvironmentConfig } from 'nuxt-files-sdk/config'
import type { LitiConfig } from 'liti/adapter'

/** liti selects storage; Files SDK alone resolves physical providers and credentials. */
export const resolveLitiAssets = (
    assets: LitiConfig['assets'],
    files: FilesEnvironmentConfig,
): LitiConfig['assets'] => {
    if (!assets) return undefined
    const storage = files.storage
    const names = storage ? ('adapter' in storage ? ['default'] : Object.keys(storage)) : []
    if (assets.storage) {
        if (names.length && !names.includes(assets.storage))
            throw new Error(`[liti] assets.storage references an unknown Files storage: ${assets.storage}.`)
        return { ...assets }
    }
    if (names.length !== 1)
        throw new Error('[liti] assets.storage is required unless exactly one Files storage is configured.')
    return { ...assets, storage: names[0]! }
}
