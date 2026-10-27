import { defineContent, documents } from 'vite-hub/content'
import { cms } from 'vite-hub/content/presets/cms'
import { z } from 'zod'

export const content = defineContent({
    extends: cms,
    collections: {
        posts: documents({ path: 'posts/**/*.md', fields: { title: z.string().min(1) } }),
        records: documents({ path: 'records/**/*.json', fields: { name: z.string().min(1) } }),
    },
    authorize: ({ user, action }) => {
        const email = user?.email
        return (
            typeof email === 'string' &&
            (email.startsWith('editor-') || (action === 'read' && email.startsWith('reader-')))
        )
    },
})
