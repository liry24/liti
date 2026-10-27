import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize(({ user }) => {
    const email = user?.email
    if (typeof email === 'string' && (email.startsWith('editor-') || email.startsWith('reader-')))
        return { sections: ['content'] }
    return false
})
