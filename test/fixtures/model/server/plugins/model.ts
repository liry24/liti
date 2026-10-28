import { models } from '../utils/models'
export default defineNitroPlugin((nitro) => {
    nitro.hooks.hook('close', models.dispose)
})
