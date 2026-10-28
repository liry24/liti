import { defineContent } from 'vite-hub/content'
import { cms } from 'vite-hub/content/presets/cms'
import { contentCollection } from '@litijs/model/content'
import { posts, works, cards } from './models/definitions'

export const content = defineContent({
    extends: cms,
    collections: { posts: contentCollection(posts), works: contentCollection(works), cards: contentCollection(cards) },
    authorize: ({ user, action }) =>
        typeof user?.email === 'string' &&
        (user.email.startsWith('editor-') || (action === 'read' && user.email.startsWith('reader-'))),
})
