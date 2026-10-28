# liti

Native ViteHub models in Nuxt. Use a commit-specific preview while v0.1.0 is in development.

```sh
bun add https://pkg.pr.new/liry24/liti/liti@<full-commit>
liti init --dry-run
liti init
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ['vite-hub/nuxt', 'liti/nuxt'],
})
```

```vue
<script setup lang="ts">
const { data: posts, total } = await useLitiQuery('posts')
const route = useRoute()
const { data: post } = await useLitiQuery('posts', {
    mode: 'one',
    id: () => String(route.params.id),
})
</script>
```

```vue
<script setup lang="ts">
const { form, values, save, receipt, hasUnsavedChanges } = await useLitiForm('posts', {
    defaultValues: { title: '', slug: '' },
    onSuccess(_receipt, { hasUnsavedChanges }) {
        if (!hasUnsavedChanges) navigateTo('/_liti')
    },
})
</script>
<template>
    <form @submit.prevent="save()">
        <form.Field name="data.title" v-slot="{ field }">
            <input :value="field.value" @input="field.handleChange(($event.target as HTMLInputElement).value)" />
        </form.Field>
        <button type="submit">Save</button>
    </form>
</template>
```

```sh
liti generate            # Nuxt types + native schema generation; no migrations
liti add blog --dry-run
liti remove blog --dry-run
liti upgrade --to <full-commit> --dry-run
```

Configure durable native Auth and explicit model policies before enabling management. The pinned alpha requires the identical root Bun patches printed by `liti init`; dependency postinstall never changes consumer settings. npm/pnpm without equivalent patches do not support Content writes.
