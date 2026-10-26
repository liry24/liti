import type { LitiConfigInput } from 'liti'
// oxlint-disable-next-line vite-plus/prefer-vite-plus-imports -- The public fixture supports Vitest without Vite+.
import type { TestContext } from 'vitest'
import { createTestLiti, type TestLitiOptions } from './index'

/** Pass to test.extend({ liti: litiFixture(config) }); each test owns its instance. */
export function litiFixture<const Config extends LitiConfigInput>(config: Config, options: TestLitiOptions = {}) {
    const fixture = async (
        // oxlint-disable-next-line no-empty-pattern -- Vitest discovers fixture dependencies from destructuring.
        {}: TestContext,
        use: (liti: Awaited<ReturnType<typeof createTestLiti<Config>>>) => Promise<void>,
    ) => {
        const liti = await createTestLiti(config, options)
        try {
            await use(liti)
        } finally {
            await liti.close()
        }
    }
    return fixture
}
