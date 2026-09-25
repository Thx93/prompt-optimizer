/**
 * Zod schemas for validating decision-model output before it can affect the
 * optimization pipeline. Decision models emit typed values, but transport
 * layers and third-party servers can still return anything — every response
 * passes through these parsers before use.
 */
import { z } from 'zod'

/** Probabilities must be finite numbers in [0, 1]. */
const probability = z.number().finite().min(0).max(1)

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: probability,
  confidence: probability.optional(),
  answer_confidence: probability.optional(),
  action: z.record(z.string(), z.unknown()).optional(),
})

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1),
  confidence: probability.optional(),
  answer_confidence: probability.optional(),
  probabilities: z.record(z.string(), probability).optional(),
  action: z.record(z.string(), z.unknown()).optional(),
})

const scoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number().finite(),
  confidence: probability.optional(),
  answer_confidence: probability.optional(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.string(), probability).optional(),
  action: z.record(z.string(), z.unknown()).optional(),
})

const decisionAnswerSchema = z.discriminatedUnion('type', [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
])

const usageSchema = z.object({
  input_tokens: z.number().finite().nonnegative().optional(),
  output_tokens: z.number().finite().nonnegative().optional(),
})

/**
 * Response envelope shared by JEV (Command Code `/systemone`) and Laya
 * (`laya-serve` `/v1/systemone`), tolerating Laya's extra fields
 * (`answer_confidence`, `action`, `routing`).
 */
export const decisionResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), decisionAnswerSchema),
  usage: usageSchema.optional(),
  routing: z.record(z.string(), z.unknown()).optional(),
})

export type ParsedDecisionAnswer = z.infer<typeof decisionResponseSchema>['answers'][string]
export type ParsedDecisionResponse = z.infer<typeof decisionResponseSchema>

/** Question schema, for validating a request before it leaves the process. */
export const decisionQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    key: z.string().min(1).max(64),
    type: z.literal('noul'),
    instructions: z.string().min(1),
    criteria: z
      .object({ true: z.string().optional(), false: z.string().optional() })
      .optional(),
  }),
  z.object({
    key: z.string().min(1).max(64),
    type: z.literal('choice'),
    instructions: z.string().min(1),
    criteria: z.record(z.string().min(1), z.string().nullable()),
  }),
  z.object({
    key: z.string().min(1).max(64),
    type: z.literal('score'),
    instructions: z.string().min(1),
    criteria: z.array(z.string().min(1)).min(2).max(10),
  }),
])

/**
 * Normalize a raw answer into the canonical form used by the pipeline:
 * prefer the calibrated `answer_confidence` (Laya) over `confidence`.
 */
export function canonicalConfidence(answer: ParsedDecisionAnswer): number | undefined {
  return answer.answer_confidence ?? answer.confidence
}
