import type { StandardSchemaV1, StandardJSONSchemaV1 } from '@standard-schema/spec'

export const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
export const probability = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1

export const schema = <Value>(
    json: Record<string, unknown>,
    validate: (value: unknown) => StandardSchemaV1.Result<Value> | Promise<StandardSchemaV1.Result<Value>>,
): StandardSchemaV1<Value, Value> & StandardJSONSchemaV1<Value, Value> => ({
    '~standard': { version: 1, vendor: 'liti', validate, jsonSchema: { input: () => json, output: () => json } },
})
export const stringSchema = schema<string>({ type: 'string' }, (value) =>
    typeof value === 'string' ? { value } : { issues: [{ message: 'Expected text.' }] },
)
