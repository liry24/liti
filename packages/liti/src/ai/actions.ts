import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
    Experimental_DecisionModel,
    Experimental_DecisionQuestion,
    Experimental_DecisionResult,
    Output,
    experimental_decide,
    generateText,
} from 'ai'
import type { LitiAIModel, LitiAIModelContext } from '../ai'

export type LitiAiInput = StandardSchemaV1
export type LitiAiActionInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>
type ValidatedInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>
export type LitiDecisionModel =
    | Exclude<Experimental_DecisionModel, string>
    | ((
          context: LitiAIModelContext,
      ) => Exclude<Experimental_DecisionModel, string> | Promise<Exclude<Experimental_DecisionModel, string>>)
type Questions = Record<string, Experimental_DecisionQuestion>
type TextOptions = Omit<Parameters<typeof generateText>[0], 'model' | 'prompt' | 'messages' | 'output'>
type DecisionOptions = Omit<Parameters<typeof experimental_decide>[0], 'model' | 'state' | 'questions'>
type DecisionState = Parameters<typeof experimental_decide>[0]['state']

export type LitiNamedAiAction<Input extends LitiAiInput = LitiAiInput> =
    | {
          type: 'text-generation'
          model?: LitiAIModel
          input: Input
          prompt: {
              run(input: ValidatedInput<Input>, context: LitiAIModelContext): string | Promise<string>
          }['run']
          output?:
              | Output.Output
              | {
                    run(
                        input: ValidatedInput<Input>,
                        context: LitiAIModelContext,
                    ): Output.Output | Promise<Output.Output>
                }['run']
          options?: TextOptions
      }
    | {
          type: 'decision'
          model?: LitiDecisionModel
          input: Input
          state: {
              run(input: ValidatedInput<Input>, context: LitiAIModelContext): DecisionState | Promise<DecisionState>
          }['run']
          questions: Questions
          options?: DecisionOptions
      }

export type LitiAiActionsFromInput<Input extends Record<string, LitiAiInput>> = {
    [Name in keyof Input]: LitiNamedAiAction<Input[Name]>
}
export type LitiAiActionData<Action> = Action extends { type: 'text-generation' }
    ? Action extends { output: infer Spec }
        ? (Spec extends (...args: never[]) => unknown ? Awaited<ReturnType<Spec>> : Spec) extends Output.Output<
              infer Complete
          >
            ? Complete
            : never
        : string
    : Action extends { type: 'decision'; questions: infer TypedQuestions extends Questions }
      ? Experimental_DecisionResult<TypedQuestions>['answers']
      : never
export type InferLitiNamedAiActions<Config> = Config extends { ai: { actions: infer Actions } }
    ? {
          [Name in keyof Actions]: {
              input: Actions[Name] extends { input: infer Input extends LitiAiInput } ? LitiAiActionInput<Input> : never
              data: LitiAiActionData<Actions[Name]>
          }
      }
    : {}
