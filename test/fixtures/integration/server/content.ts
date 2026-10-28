import { defineContent } from 'vite-hub/content'
import { cms } from 'vite-hub/content/presets/cms'
import { contentCollection } from '@litijs/model/content'
import { posts, works, cards } from './models/definitions'
import { articles } from './models/articles'
import { memos } from './models/memos'
import { bench } from './models/bench'
export const content = defineContent({
    extends: cms,
    collections: {
        posts: contentCollection(posts),
        works: contentCollection(works),
        cards: contentCollection(cards),
        articles: contentCollection(articles),
        memos: contentCollection(memos),
        bench: contentCollection(bench),
    },
    authorize: ({ user, action }) =>
        typeof user?.email === 'string' &&
        (user.email.startsWith('editor-') || (action === 'read' && user.email.startsWith('reader-'))),
})
