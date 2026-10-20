import { spawnSync } from 'node:child_process'
import { publicPackages } from '../test/consumer-packages.mjs'

for (const name of publicPackages) {
    for (const args of [
        ['publint', `packages/${name}`],
        [
            'attw',
            '--pack',
            `packages/${name}`,
            '--profile',
            'esm-only',
            ...(name === 'liti'
                ? ['--exclude-entrypoints', './internal/runtime/composables', './internal/runtime/seo']
                : []),
        ],
    ]) {
        const result = spawnSync('bun', ['x', '--no-install', ...args], {
            stdio: 'inherit',
        })
        if (result.status !== 0) process.exit(result.status ?? 1)
    }
}
