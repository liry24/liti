import { z } from 'zod'
import { Experimental_DecisionMockModelV4, MockLanguageModelV4 } from 'ai/test'
import { defineLitiConfig, type InferLitiActions } from '../packages/liti/src'
import { ai, createTextAction, createDecisionAction, createExtractionAction } from '../packages/ai/src'
import { aiSdk } from '../packages/ai/src/ai-sdk'

const model = new MockLanguageModelV4()
const decisionModel = new Experimental_DecisionMockModelV4()
const config = defineLitiConfig({
    plugins: [
        ai({
            provider: aiSdk({ text: model, decision: decisionModel }),
            actions: {
                proofread: createTextAction({
                    input: z.object({ content: z.string(), tone: z.string().optional() }).strict(),
                    prompt: ({ content, tone }) => content.toUpperCase() + (tone ?? ''),
                    output: z.object({ content: z.string() }),
                }),
                text: createTextAction({ input: z.object({ content: z.string() }), prompt: ({ content }) => content }),
                guarded: createTextAction({
                    input: z.object({ count: z.string().transform(Number) }),
                    prompt: ({ count }) => count.toFixed(),
                    output: async ({ count }) => z.object({ count: z.number().refine((value) => value === count) }),
                }),
                classify: createDecisionAction({
                    input: z.object({ content: z.string() }),
                    state: ({ content }) => ({ content }),
                    questions: { category: { type: 'choice', criteria: { technology: 'Technology', diary: 'Diary' } } },
                }),
                invoice: createExtractionAction({
                    input: z.object({ text: z.string() }),
                    source: ({ text }) => ({ state: text }),
                    fields: { amount: { type: 'number' }, date: { type: 'date' } },
                }),
            },
        }),
    ],
})
type Actions = InferLitiActions<typeof config>
const input: Actions['proofread']['input'] = { content: 'Typed' }
const result: Actions['proofread']['output'] = { content: 'Typed' }
const text: Actions['text']['output'] = 'Typed'
const guarded: Actions['guarded']['output'] = { count: 1 }
const guardedProps: Actions['guarded']['input'] = { count: '1' }
// @ts-expect-error Schema input differs from validated prompt input.
const wrongGuardedProps: Actions['guarded']['input'] = { count: 1 }
const decision: Actions['classify']['output'] = { category: { type: 'choice', choice: 'technology' } }
// @ts-expect-error Output remains the native object shape.
const wrongOutput: Actions['proofread']['output'] = 'Typed'
// @ts-expect-error Native decision choices are preserved.
const wrongChoice: Actions['classify']['output'] = { category: { type: 'choice', choice: 'unknown' } }
// @ts-expect-error Schema input requires content.
const missingProp: Actions['proofread']['input'] = {}
// @ts-expect-error Input does not accept an unknown key.
const extraProp: Actions['proofread']['input'] = { content: 'Typed', unknown: true }
const amount: Actions['invoice']['output']['amount']['value'] = null
// @ts-expect-error A numeric extraction cannot become text.
const wrongAmount: Actions['invoice']['output']['amount']['value'] = '12'
// @ts-expect-error A text model is not a native decision model.
aiSdk({ decision: model })
// @ts-expect-error A native decision model cannot generate text.
aiSdk({ text: decisionModel })
void [
    input,
    result,
    text,
    guarded,
    guardedProps,
    wrongGuardedProps,
    decision,
    wrongOutput,
    wrongChoice,
    missingProp,
    extraProp,
    amount,
    wrongAmount,
]
