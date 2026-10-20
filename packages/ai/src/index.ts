import { LitiError, type ActionDefinition, type ActionResult } from 'liti'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { TextAction, DecisionAction, ExtractionAction } from './actions'
import type { AiMetadata, AiProvider, ExtractionMetadata, OutputSchema } from './types'
import { schema } from './schema'
import { decisionSchema, validateQuestions } from './decision'
import { extractionSchema, validateFields, validateExtractionInput } from './extraction'

export { createTextAction, createDecisionAction, createExtractionAction } from './actions'
export { createSlugGenerator } from './slug'
export type { TextAction, DecisionAction, ExtractionAction } from './actions'
export type * from './types'

type AiAction =
    | TextAction
    | (DecisionAction & { output: StandardSchemaV1 })
    | (ExtractionAction & { output: StandardSchemaV1 })
type OutputOf<Schema> = Schema extends (...args: never[]) => infer Resolved
    ? OutputOf<Awaited<Resolved>>
    : Schema extends StandardSchemaV1<unknown, infer Value>
      ? Value
      : never
type Output<Action extends AiAction> = OutputOf<Action['output']>
type Bound<Action extends AiAction> = ActionDefinition<
    StandardSchemaV1.InferOutput<Action['input']>,
    Output<Action>,
    Action extends { capability: 'extraction' } ? ExtractionMetadata : AiMetadata,
    StandardSchemaV1.InferInput<Action['input']>
>

export function ai<const Actions extends Record<string, AiAction> = {}>(
    options: {
        provider?: AiProvider
        actions?: Actions
        limits?: { concurrency?: number; timeoutMs?: number }
    } = {},
) {
    const concurrency = options.limits?.concurrency ?? 4
    const timeoutMs = options.limits?.timeoutMs ?? 60_000
    if (
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 2_147_483_647
    )
        throw new LitiError('LITI_INVALID_INPUT', 'AI concurrency and timeout must be positive bounded integers.')
    let active = 0
    const actions: Record<string, ActionDefinition> = {}
    const validate = () => {
        for (const [name, definition] of Object.entries(options.actions ?? {})) {
            const provider = definition.provider ?? options.provider
            if (!provider?.[definition.capability])
                throw new LitiError(
                    'LITI_AI_UNAVAILABLE',
                    `Action "${name}" requires a provider with ${definition.capability} capability.`,
                )
            if (definition.capability === 'decision') validateQuestions(definition.questions)
            if (definition.capability === 'extraction') validateFields(definition.fields)
        }
    }
    for (const [name, definition] of Object.entries(options.actions ?? {})) {
        const declaredOutput =
            typeof definition.output === 'function' ? schema({}, (value) => ({ value })) : definition.output
        actions[name] = {
            ...(definition.contract ? { contract: definition.contract } : {}),
            input: definition.input,
            output: declaredOutput,
            async execute(input, context) {
                const provider = definition.provider ?? options.provider
                if (!provider?.[definition.capability])
                    throw new LitiError('LITI_AI_UNAVAILABLE', `Action "${name}" requires ${definition.capability}.`)
                if (active >= concurrency) throw new LitiError('LITI_AI_UNAVAILABLE', 'AI concurrency limit reached.')
                const signal = AbortSignal.any([
                    AbortSignal.timeout(timeoutMs),
                    ...[context.signal, context.request?.signal].filter((s): s is AbortSignal => !!s),
                ])
                const operation = { ...context, signal }
                signal.throwIfAborted()
                active++
                try {
                    let result: ActionResult<unknown, AiMetadata>
                    if (definition.capability === 'text') {
                        const output =
                            typeof definition.output === 'function'
                                ? await definition.output(input, operation)
                                : definition.output
                        const prompt = await definition.prompt(input, operation)
                        signal.throwIfAborted()
                        result = await provider.text!.generate(
                            {
                                prompt,
                                ...(definition.structured === false ? {} : { output: output as OutputSchema }),
                                ...(definition.options ? { options: definition.options } : {}),
                            },
                            operation,
                        )
                        const validated = await output['~standard'].validate(result.data)
                        if (validated.issues)
                            throw new LitiError(
                                'LITI_AI_OUTPUT_INVALID',
                                'Invalid AI output.',
                                validated.issues.map((issue) => ({ path: 'output', message: issue.message })),
                            )
                        result = { ...result, data: validated.value }
                    } else if (definition.capability === 'decision') {
                        const state = await definition.state(input, operation)
                        signal.throwIfAborted()
                        result = await provider.decision!.decide(
                            {
                                state,
                                questions: definition.questions,
                                ...(definition.options ? { options: definition.options } : {}),
                            },
                            operation,
                        )
                        const checked = await decisionSchema(definition.questions)['~standard'].validate(result.data)
                        if (checked.issues) throw new LitiError('LITI_AI_OUTPUT_INVALID', 'Invalid decision output.')
                    } else {
                        const source = await definition.source(input, operation)
                        validateExtractionInput(source)
                        signal.throwIfAborted()
                        result = await provider.extraction!.extract({ ...source, fields: definition.fields }, operation)
                        const checked = await extractionSchema(definition.fields)['~standard'].validate(result.data)
                        if (checked.issues) throw new LitiError('LITI_AI_OUTPUT_INVALID', 'Invalid extraction output.')
                    }
                    signal.throwIfAborted()
                    return result
                } catch (error) {
                    signal.throwIfAborted()
                    if (error instanceof LitiError) throw error
                    throw new LitiError('LITI_AI_FAILED', 'AI action failed.')
                } finally {
                    active--
                }
            },
        }
    }
    return {
        id: '@litijs/ai',
        apiVersion: 1 as const,
        actions: actions as { [Name in keyof Actions]: Bound<Actions[Name]> },
        validate,
    }
}
