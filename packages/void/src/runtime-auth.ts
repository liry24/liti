import type { OperationContext, LitiActor } from 'liti/adapter'
import { withVoidContext } from './context'

export interface VoidHostContext {
    authenticate?: (context: OperationContext) => LitiActor | null | Promise<LitiActor | null>
}

export const authenticate = async (context: OperationContext): Promise<LitiActor | null> => {
    const host = context.platformContext as VoidHostContext | undefined
    if (host?.authenticate) return host.authenticate(context)
    if (!context.request) return null
    return withVoidContext(context.platformContext, async () => {
        const { getSession } = await import('void/auth')
        const session = getSession()
        if (!session?.user) return null
        const user = session.user as typeof session.user & { role?: string }
        return {
            id: user.id,
            roles:
                user.role
                    ?.split(',')
                    .map((role) => role.trim())
                    .filter(Boolean) ?? [],
        }
    })
}
