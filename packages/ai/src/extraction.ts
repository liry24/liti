import { LitiError } from 'liti'
import type { ExtractionField, ExtractionAnswers, ExtractionInput } from './types'
import { schema, object, finite, probability } from './schema'

const span = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    value[0] <= value[1]
const date = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value

export function validateFields(fields: Record<string, ExtractionField>): void {
    if (!Object.keys(fields).length) throw new LitiError('LITI_INVALID_INPUT', 'Extraction fields cannot be empty.')
    for (const [name, field] of Object.entries(fields)) {
        let valid = true
        if ('decimals' in field && field.decimals !== undefined)
            valid &&= Number.isInteger(field.decimals) && field.decimals >= 0 && field.decimals <= 6
        if ('null_threshold' in field && field.null_threshold !== undefined)
            valid &&= probability(field.null_threshold) && field.null_threshold > 0
        if (field.type === 'estimate' || field.type === 'forecast') {
            valid &&=
                (finite(field.min) && finite(field.max) && field.min < field.max) ||
                (date(field.min) && date(field.max) && field.min < field.max)
            if (field.step !== undefined)
                valid &&= (finite(field.step) && field.step > 0) || field.step === 'month' || field.step === 'year'
        }
        if (field.type === 'forecast')
            valid &&= Number.isInteger(field.horizon) && field.horizon >= 1 && field.horizon <= 64
        if (!valid) throw new LitiError('LITI_INVALID_INPUT', `Invalid extraction field "${name}".`)
    }
}

export function validateExtractionInput(input: ExtractionInput): void {
    if (typeof input.state !== 'string' || (!input.state.trim() && !input.images?.length))
        throw new LitiError('LITI_INVALID_INPUT', 'Extraction requires text or images.')
    if (input.reference_date !== undefined && !date(input.reference_date))
        throw new LitiError('LITI_INVALID_INPUT', 'reference_date must be an ISO date.')
    if (
        input.images &&
        (input.images.length > 4 ||
            input.images.some((image) =>
                typeof image === 'string'
                    ? !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/iu.test(image)
                    : !/^image\/(?:png|jpeg|webp)$/u.test(image.content_type) ||
                      !/^[A-Za-z0-9+/=\r\n]+$/u.test(image.base64),
            ))
    )
        throw new LitiError('LITI_INVALID_INPUT', 'Extraction accepts up to four embedded PNG, JPEG or WebP images.')
}

export const extractionSchema = <Fields extends Record<string, ExtractionField>>(fields: Fields) =>
    schema<ExtractionAnswers<Fields>>({ type: 'object' }, (value) => {
        if (!object(value)) return { issues: [{ message: 'Expected extraction answers.' }] }
        const issues: { path: string[]; message: string }[] = []
        if (Object.keys(value).some((key) => !Object.hasOwn(fields, key)))
            issues.push({ path: [], message: 'Unexpected extraction answer.' })
        for (const [name, field] of Object.entries(fields)) {
            const answer = value[name]
            let valid = object(answer) && answer.type === field.type && Object.hasOwn(answer, 'value')
            if (valid && object(answer)) {
                for (const key of ['confidence', 'p_null', 'p_below', 'p_above'])
                    if (answer[key] !== undefined) valid &&= probability(answer[key])
                if (answer.span !== undefined) valid &&= span(answer.span)
                if (answer.spans !== undefined) valid &&= Array.isArray(answer.spans) && answer.spans.every(span)
                const scalar = (v: unknown, kind: string): boolean =>
                    kind === 'number' || kind === 'duration'
                        ? finite(v)
                        : kind === 'date'
                          ? date(v)
                          : typeof v === 'string'
                if (field.type === 'estimate' || field.type === 'forecast') {
                    const kind = typeof field.min === 'string' ? 'date' : 'number'
                    const estimate = (v: unknown): boolean =>
                        object(v) &&
                        ['value', 'median', 'p10', 'p90'].every((key) => scalar(v[key], kind)) &&
                        (v.mean === undefined || scalar(v.mean, kind)) &&
                        (v.quantiles === undefined ||
                            (Array.isArray(v.quantiles) && v.quantiles.every((q) => scalar(q, kind)))) &&
                        (v.p_below === undefined || probability(v.p_below)) &&
                        (v.p_above === undefined || probability(v.p_above))
                    valid &&=
                        field.type === 'estimate'
                            ? estimate(answer)
                            : Array.isArray(answer.steps) &&
                              answer.steps.length === field.horizon &&
                              answer.steps.every(estimate) &&
                              Array.isArray(answer.value) &&
                              answer.value.length === field.horizon &&
                              answer.value.every((v) => scalar(v, kind))
                } else if (field.type === 'list') {
                    valid &&= Array.isArray(answer.value) && answer.value.every((v) => scalar(v, field.items))
                    if (answer.spans !== undefined && Array.isArray(answer.spans) && Array.isArray(answer.value))
                        valid &&= answer.spans.length === answer.value.length
                } else {
                    valid &&= answer.value === null || scalar(answer.value, field.type)
                    if (answer.guess !== undefined) valid &&= scalar(answer.guess, field.type)
                    if (field.integer && answer.value !== null) valid &&= Number.isInteger(answer.value)
                }
            }
            if (!valid) issues.push({ path: [name], message: 'Incomplete or invalid extraction answer.' })
        }
        return issues.length ? { issues } : { value: value as ExtractionAnswers<Fields> }
    })
