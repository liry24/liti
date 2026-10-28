import { defineConfig } from 'taze'

export default defineConfig({
    force: true,
    write: true,
    install: false,
    interactive: true,
    recursive: true,
    includeLocked: true,
    ignorePaths: ['**/node_modules/**', '**/.tmp/**', '**/.data/**'],
    ignoreOtherWorkspaces: true,
    // Update the verified native host/alpha cohort separately from feature work.
    exclude: ['h3@>=2', 'vite', 'vite-plus', 'nuxt', 'nitropack', 'vite-hub', '@vite-hub/*'],
    depFields: {
        overrides: false,
        'bun-workspace': true,
    },
})
