import type { StandardSchemaV1, StandardJSONSchemaV1 } from '@standard-schema/spec'
import type { ActionResult, OperationContext } from 'liti'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type OutputSchema<Output = unknown> = StandardSchemaV1<unknown, Output> & StandardJSONSchemaV1<unknown, Output>
export interface AiMetadata {
    usage?:
        | {
              inputTokens?: number | undefined
              outputTokens?: number | undefined
              totalTokens?: number | undefined
              [key: string]: unknown
          }
        | undefined
    finishReason?: string | undefined
    warnings?: readonly unknown[] | undefined
    rounding?: { probabilityDecimals?: number; scoreDecimals?: number } | undefined
    providerMetadata?: Record<string, unknown> | undefined
    response?: { id?: string | undefined; modelId?: string | undefined; timestamp?: string | undefined } | undefined
}
export interface TextOptions {
    maxRetries?: number
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    presencePenalty?: number
    frequencyPenalty?: number
    stopSequences?: string[]
    seed?: number
    headers?: Record<string, string>
    providerOptions?: Record<string, Record<string, JsonValue>>
}
export interface TextRequest<Output = unknown> {
    prompt: string
    output?: OutputSchema<Output>
    options?: TextOptions
}
export type TextEvent<Output = unknown> =
    | { type: 'delta'; text: string }
    | { type: 'complete'; result: ActionResult<Output, AiMetadata> }

type DecisionInput = string | Readonly<Record<string, JsonValue>> | readonly JsonValue[]
export type DecisionQuestion =
    | { type: 'choice'; instructions?: DecisionInput | null; criteria: Readonly<Record<string, DecisionInput | null>> }
    | { type: 'score'; instructions?: DecisionInput | null; criteria: readonly (DecisionInput | null)[] }
    | {
          type: 'boolean'
          instructions?: DecisionInput | null
          criteria?: { true?: DecisionInput | null; false?: DecisionInput | null }
      }
    | { type: 'box'; instructions: DecisionInput }
export type DecisionState =
    | string
    | Readonly<Record<string, JsonValue>>
    | readonly (
          | { type: 'text'; text: string }
          | { type: 'json'; value: JsonValue }
          | { type: 'file'; data: string | Uint8Array | ArrayBuffer | URL; mediaType: string; filename?: string }
      )[]
export type DecisionAnswers<Questions extends Record<string, DecisionQuestion>> = {
    [Name in keyof Questions]: Questions[Name] extends { type: 'choice'; criteria: infer Criteria }
        ? {
              type: 'choice'
              choice: Extract<keyof Criteria, string>
              probabilities?: Record<Extract<keyof Criteria, string>, number>
          }
        : Questions[Name] extends { type: 'score' }
          ? { type: 'score'; score: number; probabilities?: Record<string, number> }
          : Questions[Name] extends { type: 'box' }
            ? { type: 'box'; box: { top: number; bottom: number; left: number; right: number } }
            : { type: 'boolean'; probability: number }
}
export interface DecisionRequest<
    Questions extends Record<string, DecisionQuestion> = Record<string, DecisionQuestion>,
> {
    state: DecisionState
    questions: Questions
    options?: Pick<TextOptions, 'maxRetries' | 'headers' | 'providerOptions'>
}

type ScalarType = 'text' | 'number' | 'date' | 'time' | 'datetime' | 'duration'
type Prediction = {
    min: number | string
    max: number | string
    step?: number | 'month' | 'year'
    scale?: 'linear' | 'log'
}
export type ExtractionField = { instructions?: string; unit?: string } & (
    | { type: ScalarType; integer?: boolean; decimals?: number; null_threshold?: number }
    | { type: 'list'; items: 'text' | 'number' | 'date'; decimals?: number }
    | ({ type: 'estimate' } & Prediction)
    | ({
          type: 'forecast'
          horizon: number
          interval?: 'step' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'
      } & Prediction)
)
export interface ExtractionInput {
    state: string
    images?: readonly (string | { content_type: string; base64: string })[]
    reference_date?: string
    options?: { include_quantiles?: boolean; return_state_text?: boolean }
}
type PredictionValue<Field> = Field extends { min: string } ? string : number
export type Estimate<Value = number | string> = {
    value: Value
    mean?: Value
    median: Value
    p10: Value
    p90: Value
    p_below?: number
    p_above?: number
    quantiles?: Value[]
}
export type ExtractionAnswer<Field extends ExtractionField> = Field extends { type: 'forecast' }
    ? { type: 'forecast'; value: PredictionValue<Field>[]; steps: Estimate<PredictionValue<Field>>[] }
    : Field extends { type: 'estimate' }
      ? { type: 'estimate' } & Estimate<PredictionValue<Field>>
      : Field extends { type: 'list'; items: infer Item }
        ? {
              type: 'list'
              value: (Item extends 'number' ? number : string)[]
              spans?: [number, number][]
              confidence?: number
          }
        : {
              type: Field['type']
              value: (Field['type'] extends 'number' | 'duration' ? number : string) | null
              guess?: Field['type'] extends 'number' | 'duration' ? number : string
              p_null?: number
              confidence?: number
              span?: [number, number]
          }
export type ExtractionAnswers<Fields extends Record<string, ExtractionField>> = {
    [Name in keyof Fields]: ExtractionAnswer<Fields[Name]>
}
export interface ExtractionRequest<
    Fields extends Record<string, ExtractionField> = Record<string, ExtractionField>,
> extends ExtractionInput {
    fields: Fields
}
export interface ExtractionMetadata extends AiMetadata {
    truncated: boolean
    stateText?: string
}
export interface AiProvider {
    id: string
    text?: {
        generate<Output = string>(
            request: TextRequest<Output>,
            context: OperationContext,
        ): Promise<ActionResult<Output, AiMetadata>>
        stream?<Output = string>(
            request: TextRequest<Output>,
            context: OperationContext,
        ): AsyncIterable<TextEvent<Output>>
    }
    decision?: {
        decide<const Questions extends Record<string, DecisionQuestion>>(
            request: DecisionRequest<Questions>,
            context: OperationContext,
        ): Promise<ActionResult<DecisionAnswers<Questions>, AiMetadata>>
    }
    extraction?: {
        extract<const Fields extends Record<string, ExtractionField>>(
            request: ExtractionRequest<Fields>,
            context: OperationContext,
        ): Promise<ActionResult<ExtractionAnswers<Fields>, ExtractionMetadata>>
    }
}
