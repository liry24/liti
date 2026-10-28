import { documents, optional } from '@vite-hub/content/collections'
import type { ContentFields } from '@vite-hub/content'
import type { FieldSchema, ContentModel } from '../definition/model'

const scalar = (kind: 'number' | 'boolean'): FieldSchema => ({
    '~standard': {
        version: 1,
        vendor: 'liti-model',
        validate: (value) =>
            typeof value === kind && (kind !== 'number' || Number.isFinite(value))
                ? { value }
                : { issues: [{ message: `Expected ${kind}.` }] },
        jsonSchema: { input: () => ({ type: kind }), output: () => ({ type: kind }) },
    },
})

/** Keep defineContent({ extends: cms, collections: { posts: contentCollection(posts) } }) explicit. */
export function contentCollection(model: ContentModel) {
    const fields: ContentFields = {
        ...Object.fromEntries(
            Object.entries(model.fields).map(([key, definition]) => [key, optional(definition.schema)]),
        ),
        _litiOrder: scalar('number'),
        _litiBody: scalar('boolean'),
    }
    return documents({
        path: `${model.name}/**/*.${model.format === 'json' ? 'json' : 'md'}`,
        label: model.label ?? model.name,
        ...(model.title ? { titleField: model.title } : {}),
        editing: { lease: false },
        fields,
    })
}
