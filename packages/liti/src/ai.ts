import type { LanguageModel } from 'ai'

export type { LitiAIConfig } from './config'
export { executeLitiAiAction } from './ai/actions-execution'
export type {
    InferLitiNamedAiActions,
    LitiAiActionData,
    LitiAiActionInput,
    LitiNamedAiAction,
    LitiDecisionModel,
} from './ai/actions'

/** Explicit generation context; provider-specific bindings remain application-owned.
 * Nuxt HTTP passes its request context. Applications invoke the native AI SDK directly for background generation.
 */
export interface LitiAIModelContext {
    request?: Request
    platformContext?: object
}

/** An application-selected SDK model, optionally resolved from the current request/task. */
export type LitiAIModel = LanguageModel | ((context: LitiAIModelContext) => LanguageModel | Promise<LanguageModel>)
