import { LitiError } from 'liti'
import type { DecisionQuestion, DecisionAnswers } from './types'
import { schema, object, finite, probability } from './schema'

export function validateQuestions(questions: Record<string, DecisionQuestion>): void {
    if (!Object.keys(questions).length) throw new LitiError('LITI_INVALID_INPUT', 'Decision questions cannot be empty.')
    for (const [name, question] of Object.entries(questions)) {
        if ((question.type === 'choice' || question.type === 'score') && !Object.keys(question.criteria).length)
            throw new LitiError('LITI_INVALID_INPUT', `Decision "${name}" requires criteria.`)
        if (
            question.type === 'boolean' &&
            question.instructions == null &&
            question.criteria?.true == null &&
            question.criteria?.false == null
        )
            throw new LitiError('LITI_INVALID_INPUT', `Decision "${name}" requires instructions or criteria.`)
    }
}

export const decisionSchema = <Questions extends Record<string, DecisionQuestion>>(questions: Questions) =>
    schema<DecisionAnswers<Questions>>({ type: 'object' }, (value) => {
        const issues: { path: string[]; message: string }[] = []
        if (!object(value)) return { issues: [{ message: 'Expected decision answers.' }] }
        if (Object.keys(value).some((key) => !Object.hasOwn(questions, key)))
            issues.push({ path: [], message: 'Unexpected decision answer.' })
        for (const [name, question] of Object.entries(questions)) {
            const answer = value[name]
            let valid = object(answer) && answer.type === question.type
            if (valid && object(answer)) {
                if (question.type === 'boolean') valid = probability(answer.probability)
                if (question.type === 'choice')
                    valid = typeof answer.choice === 'string' && Object.hasOwn(question.criteria, answer.choice)
                if (question.type === 'score')
                    valid = finite(answer.score) && answer.score >= 0 && answer.score <= question.criteria.length - 1
                if (question.type === 'box') {
                    const box = answer.box
                    valid =
                        object(box) &&
                        ['top', 'bottom', 'left', 'right'].every((edge) => probability(box[edge])) &&
                        Number(box.top) <= Number(box.bottom) &&
                        Number(box.left) <= Number(box.right)
                }
                if (answer.probabilities !== undefined) {
                    const keys =
                        question.type === 'choice'
                            ? Object.keys(question.criteria)
                            : question.type === 'score'
                              ? question.criteria.map((_, index) => String(index))
                              : []
                    const distribution = answer.probabilities
                    valid &&=
                        object(distribution) &&
                        Object.keys(distribution).length === keys.length &&
                        keys.every((key) => probability(distribution[key]))
                }
            }
            if (!valid) issues.push({ path: [name], message: 'Incomplete or invalid decision answer.' })
        }
        return issues.length ? { issues } : { value: value as DecisionAnswers<Questions> }
    })
