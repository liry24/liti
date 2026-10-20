import type { AdapterContext } from 'liti/adapter'
import { LitiError } from 'liti/adapter'
import { useVoidDatabase } from './session'
import { withVoidContext } from './context'

export const connectDatabase = async (context: AdapterContext, entry: string) => {
    const schema = await context.loadModule?.(entry)
    if (!schema)
        throw new LitiError('LITI_SCHEMA_INCOMPATIBLE', 'The Void host must supply the generated project schema.')
    return withVoidContext(context.platformContext, () => useVoidDatabase(schema))
}
