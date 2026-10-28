import { defineContent } from 'vite-hub/content'
import { cms } from 'vite-hub/content/presets/cms'
import { contentCollection } from '@litijs/model/content'
import { notes } from './models/definitions'
export const content = defineContent({
    extends: cms,
    collections: { notes: contentCollection(notes) },
    authorize: () => false,
})
