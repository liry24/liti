import {
    generateText,
    streamText,
    experimental_decide,
    Output,
    type LanguageModel,
    type Experimental_DecisionModel,
    type Experimental_DecisionResult,
} from 'ai'
import { LitiError, type OperationContext } from 'liti'
import type { AiMetadata, AiProvider, DecisionAnswers, DecisionQuestion, OutputSchema, TextEvent } from './types'

type Source<Model> = Model | ((context: OperationContext) => Model | Promise<Model>)
export interface AiSdkOptions {
    text?: Source<LanguageModel>
    decision?: Source<Exclude<Experimental_DecisionModel, string>>
}
const resolve = async <Model>(source: Source<Model>, context: OperationContext): Promise<Model> =>
    typeof source === 'function' ? (source as (context: OperationContext) => Model | Promise<Model>)(context) : source
const complete = <Value>(schema?: OutputSchema<Value>): Output.Output<Value> => {
    const output = schema ? Output.object({ schema }) : (Output.text() as unknown as Output.Output<Value>)
    return {
        ...output,
        async parseCompleteOutput(value, completion) {
            if (schema && completion.finishReason !== 'stop')
                throw new LitiError('LITI_AI_OUTPUT_INVALID', 'AI returned an incomplete result.')
            return output.parseCompleteOutput(value, completion)
        },
    }
}
const metadata = (result: {
    usage?: AiMetadata['usage']
    finishReason?: string
    warnings?: readonly unknown[] | undefined
    providerMetadata?: Record<string, unknown> | undefined
    response?: { id?: string | undefined; modelId?: string | undefined; timestamp?: Date | undefined }
    rounding?: AiMetadata['rounding']
}): AiMetadata => ({
    usage: result.usage,
    finishReason: result.finishReason,
    warnings: result.warnings,
    providerMetadata: result.providerMetadata,
    rounding: result.rounding,
    ...(result.response
        ? {
              response: {
                  id: result.response.id,
                  modelId: result.response.modelId,
                  timestamp: result.response.timestamp?.toISOString(),
              },
          }
        : {}),
})

/** Native SDK models remain opaque and are resolved only for an explicit operation. */
export function aiSdk(options: AiSdkOptions = {}): AiProvider {
    return {
        id: '@litijs/ai/ai-sdk',
        ...(options.text
            ? {
                  text: {
                      async generate<Output>(
                          request: import('./types').TextRequest<Output>,
                          context: OperationContext,
                      ) {
                          context.signal?.throwIfAborted()
                          const model = await resolve(options.text!, context)
                          context.signal?.throwIfAborted()
                          const result = await generateText({
                              maxRetries: 0,
                              ...request.options,
                              model,
                              prompt: request.prompt,
                              output: complete(request.output),
                              ...(context.signal ? { abortSignal: context.signal } : {}),
                          })
                          return { data: result.output, metadata: metadata(result) }
                      },
                      async *stream<Output>(
                          request: import('./types').TextRequest<Output>,
                          context: OperationContext,
                      ): AsyncIterable<TextEvent<Output>> {
                          const cancel = new AbortController()
                          const signal = AbortSignal.any([
                              cancel.signal,
                              ...[context.signal, context.request?.signal].filter((s): s is AbortSignal => !!s),
                          ])
                          signal.throwIfAborted()
                          const model = await resolve(options.text!, { ...context, signal })
                          signal.throwIfAborted()
                          const result = streamText({
                              maxRetries: 0,
                              ...request.options,
                              model,
                              prompt: request.prompt,
                              output: complete(request.output),
                              abortSignal: signal,
                          })
                          try {
                              for await (const part of result.fullStream) {
                                  signal.throwIfAborted()
                                  if (part.type === 'error') throw new LitiError('LITI_AI_FAILED', 'AI stream failed.')
                                  if (part.type === 'text-delta') yield { type: 'delta', text: part.text }
                              }
                              const data = await result.output
                              signal.throwIfAborted()
                              yield {
                                  type: 'complete',
                                  result: {
                                      data,
                                      metadata: metadata({
                                          usage: await result.usage,
                                          finishReason: await result.finishReason,
                                          warnings: await result.warnings,
                                          providerMetadata: await result.providerMetadata,
                                          response: await result.response,
                                      }),
                                  },
                              }
                          } finally {
                              cancel.abort()
                          }
                      },
                  },
              }
            : {}),
        ...(options.decision
            ? {
                  decision: {
                      async decide<Questions extends Record<string, DecisionQuestion>>(
                          request: import('./types').DecisionRequest<Questions>,
                          context: OperationContext,
                      ) {
                          context.signal?.throwIfAborted()
                          const model = await resolve(options.decision!, context)
                          context.signal?.throwIfAborted()
                          const result: Experimental_DecisionResult<Questions> = await experimental_decide({
                              maxRetries: 0,
                              ...request.options,
                              model,
                              state: request.state,
                              questions: request.questions,
                              ...(context.signal ? { abortSignal: context.signal } : {}),
                          })
                          return { data: result.answers as DecisionAnswers<Questions>, metadata: metadata(result) }
                      },
                  },
              }
            : {}),
    }
}
