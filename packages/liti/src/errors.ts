export interface LitiIssue {
    message: string
    path: string
}

export type LitiErrorCode =
    | 'LITI_ACTION_FAILED'
    | 'LITI_ACTION_OUTPUT_INVALID'
    | 'LITI_AI_FAILED'
    | 'LITI_AI_OUTPUT_INVALID'
    | 'LITI_AI_UNAVAILABLE'
    | 'LITI_ASSET_IN_USE'
    | 'LITI_ASSET_NOT_READY'
    | 'LITI_AUTH_REQUIRED'
    | 'LITI_FORBIDDEN'
    | 'LITI_CONFLICT'
    | 'LITI_DATABASE_UNSUPPORTED'
    | 'LITI_ENTRY_NOT_FOUND'
    | 'LITI_INVALID_INPUT'
    | 'LITI_MIGRATION_REQUIRED'
    | 'LITI_MODEL_NOT_FOUND'
    | 'LITI_NOT_PUBLIC'
    | 'LITI_RELATION_BLOCKED'
    | 'LITI_RELATION_LIMIT'
    | 'LITI_ROUTE_CONFLICT'
    | 'LITI_SCHEMA_INCOMPATIBLE'
    | 'LITI_SCHEMA_MIGRATION_REQUIRED'
    | 'LITI_STORAGE_UNAVAILABLE'

const statuses: Record<LitiErrorCode, number> = {
    LITI_ACTION_FAILED: 502,
    LITI_ACTION_OUTPUT_INVALID: 502,
    LITI_AI_FAILED: 502,
    LITI_AI_OUTPUT_INVALID: 502,
    LITI_AI_UNAVAILABLE: 503,
    LITI_ASSET_IN_USE: 409,
    LITI_ASSET_NOT_READY: 409,
    LITI_AUTH_REQUIRED: 401,
    LITI_FORBIDDEN: 403,
    LITI_CONFLICT: 409,
    LITI_DATABASE_UNSUPPORTED: 500,
    LITI_ENTRY_NOT_FOUND: 404,
    LITI_INVALID_INPUT: 400,
    LITI_MIGRATION_REQUIRED: 503,
    LITI_MODEL_NOT_FOUND: 404,
    LITI_NOT_PUBLIC: 404,
    LITI_RELATION_BLOCKED: 409,
    LITI_RELATION_LIMIT: 422,
    LITI_ROUTE_CONFLICT: 409,
    LITI_SCHEMA_INCOMPATIBLE: 503,
    LITI_SCHEMA_MIGRATION_REQUIRED: 409,
    LITI_STORAGE_UNAVAILABLE: 503,
}

export class LitiError extends Error {
    committed?: boolean
    receipt?: { id: string; model: string; version: number; deleted?: boolean }
    effects?: { assets: 'pending' }
    readonly code: LitiErrorCode
    readonly issues?: LitiIssue[]
    readonly status: number

    constructor(code: LitiErrorCode, message: string, issues?: LitiIssue[]) {
        super(message)
        this.name = 'LitiError'
        this.code = code
        this.status = statuses[code]
        if (issues) this.issues = issues
    }
}
