import type { LitiAuthorizeContext } from 'liti/nuxt'
import { createError, useServerHooks } from 'nuxt/server'

export default () => {
    useServerHooks().hook('liti:authorize', (context: LitiAuthorizeContext) => {
        if (context.event.req.headers.get('x-liti-test-deny')) {
            throw createError({ status: 403, statusText: 'Forbidden', message: 'PRIVATE_DENIAL_DETAIL' })
        }
        const role = context.event.req.headers.get('x-liti-test-role')
        if (context.actor && (role === 'admin' || role === 'editor')) context.actor.roles = [role]
    })
}
