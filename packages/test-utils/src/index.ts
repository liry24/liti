import type { InferLitiSchema, LitiConfigInput, ResolvedLitiConfig } from 'liti'
import { createLitiClient } from 'liti/client'
import { createLiti, type LitiBootstrap } from 'liti/server'
import { createMemoryDatabase } from './memory'

export { createMemoryDatabase } from './memory'
export type TestLitiOptions = Pick<LitiBootstrap, 'authenticate' | 'now' | 'locales'>

/** Test instances replace host adapters, but retain the real model, action and authorization contracts. */
export async function createTestLiti<const Config extends LitiConfigInput>(
    config: Config,
    options: TestLitiOptions = {},
): Promise<
    Awaited<ReturnType<typeof createLiti<Config>>> & {
        client: ReturnType<typeof createLitiClient<InferLitiSchema<ResolvedLitiConfig<Config, readonly []>>>>
    }
> {
    const database = createMemoryDatabase()
    const runtime = await createLiti(
        { ...config, adapter: { database: { id: 'test-memory', role: 'database', connect: () => database } } },
        { ...options, projectRoot: '.', environment: [] },
    )
    let closed = false
    const assertOpen = () => {
        if (closed) throw new Error('This liti test instance is closed.')
    }
    const fetch: typeof runtime.fetch = (request, platformContext) => {
        assertOpen()
        return runtime.fetch(request, platformContext)
    }
    const client = createLitiClient<InferLitiSchema<ResolvedLitiConfig<Config, readonly []>>>({
        origin: 'http://liti.test',
        fetch: (input, init) => fetch(new Request(input, init)),
    })
    return {
        async service(context: Parameters<typeof runtime.service>[0]) {
            assertOpen()
            return runtime.service(context)
        },
        fetch,
        client,
        tasks: runtime.tasks,
        async close() {
            if (closed) return
            closed = true
            await runtime.close()
        },
    }
}
