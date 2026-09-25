/**
 * Schemas for the prompt-optimization pipeline.
 *
 * `PromptOptimizationResult` is the validated, structured optimization result:
 * everything the decision model contributes is data checked by these schemas
 * before it affects anything. The decision models never generate free text;
 * `optimized_prompt` is assembled deterministically from the original request
 * plus decision-selected enhancement fragments, and `changes` / `assumptions` /
 * `warnings` are composed from validated decision values and curated library
 * entries (see `moves.ts`).
 */
import { z } from 'zod'

export const MAX_PROMPT_CHARS = 64_000
export const MAX_RESULT_PROMPT_CHARS = 200_000

/** Constraints may arrive as one block of text or as discrete items. */
const constraintsSchema = z.union([
  z.string().max(8_000),
  z.array(z.string().min(1).max(2_000)).max(20),
])

export const optimizePromptRequestSchema = z.object({
  /** The original prompt. Preserved verbatim in the optimized output. */
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  /** Optional objective/context: what the prompt is for. */
  context: z.string().max(16_000).optional(),
  /** Optional target model the prompt will be sent to. */
  targetModel: z.string().max(200).optional(),
  /** Optional requirements that MUST be preserved verbatim in the output. */
  constraints: constraintsSchema.optional(),
  /** Optional extra optimization instructions from the caller. */
  instructions: z.string().max(8_000).optional(),
  /** Per-call validation override (defaults to the configured mode). */
  validation: z.enum(['strict', 'basic', 'off']).optional(),
  /** Cancellation. */
  signal: z.instanceof(AbortSignal).optional(),
})

export type OptimizePromptRequest = z.input<typeof optimizePromptRequestSchema>
export type NormalizedOptimizePromptRequest = z.output<typeof optimizePromptRequestSchema>

const shortString = z.string().min(1).max(2_000)

export const promptOptimizationResultSchema = z.object({
  /** The final enhanced prompt. Always contains the original request verbatim. */
  optimized_prompt: z.string().min(1).max(MAX_RESULT_PROMPT_CHARS),
  /** Human-readable summary of what changed and why. */
  changes: z.array(shortString).max(50),
  /** Assumptions the enhancement introduced — disclosed, never silent. */
  assumptions: z.array(shortString).max(50),
  /** Warnings (validation downgrades, truncation, model caveats). */
  warnings: z.array(shortString).max(50),
  /** Observability metadata. Contains no prompt content. */
  meta: z
    .object({
      provider: z.string(),
      model: z.string(),
      validation: z.enum(['strict', 'basic', 'off']),
      questionCount: z.number().int().nonnegative(),
      decisionLatencyMs: z.number().nonnegative().optional(),
      /** Compact decision summary, e.g. {"intent":"writing","vagueness":1.02}. */
      decisions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .optional(),
})

export type PromptOptimizationResult = z.infer<typeof promptOptimizationResultSchema>
