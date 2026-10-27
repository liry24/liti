import { defineConfig } from 'vite-plus'
import { fileURLToPath } from 'node:url'

export default defineConfig({
    resolve: {
        alias: Object.fromEntries(
            Object.entries({
                '@litijs/model/records/schema': './packages/model/src/records/schema.ts',
                '@litijs/model/content': './packages/model/src/content/index.ts',
                '@litijs/model/records': './packages/model/src/records/index.ts',
                '@litijs/model/vite': './packages/model/src/vite/index.ts',
                '@litijs/model': './packages/model/src/index.ts',
                '@litijs/blog/agents': './packages/blog/src/agents/index.ts',
                '@litijs/blog/vue': './packages/blog/src/vue/index.ts',
                '@litijs/blog': './packages/blog/src/index.ts',
                'liti/server': './packages/liti/src/nuxt/server.ts',
                'liti/nuxt': './packages/liti/src/nuxt/index.ts',
                'liti/types': './packages/liti/src/nuxt/types.ts',
                liti: './packages/liti/src/public.ts',
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
        // The Model overlay is typechecked after packing into its generated native Nuxt consumer.
        ignorePatterns: [
            '**/dist/**',
            '**/.nuxt/**',
            '**/.output/**',
            '**/.data/**',
            '**/.wrangler/**',
            '**/.tmp/**',
            'test/fixtures/model/**',
            'test/fixtures/model-vite/**',
            'test/fixtures/integration/**',
        ],
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
                files: ['test/**/*.{ts,mjs}'],
                rules: {
                    'typescript/no-implied-eval': 'off',
                    'import/no-empty-named-blocks': 'off',
                    'no-underscore-dangle': 'off',
                },
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
