import { definePlugin } from 'nitro'
import { models } from '../utils/models'
export default definePlugin((nitro) => {
    nitro.hooks.hook('close', models.dispose)
})
