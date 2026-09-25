/**
 * PromptOptimizer — the decision-driven prompt-enhancement pipeline.
 *
 * Stages (kept explicit for auditability):
 *   1. Normalize & validate the input request
 *   2. Compose the requirements/objective state
 *   3. Build the optimization decision questions
 *   4. Call the decision-maker provider (one batched request)
 *   5. Parse + validate the structured decision set
 *   6. Assemble the enhanced prompt and validate it
 *      (mechanical guarantees + optional decision gates)
 *   7. Emit the final enhanced prompt
 *   8. Emit the change/assumption/warning summary
 *
 * The decision-maker never sees credentials beyond the provider's own auth
 * header and never emits text; every fragment in the output comes from the
 * user's input or the reviewed enhancement-move library.
 */
import {
  loadDecisionMakerConfig,
  type DecisionMakerConfig,
  type ValidationMode,
} from '../decision-maker/config'
import { DecisionMakerError } from '../decision-maker/errors'
import { createDecisionMakerProvider } from '../decision-maker/providers'
import type { DecisionMakerProvider, DecisionResponse } from '../decision-maker/types'
import type { SystemOneLogger } from '../decision-maker/systemone-client'
import { assemblePrompt } from './assemble'
import {
  ENHANCEMENT_MOVES,
  type EnhancementMove,
  type MoveContext,
  type PromptIntent,
} from './moves'
import {
  asIntent,
  asTone,
  buildOptimizationQuestions,
  normalizeConstraints,
  renderState,
} from './questions'
import {
  optimizePromptRequestSchema,
  promptOptimizationResultSchema,
  type NormalizedOptimizePromptRequest,
  type OptimizePromptRequest,
  type PromptOptimizationResult,
} from './schema'
import { mechanicalChecks, runDecisionGates } from './validation'

export type OptimizationErrorCode = 'invalid_input' | 'provider_error' | 'validation_failed'

export class PromptOptimizationError extends Error {
  readonly code: OptimizationErrorCode
  readonly cause?: unknown

  constructor(code: OptimizationErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'PromptOptimizationError'
    this.code = code
    this.cause = cause
  }
}

export interface PromptOptimizerOptions {
  provider: DecisionMakerProvider
  /** Default validation mode; per-call override allowed. */
  validation?: ValidationMode
  /** Optional state-size override (clamped to provider capabilities). */
  maxStateChars?: number
  logger?: SystemOneLogger
}

const NoulGateThreshold = 0.5
// Vagueness scale: 0 very vague, 1 somewhat vague, 2 clear, 3 fully specified.
// The guardrail override fires only for the two "vague" levels.
const VaguenessGuardrailBelow = 2

export class PromptOptimizer {
  private readonly provider: DecisionMakerProvider
  private readonly validation: ValidationMode
  private readonly maxStateChars?: number
  private readonly logger: SystemOneLogger

  constructor(options: PromptOptimizerOptions) {
    this.provider = options.provider
    this.validation = options.validation ?? 'strict'
    this.maxStateChars = options.maxStateChars
    this.logger = options.logger ?? { debug: () => {} }
  }

  /** Stage 4+5: one batched decision call, returns validated decisions. */
  private async decide(
    request: NormalizedOptimizePromptRequest
  ): Promise<{ response: DecisionResponse; latencyMs: number; truncated: boolean; warnings: string[] }> {
    const warnings: string[] = []
    const caps = this.provider.capabilities
    const hardCap = Math.min(caps.maxStateChars, this.maxStateChars ?? caps.maxStateChars)
    let state = renderState(request)
    let truncated = false

    if (caps.effectiveStateChars && state.length > caps.effectiveStateChars) {
      warnings.push(
        `the state (${state.length} chars) exceeds the effective attention window of ${this.provider.id} (~${caps.effectiveStateChars} chars); decision quality may degrade`
      )
    }
    if (state.length > hardCap) {
      state = `${state.slice(0, hardCap - 32)}\n[...state truncated]`
      truncated = true
      warnings.push(`the state was truncated to ${hardCap} characters to fit ${this.provider.id} limits`)
    }

    const questions = buildOptimizationQuestions()
    const startedAt = Date.now()
    try {
      const response = await this.provider.decide({
        state,
        questions,
        signal: request.signal,
      })
      return { response, latencyMs: Date.now() - startedAt, truncated, warnings }
    } catch (error) {
      if (error instanceof DecisionMakerError) {
        throw new PromptOptimizationError('provider_error', error.message, error)
      }
      throw new PromptOptimizationError('provider_error', 'decision-maker call failed', error)
    }
  }

  /** Stage 5: map validated answers onto the move-selection context. */
  private buildMoveContext(
    request: NormalizedOptimizePromptRequest,
    response: DecisionResponse
  ): MoveContext {
    const intentAnswer = response.answers.intent
    const toneAnswer = response.answers.tone
    const vaguenessAnswer = response.answers.vagueness
    return {
      intent: asIntent(intentAnswer?.type === 'choice' ? intentAnswer.choice : undefined),
      tone: asTone(toneAnswer?.type === 'choice' ? toneAnswer.choice : undefined),
      vagueness: vaguenessAnswer?.type === 'score' ? vaguenessAnswer.score : 2,
      hasContext: Boolean(request.context?.trim()),
      hasConstraints: normalizeConstraints(request.constraints).length > 0,
      hasFormatConstraint: normalizeConstraints(request.constraints).some((c) =>
        /\b(format|output|structure|template|json|markdown|table|list)\b/i.test(c)
      ),
      targetModel: request.targetModel,
    }
  }

  /** Stage 5→6: which enhancement moves apply for these decisions. */
  private selectMoves(
    response: DecisionResponse,
    context: MoveContext
  ): { moves: EnhancementMove[]; warnings: string[] } {
    const warnings: string[] = []
    const moves: EnhancementMove[] = []

    for (const move of ENHANCEMENT_MOVES) {
      if (move.when && !move.when(context)) continue

      const gate = response.answers[move.gate]
      let applies = true
      if (gate?.type === 'noul') {
        applies = gate.noul >= NoulGateThreshold
      }

      // Vagueness override: a vague request always gets the assumptions-not-
      // inventions guardrail, even if the model voted against it.
      if (move.id === 'clarify-guardrail' && context.vagueness < VaguenessGuardrailBelow) {
        applies = true
      }
      if (applies) moves.push(move)
    }

    if (context.vagueness < VaguenessGuardrailBelow) {
      warnings.push(
        'the request is under-specified (vagueness ' +
          context.vagueness.toFixed(1) +
          '/3): consider adding scope, audience, or length to the original request'
      )
    }
    return { moves, warnings }
  }

  /** The full pipeline. */
  async optimize(input: OptimizePromptRequest): Promise<PromptOptimizationResult> {
    // Stage 1: normalize + validate input
    const parsed = optimizePromptRequestSchema.safeParse(input)
    if (!parsed.success) {
      throw new PromptOptimizationError(
        'invalid_input',
        `invalid optimize request: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
          .join('; ')}`
      )
    }
    const request = parsed.data
    const validationMode: ValidationMode = request.validation ?? this.validation
    const warnings: string[] = []
    const assumptions: string[] = []
    const changes: string[] = []

    // Stages 2-5: state composition, questions, decision call, validation
    const { response, latencyMs, warnings: decisionWarnings } = await this.decide(request)
    warnings.push(...decisionWarnings)
    const context = this.buildMoveContext(request, response)
    const { moves, warnings: moveWarnings } = this.selectMoves(response, context)
    warnings.push(...moveWarnings)

    // Stage 6a: assemble + mechanical guarantees
    let assembly = assemblePrompt({ request, context, moves, minimal: false })
    let mechanical = mechanicalChecks(request, assembly.prompt)
    if (!mechanical.ok) {
      warnings.push(...mechanical.problems.map((problem) => `mechanical check: ${problem}`))
      assembly = assemblePrompt({ request, context, moves, minimal: true })
      mechanical = mechanicalChecks(request, assembly.prompt)
      if (!mechanical.ok) {
        throw new PromptOptimizationError(
          'validation_failed',
          `failed to produce a prompt preserving the original request: ${mechanical.problems.join('; ')}`
        )
      }
    }

    // Stage 6b: decision gates (strict):
    //  - a reported intent change is fatal → minimal assembly
    //  - a reported scope/requirements change strips the assumption-bearing
    //    (invasive) enhancements but keeps structural guardrails
    if (validationMode === 'strict') {
      const gate = await runDecisionGates(this.provider, request, assembly.prompt)
      if (gate.detail?.startsWith('gates skipped')) {
        warnings.push(`validation gates were skipped: ${gate.detail}`)
      } else if (!gate.passed) {
        if (!gate.intentPreserved) {
          warnings.push(
            `validation gates flagged a possible intent change (${gate.detail ?? 'no detail'}); fell back to the minimal, non-invasive version`
          )
          assembly = assemblePrompt({ request, context, moves: [], minimal: true })
        } else {
          warnings.push(
            `validation gates flagged added scope or requirements (${gate.detail ?? 'no detail'}); removed the assumption-bearing enhancements`
          )
          const structural = moves.filter((move) => !move.invasive)
          assembly = assemblePrompt({ request, context, moves: structural, minimal: false })
        }
        mechanical = mechanicalChecks(request, assembly.prompt)
        if (!mechanical.ok) {
          throw new PromptOptimizationError(
            'validation_failed',
            `downgraded form failed to preserve the original request: ${mechanical.problems.join('; ')}`
          )
        }
      }
    }

    // Stage 8: change summary
    changes.push('Preserved the original request verbatim to protect intent.')
    if (normalizeConstraints(request.constraints).length > 0) {
      changes.push('Carried all caller constraints through verbatim.')
    }
    if (assembly.appliedMoveIds.length === 0) {
      changes.push('No additional enhancements were applied (minimal form).')
    }
    for (const move of moves) {
      if (assembly.appliedMoveIds.includes(move.id)) {
        changes.push(move.change(context))
        if (move.assumption) assumptions.push(move.assumption(context))
      }
    }

    const decisions: Record<string, string | number | boolean> = {
      intent: context.intent as PromptIntent,
      vagueness: Number(context.vagueness.toFixed(2)),
      tone: context.tone,
    }

    const result: PromptOptimizationResult = {
      optimized_prompt: assembly.prompt,
      changes,
      assumptions,
      warnings,
      meta: {
        provider: this.provider.id,
        model: response.model,
        validation: validationMode,
        questionCount: Object.keys(response.answers).length,
        decisionLatencyMs: latencyMs,
        decisions,
      },
    }

    // Final validation: the structured result must satisfy its schema
    const finalParse = promptOptimizationResultSchema.safeParse(result)
    if (!finalParse.success) {
      throw new PromptOptimizationError(
        'validation_failed',
        `structured optimization result failed schema validation: ${finalParse.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      )
    }
    this.logger.debug('optimization.ok', {
      provider: this.provider.id,
      model: response.model,
      latencyMs,
      appliedMoves: assembly.appliedMoveIds,
      warningCount: warnings.length,
      validation: validationMode,
    })
    return finalParse.data
  }

  /** Connectivity check for the configured provider. */
  async testConnection(): Promise<void> {
    try {
      await this.provider.testConnection()
    } catch (error) {
      if (error instanceof DecisionMakerError) {
        throw new PromptOptimizationError('provider_error', error.message, error)
      }
      throw error
    }
  }
}

/** Convenience: build an optimizer straight from environment configuration. */
export function createPromptOptimizer(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: { logger?: SystemOneLogger; config?: Partial<DecisionMakerConfig> } = {}
): PromptOptimizer {
  const config = loadDecisionMakerConfig(env)
  const provider = createDecisionMakerProvider(config, { logger: options.logger })
  return new PromptOptimizer({
    provider,
    validation: config.validation,
    maxStateChars: config.maxStateChars,
    logger: options.logger,
  })
}
