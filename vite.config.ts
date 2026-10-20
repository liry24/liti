import { defineConfig } from 'vite-plus'
import { fileURLToPath } from 'node:url'

export default defineConfig({
    resolve: {
        alias: Object.fromEntries(
            Object.entries({
                'liti/adapter': './packages/liti/src/adapter.ts',
                '@litijs/sqlite/storage': './packages/sqlite/src/connection.ts',
                '@litijs/sqlite/schema': './packages/sqlite/src/schema.ts',
                '@litijs/sqlite/tooling': './packages/sqlite/src/schema-source.ts',
                '@litijs/sqlite/native': './packages/sqlite/src/native.ts',
                '@litijs/void/database': './packages/void/src/database.ts',
            }).map(([name, path]) => [name, fileURLToPath(new URL(path, import.meta.url))]),
        ),
    },
    fmt: {
        ignorePatterns: ['bun.lock', 'packages/liti/dist/**'],
        printWidth: 120,
        semi: false,
        singleQuote: true,
        tabWidth: 4,
        trailingComma: 'all',
    },
    lint: {
        ignorePatterns: ['**/dist/**', '**/.nuxt/**', '**/.output/**', '**/.data/**', '**/.wrangler/**', '**/.tmp/**'],
        options: { typeAware: true, typeCheck: true },
        jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
        plugins: ['import', 'typescript'],
        categories: { correctness: 'error', suspicious: 'error' },
        rules: {
            'vite-plus/prefer-vite-plus-imports': 'error',
            // Keep typed lint focused on promise handling; generic API/style changes are separate work.
            'typescript/no-unsafe-type-assertion': 'off',
            'typescript/no-unnecessary-type-assertion': 'off',
            'typescript/no-unnecessary-type-parameters': 'off',
            'typescript/no-unnecessary-type-arguments': 'off',
            'typescript/no-unnecessary-type-conversion': 'off',
            'typescript/no-unnecessary-boolean-literal-compare': 'off',
            'typescript/no-redundant-type-constituents': 'off',
            'typescript/no-base-to-string': 'off',
            'typescript/consistent-return': 'off',
            'no-console': 'off',
            'typescript/no-explicit-any': 'error',
            'typescript/no-floating-promises': 'error',
            'import/no-cycle': 'error',
        },
        overrides: [
            {
                files: ['test/**/*.ts'],
                rules: { 'typescript/no-implied-eval': 'off', 'import/no-empty-named-blocks': 'off' },
            },
        ],
    },
    test: {
        coverage: { enabled: false },
        ...(process.platform === 'win32' ? { maxWorkers: '50%' } : {}),
        include: ['test/**/*.test.ts'],
        exclude: ['test/nuxt/**', 'test/fixtures/**'],
        testTimeout: 20_000,
    },
})
