import { parse } from '@vue/compiler-sfc'

export default {
    $schema: 'https://unpkg.com/knip@6/schema.json',
    ignoreExportsUsedInFile: true,
    ignore: ['test/fixtures/model/**', 'test/fixtures/integration/**', 'test/fixtures/model-vite/**'],
    workspaces: {
        '.': {
            entry: ['taze.config.ts', 'scripts/*.mjs', 'test/**/*.test.ts', 'test/*.mjs'],
            project: ['*.ts', 'scripts/*.{ts,mjs}', 'test/**/*.{ts,mjs}'],
            ignoreDependencies: ['@arethetypeswrong/cli', '@litijs/blog', 'publint', 'vite'],
        },
        'packages/model': {
            entry: [
                'src/index.ts!',
                'src/content/index.ts!',
                'src/records/index.ts!',
                'src/records/schema.ts!',
                'src/vite/index.ts!',
            ],
            project: ['src/**/*.ts!'],
        },
        'packages/liti': {
            entry: ['src/public.ts!', 'src/nuxt/*.ts!', 'src/cli/index.ts!', 'src/runtime/**/*.{ts,vue}!'],
            project: ['src/**/*.{ts,vue}!'],
            ignoreIssues: {
                'package.json': ['optionalPeerDependencies'],
            },
        },
        'packages/blog': {
            entry: ['src/index.ts!', 'src/agents/index.ts!', 'src/vue/index.ts!', 'src/nuxt/index.ts!'],
            project: ['src/**/*.ts!'],
            ignoreIssues: {
                'package.json': ['optionalPeerDependencies'],
            },
            ignoreDependencies: ['@types/markdown-it'],
        },
        'test/fixtures/vitehub': {
            entry: [
                'auth-schema.config.ts!',
                'probe-database.ts!',
                'server/auth.ts!',
                'server/console-authorize.ts!',
                'server/databases/config.ts!',
                'server/schedules/*.ts!',
                'workarounds/*.ts!',
                'verify-*.mjs!',
            ],
            ignoreDependencies: ['@iconify-json/lucide', '@iconify-json/ph', 'wrangler', 'vue-tsc'],
        },
    },
    compilers: {
        vue(source: string) {
            const { descriptor } = parse(source)
            return [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n')
        },
    },
}
