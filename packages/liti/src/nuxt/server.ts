import { ModelError, describeModel, authorize, type Model, type Actor } from '@litijs/model'
import { createModelContent, type ContentBindingOptions } from '@litijs/model/content'
import { createModelRecords } from '@litijs/model/records'
import { recordSchema } from '@litijs/model/records/schema'
import type { PublicQuery } from './types'

export function createLitiRuntime(options: {
    models: readonly Model[]
    content: ContentBindingOptions['content']
    workspace: string
    database?: string
}) {
    const definitions = new Map(options.models.map((model) => [model.name, model]))
    if (definitions.size !== options.models.length) throw new ModelError('LITI_INVALID_MODEL', 'Duplicate model name.')
    const contentModels = options.models.filter((model) => model.storage === 'content')
    const recordModels = options.models.filter((model) => model.storage === 'records')
    const records = createModelRecords({
        models: recordModels,
        tables: recordSchema(recordModels),
        contentModels,
        database: options.database ?? 'default',
    })
    const content = createModelContent({
        content: options.content,
        workspace: options.workspace,
        models: contentModels,
        records,
    })
    const definition = (name: string) => {
        const model = definitions.get(name)
        if (!model) throw new ModelError('LITI_NOT_FOUND', 'Unknown model.')
        return model
    }
    const query = async (input: PublicQuery) => {
        const model = definition(input.model)
        if (input.mode === 'one') {
            if (input.path) {
                if (model.storage !== 'content')
                    throw new ModelError('LITI_INVALID_INPUT', 'Records have no publication routes.')
                const found = await content.resolveUrl(input.path)
                return found?.entry.model === model.name
                    ? await content.read(model.name, found.entry.id, input.locale ?? found.entry.locale, input)
                    : null
            }
            if (!input.id) throw new ModelError('LITI_INVALID_INPUT', 'A single query needs an ID or public path.')
            if (model.storage === 'content') return await content.read(model.name, input.id, input.locale, input)
            const record = await records.read(model.name, input.id)
            return record ? { ...record, model: model.name } : null
        }
        if (model.storage === 'content') return await content.query(model.name, input)
        const page = await records.query(model.name, input)
        return { ...page, items: page.items.map((record) => ({ ...record, model: model.name })) }
    }
    const descriptors = async (actor?: Actor) => {
        const visible = []
        for (const model of definitions.values()) {
            if (actor) {
                try {
                    await authorize(model, { actor, action: 'readDraft' })
                } catch (error) {
                    if (error instanceof ModelError && error.code === 'LITI_FORBIDDEN') continue
                    throw error
                }
            }
            visible.push(describeModel(model, actor ? 'management' : 'public'))
        }
        return visible
    }
    return {
        definitions,
        definition,
        content,
        nativeContent: options.content,
        records,
        query,
        descriptors,
        dispose: content.dispose,
    }
}
export type LitiRuntime = ReturnType<typeof createLitiRuntime>
