import type { LitiConfig } from '../config'
import type { ActionDefinition, ActionResult, OperationContext } from '../plugins'
import { LitiError } from '../errors'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const issues = (values: readonly StandardSchemaV1.Issue[], prefix: string) =>
    values.map((issue) => ({
        path: [prefix, ...(issue.path ?? []).map((part) => String(typeof part === 'object' ? part.key : part))]
            .filter(Boolean)
            .join('.'),
        message: issue.message,
    }))

/** Both HTTP and trusted server calls share the same actor, schema and cancellation boundary. */
export async function executeAction<
    const Actions extends Record<string, ActionDefinition>,
    Name extends Extract<keyof Actions, string>,
>(
    config: Pick<LitiConfig, 'authorization'> & { actions: Actions },
    name: Name,
    input: StandardSchemaV1.InferInput<Actions[Name]['input']>,
    context: OperationContext,
): Promise<Awaited<ReturnType<Actions[Name]['execute']>>>
export async function executeAction(
    config: Pick<LitiConfig, 'authorization'> & { actions?: Record<string, ActionDefinition> },
    name: string,
    input: unknown,
    context: OperationContext,
): Promise<ActionResult> {
    const actor = context.actor
    if (!actor?.id) throw new LitiError('LITI_AUTH_REQUIRED', 'Authentication is required.')
    if (
        !actor.roles?.includes('admin') &&
        !actor.roles?.some((role) => {
            const allowed = config.authorization?.roles[role]?.actions
            return allowed?.includes(name) || allowed?.includes('*')
        })
    )
        throw new LitiError('LITI_FORBIDDEN', 'This role cannot execute that action.')
    const action = config.actions && Object.hasOwn(config.actions, name) ? config.actions[name] : undefined
    if (!action) throw new LitiError('LITI_ENTRY_NOT_FOUND', 'Action does not exist.')
    if (context.deadline !== undefined && !Number.isFinite(context.deadline))
        throw new LitiError('LITI_INVALID_INPUT', 'The operation deadline must be finite.')
    const signals = [
        context.signal,
        context.request?.signal,
        ...(context.deadline === undefined
            ? []
            : [AbortSignal.timeout(Math.min(2_147_483_647, Math.max(0, Math.ceil(context.deadline - Date.now()))))]),
    ].filter((signal): signal is AbortSignal => Boolean(signal))
    const signal = signals.length ? AbortSignal.any(signals) : undefined
    if (context.deadline !== undefined && context.deadline <= Date.now())
        throw new DOMException('The operation deadline has elapsed.', 'TimeoutError')
    signal?.throwIfAborted()
    let cloned: unknown
    try {
        cloned = structuredClone(input)
    } catch {
        throw new LitiError('LITI_INVALID_INPUT', 'Action input must be cloneable data.')
    }
    const validated = await action.input['~standard'].validate(cloned)
    if (validated.issues)
        throw new LitiError('LITI_INVALID_INPUT', 'Invalid action input.', issues(validated.issues, 'input'))
    signal?.throwIfAborted()
    let result: ActionResult
    try {
        result = await action.execute(validated.value, { ...context, ...(signal ? { signal } : {}) })
    } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof LitiError) throw error
        throw new LitiError('LITI_ACTION_FAILED', 'Action execution failed.')
    }
    signal?.throwIfAborted()
    if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'data'))
        throw new LitiError('LITI_ACTION_OUTPUT_INVALID', 'Action returned an invalid result.')
    const output = await action.output['~standard'].validate(result.data)
    signal?.throwIfAborted()
    if (output.issues)
        throw new LitiError('LITI_ACTION_OUTPUT_INVALID', 'Invalid action output.', issues(output.issues, 'output'))
    return { data: output.value, ...(result.metadata === undefined ? {} : { metadata: result.metadata }) }
}
