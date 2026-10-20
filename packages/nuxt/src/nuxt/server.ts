import { isNuxtError, type RequestEvent } from 'nuxt/server'
import { LitiError } from '../../../liti/src/errors'
import type { Liti } from '../../../liti/src/server/liti'
import type { LitiTaskOptions } from '../runtime/tasks'

export interface LitiRuntime {
    development?: {
        connector: string
        devDatabase: boolean
        locales?: { defaultLocale?: string; strategy: string; supported: string[] }
    }
    managementBase: string
    publicBase: string
    tasks?: LitiTaskOptions
    getLiti: (event?: RequestEvent, platformContext?: object) => Liti<RequestEvent> | Promise<Liti<RequestEvent>>
    initializeRequest?: (event: RequestEvent) => void | Promise<void>
    runAiAction?: (event: RequestEvent, name: string, input: unknown) => Promise<unknown>
    presentation?: (
        event: RequestEvent,
        path: string,
    ) => Promise<ReturnType<typeof import('../runtime/presentation').resolvePublicPresentation>>
}

let runtime: LitiRuntime | undefined

export const configureLitiRuntime = (value: LitiRuntime): LitiRuntime => {
    runtime = value
    return value
}

export const useLitiRuntime = (): LitiRuntime => {
    if (!runtime) {
        throw new LitiError('LITI_MIGRATION_REQUIRED', 'liti runtime has not been initialized.')
    }
    return runtime
}

/** Normalize intentional authorization refusals before the framework-neutral HTTP error boundary. */
export const normalizeLitiAuthorizationError = (error: unknown): unknown => {
    if (isNuxtError(error)) {
        if (error.status === 401) return new LitiError('LITI_AUTH_REQUIRED', 'Authentication is required.')
        if (error.status === 403) return new LitiError('LITI_FORBIDDEN', 'Authorization denied.')
    }
    return error
}
