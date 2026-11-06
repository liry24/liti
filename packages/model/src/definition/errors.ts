export type ModelErrorCode =
    | 'LITI_INVALID_MODEL'
    | 'LITI_INVALID_INPUT'
    | 'LITI_FORBIDDEN'
    | 'LITI_NOT_FOUND'
    | 'LITI_CONFLICT'
    | 'LITI_REFERENCE'
    | 'LITI_ROUTE_CONFLICT'
    | 'LITI_CROSS_STORE_ATOMICITY'
export interface ModelIssue {
    path: readonly (string | number)[]
    message: string
}

export class ModelError extends Error {
    constructor(
        readonly code: ModelErrorCode,
        message: string,
        readonly issues: readonly ModelIssue[] = [],
        options?: ErrorOptions,
    ) {
        super(message, options)
        this.name = 'ModelError'
    }
    get statusCode() {
        if (this.code === 'LITI_FORBIDDEN') return 403
        if (this.code === 'LITI_NOT_FOUND') return 404
        if (this.code === 'LITI_CONFLICT' || this.code === 'LITI_REFERENCE' || this.code === 'LITI_ROUTE_CONFLICT')
            return 409
        return 400
    }
}

export function assertIdentity(id: string) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id))
        throw new ModelError('LITI_INVALID_INPUT', 'Invalid stable entry ID.')
    return id
}
