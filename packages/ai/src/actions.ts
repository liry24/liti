import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { OperationContext } from 'liti'
import type {
    AiProvider,
    DecisionQuestion,
    DecisionRequest,
    ExtractionField,
    ExtractionInput,
    OutputSchema,
    TextOptions,
} from './types'
import { decisionSchema, validateQuestions } from './decision'
import { extractionSchema, validateFields } from './extraction'
import { stringSchema } from './schema'

export interface TextAction<Input extends StandardSchemaV1 = StandardSchemaV1, Output = unknown> {
    capability: 'text'
    contract?: string
    provider?: AiProvider
    input: Input
    output:
        | OutputSchema<Output>
        | {
              resolve(
                  input: StandardSchemaV1.InferOutput<Input>,
                  context: OperationContext,
              ): OutputSchema<Output> | Promise<OutputSchema<Output>>
          }['resolve']
    prompt(input: StandardSchemaV1.InferOutput<Input>, context: OperationContext): string | Promise<string>
    options?: TextOptions
    /** Omitted for ordinary text; true requires the provider's structured output capability. */
    structured?: boolean
}
export function createTextAction<Input extends StandardSchemaV1, Output>(
    definition: Omit<TextAction<Input, Output>, 'capability' | 'structured'>,
): TextAction<Input, Output>
export function createTextAction<Input extends StandardSchemaV1>(
    definition: Omit<TextAction<Input, string>, 'capability' | 'structured' | 'output'> & { output?: never },
): TextAction<Input, string>
export function createTextAction<Input extends StandardSchemaV1, Output = string>(
    definition: Omit<TextAction<Input, Output>, 'capability' | 'structured' | 'output'> & {
        output?: TextAction<Input, Output>['output']
    },
): TextAction<Input, Output> {
    return {
        ...definition,
        capability: 'text',
        structured: definition.output !== undefined,
        output: definition.output ?? (stringSchema as OutputSchema<Output>),
    }
}

export interface DecisionAction<
    Input extends StandardSchemaV1 = StandardSchemaV1,
    Questions extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> {
    capability: 'decision'
    provider?: AiProvider
    contract?: string
    input: Input
    questions: Questions
    state(
        input: StandardSchemaV1.InferOutput<Input>,
        context: OperationContext,
    ): DecisionRequest['state'] | Promise<DecisionRequest['state']>
    options?: DecisionRequest['options']
}
export const createDecisionAction = <
    Input extends StandardSchemaV1,
    const Questions extends Record<string, DecisionQuestion>,
>(
    definition: Omit<DecisionAction<Input, Questions>, 'capability'>,
) => {
    validateQuestions(definition.questions)
    return { ...definition, capability: 'decision' as const, output: decisionSchema(definition.questions) }
}

export interface ExtractionAction<
    Input extends StandardSchemaV1 = StandardSchemaV1,
    Fields extends Record<string, ExtractionField> = Record<string, ExtractionField>,
> {
    capability: 'extraction'
    provider?: AiProvider
    contract?: string
    input: Input
    fields: Fields
    source(
        input: StandardSchemaV1.InferOutput<Input>,
        context: OperationContext,
    ): ExtractionInput | Promise<ExtractionInput>
}
export const createExtractionAction = <
    Input extends StandardSchemaV1,
    const Fields extends Record<string, ExtractionField>,
>(
    definition: Omit<ExtractionAction<Input, Fields>, 'capability'>,
) => {
    validateFields(definition.fields)
    return { ...definition, capability: 'extraction' as const, output: extractionSchema(definition.fields) }
}
