import type { AuthorizationContext, Model } from '../definition/model'
import { ModelError } from '../definition/errors'

export async function authorize(model: Model, context: Omit<AuthorizationContext, 'model'>) {
    context.signal?.throwIfAborted()
    if (
        !context.actor ||
        typeof context.actor.id !== 'string' ||
        !context.actor.id ||
        !(await model.authorize({ ...context, model: model.name }))
    )
        throw new ModelError('LITI_FORBIDDEN', 'This model operation is not authorized.')
    context.signal?.throwIfAborted()
}
