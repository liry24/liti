# liti

Schema-driven content management. v0.1.0 is under development; use a commit-specific preview.

```sh
bun add https://pkg.pr.new/liry24/liti/liti@<commit>
```

```ts
// liti.config.ts
import { defineLitiConfig, text, markdown } from 'liti'

export default defineLitiConfig({
    models: {
        posts: {
            fields: {
                title: text({ required: true }),
                content: markdown(),
            },
        },
    },
})
```

```sh
liti --help
liti --version
```
