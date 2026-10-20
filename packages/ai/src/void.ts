import { LitiError, type OperationContext } from 'liti'
import type { AiProvider, ExtractionField, ExtractionRequest, ExtractionMetadata } from './types'
import { extractionSchema, validateExtractionInput, validateFields } from './extraction'
import { object, finite } from './schema'

/** This provider uses Clairic's native field protocol; Clef evaluators remain a separate application capability. */
export function voidAi(options: { extraction?: '@cf/cloudflare/clairic' } = {}): AiProvider {
    return {
        id: '@litijs/ai/void',
        ...(options.extraction
            ? {
                  extraction: {
                      async extract<Fields extends Record<string, ExtractionField>>(
                          request: ExtractionRequest<Fields>,
                          context: OperationContext,
                      ) {
                          validateFields(request.fields)
                          validateExtractionInput(request)
                          context.signal?.throwIfAborted()
                          const { ai } = await import('void/ai')
                          context.signal?.throwIfAborted()
                          const result = await ai.run(
                              options.extraction!,
                              { ...request, model: 'clairic' },
                              { ...(context.signal ? { signal: context.signal } : {}) },
                          )
                          context.signal?.throwIfAborted()
                          if (
                              !object(result) ||
                              result.truncated !== false ||
                              !object(result.usage) ||
                              !finite(result.usage.input_tokens) ||
                              !finite(result.usage.output_tokens)
                          )
                              throw new LitiError('LITI_AI_OUTPUT_INVALID', 'Incomplete extraction response.')
                          const checked = await extractionSchema(request.fields)['~standard'].validate(result.answers)
                          if (checked.issues)
                              throw new LitiError('LITI_AI_OUTPUT_INVALID', 'Invalid extraction response.')
                          const metadata: ExtractionMetadata = {
                              truncated: false,
                              ...(typeof result.state_text === 'string' ? { stateText: result.state_text } : {}),
                              usage: {
                                  ...result.usage,
                                  inputTokens: result.usage.input_tokens,
                                  outputTokens: result.usage.output_tokens,
                                  totalTokens: result.usage.input_tokens + result.usage.output_tokens,
                              },
                              response: {
                                  modelId: typeof result.model === 'string' ? result.model : options.extraction,
                              },
                          }
                          return { data: checked.value, metadata }
                      },
                  },
              }
            : {}),
    }
}
