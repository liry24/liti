import { ModelError } from '../definition/errors'

export async function sqlCommit<T>(task: () => Promise<T>): Promise<T> {
    try {
        return await task()
    } catch (error) {
        const messages: string[] = []
        let cause: unknown = error
        for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
            messages.push(cause.message)
            cause = cause.cause
        }
        const message = messages.join('\n')
        if (/FOREIGN KEY constraint failed/iu.test(message))
            throw new ModelError('LITI_REFERENCE', 'A record reference prevents this operation.', [], { cause: error })
        if (/(?:UNIQUE|PRIMARY KEY) constraint failed/iu.test(message))
            throw new ModelError('LITI_CONFLICT', 'A native unique constraint prevents this operation.', [], {
                cause: error,
            })
        if (/(?:NOT NULL|CHECK) constraint failed/iu.test(message))
            throw new ModelError('LITI_INVALID_INPUT', 'A native SQL constraint rejected the record.', [], {
                cause: error,
            })
        throw error
    }
}
