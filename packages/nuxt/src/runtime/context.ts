import { AsyncLocalStorage } from 'node:async_hooks'
import type { RuntimeAdapter } from '../../../liti/src/plugins'

const contexts = new AsyncLocalStorage<object | undefined>()
export const currentLitiContext = () => contexts.getStore()
let adapter: RuntimeAdapter | undefined
export const configureLitiContext = (runtime: RuntimeAdapter | undefined) => {
    adapter = runtime
}

/** Framework request scope stays in the bridge; the selected runtime owns its binding scope. */
export const withLitiContext = <Value>(context: object | undefined, run: () => Value): Value | Promise<Value> =>
    contexts.run(context, () =>
        adapter?.run ? adapter.run({ ...(context ? { platformContext: context } : {}) }, run) : run(),
    )
