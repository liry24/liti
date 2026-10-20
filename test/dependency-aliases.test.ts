import { expect, it } from 'vitest'
import manifest from '../packages/liti/package.json'

it('keeps framework instances as peers and moves platform dependencies to the selected adapter', () => {
    expect(manifest.exports).not.toHaveProperty('./dependency-aliases')
    for (const name of ['nuxt', 'vue']) {
        expect(manifest.peerDependencies).toHaveProperty(name)
        expect(manifest.dependencies).not.toHaveProperty(name)
    }
    expect(manifest.dependencies).toHaveProperty('comark-content')
    expect(manifest.dependencies).toHaveProperty('comark')
    for (const name of [
        'ai',
        'better-auth',
        '@nuxtjs/better-auth',
        'files-sdk',
        'nuxt-files-sdk',
        'void',
        'drizzle-orm',
    ]) {
        expect(manifest.peerDependencies).not.toHaveProperty(name)
        expect(manifest.dependencies).not.toHaveProperty(name)
    }
})
