import type { Model, ModelCommit } from '../definition/model'

export async function notifyCommitted(
    model: Model,
    event: Omit<ModelCommit, 'model' | 'label'>,
    data?: Record<string, unknown>,
) {
    try {
        const label = model.title && data?.[model.title]
        await model.committed?.({ ...event, model: model.name, ...(typeof label === 'string' ? { label } : {}) })
        return []
    } catch {
        return [{ code: 'LITI_POST_COMMIT', message: 'The write committed; a model commit listener failed.' }]
    }
}
