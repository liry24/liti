import { AsyncLocalStorage } from 'node:async_hooks'
import { content } from '../content'

// Fixture-only demonstration: callers cannot grant themselves permission through document metadata.
export const managedWriteScope = new AsyncLocalStorage<true>()
export async function withManagedWrite<T>(
    user: { id: string; email: string } | null,
    action: 'write' | 'publish',
    task: () => Promise<T>,
) {
    if (!(await content.can({ collection: 'managed', action, user }))) throw new Error('PROBE_ACCESS_DENIED')
    return await managedWriteScope.run(true, task)
}
