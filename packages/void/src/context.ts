import { withRuntimeEnv } from 'void/_env'

/** Request and task bindings use Void's async scope rather than mutable global state. */
export const withVoidContext = <Value>(context: object | undefined, run: () => Value): Value => {
    const source = context as { cloudflare?: { env?: unknown }; env?: unknown } | undefined
    return withRuntimeEnv(source?.cloudflare?.env ?? source?.env, run)
}
