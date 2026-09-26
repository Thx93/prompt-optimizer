/**
 * PromptOptimizer — the prompt-enhancement pipeline.
 *
 * TWO MODES, one structured result (`PromptOptimizationResult`):
 *
 * - `engineer` (default): a generative Prompt-Engineer rewrite. The chat model
 *   (DeepSeek V4.1 Flash by default) rewrites the request into a complete,
 *   engineered prompt in the style of the popular "Prompt Engineer" GPT,
 *   while the decision layer (JEV or Laya) works in partnership:
 *     · BEFORE: calibrated classification (intent / vagueness / tone) steers
 *       the rewrite (optional, `decisionHints`)
 *     · AFTER: calibrated gates verify the rewrite preserves the task and
 *       scope; a flagged rewrite degrades to the deterministic fallback
 *
 * - `compose`: the decision-driven assembly (no generative model needed) —
 *   deterministic enhancement fragments selected by the decision layer. Also
 *   the automatic fallback when the generative endpoint is unavailable.
 *
 * Stages (kept explicit for auditability):
 *   1. Normalize & validate the input request
 *   2. Compose the requirements/objective state
 *   3. Decision-layer classification (partnership input)
 *   4. Generative rewrite (engineer) or decision questions + assembly (compose)
 *   5. Parse + validate the structured result (zod)
 *   6. Validate intent/scope (mechanical guarantees + decision gates)
 *   7. Emit the final enhanced prompt
 *   8. Emit the change/assumption/warning/clarification summary
 */
import {
  loadDecisionMakerConfig,
  type DecisionMakerConfig,
  type OptimizationMode,
  type ValidationMode,
} from '../decision-maker/config'
import { DecisionMakerError } from '../decision-maker/errors'
import { createDecisionMakerProvider } from '../decision-maker/providers'
import type { DecisionMakerProvider, DecisionResponse } from '../decision-maker/types'
import type { SystemOneLogger } from '../decision-maker/systemone-client'
import { assemblePrompt } from './assemble'
import {
  ChatPromptRewriter,
  type EngineeredPromptResult,
  type PromptRewriter,
} from './engineer'
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
  /** Decision layer (JEV/Laya): classification, steering and calibrated gates. */
  provider: DecisionMakerProvider
  /** Generative writer; when absent, the pipeline runs in compose mode. */
  rewriter?: PromptRewriter
  /** engineer (default when a rewriter is present) or compose. */
  mode?: OptimizationMode
  /** Feed decision-layer classification into the rewrite prompt. */
  decisionHints?: boolean
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
  private readonly rewriter?: PromptRewriter
  private readonly mode: OptimizationMode
  private readonly decisionHints: boolean
  private readonly validation: ValidationMode
  private readonly maxStateChars?: number
  private readonly logger: SystemOneLogger

  constructor(options: PromptOptimizerOptions) {
    this.provider = options.provider
    this.rewriter = options.rewriter
    this.mode = options.mode ?? (options.rewriter ? 'engineer' : 'compose')
    this.decisionHints = options.decisionHints ?? true
    this.validation = options.validation ?? 'strict'
    this.maxStateChars = options.maxStateChars
    this.logger = options.logger ?? { debug: () => {} }
  }

  /** Stage 4+5 (compose path): one batched decision call, validated. */
  private async decide(
    request: NormalizedOptimizePromptRequest,
    questionKeys?: string[]
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

    const questions = questionKeys
      ? buildOptimizationQuestions().filter((question) => questionKeys.includes(question.key))
      : buildOptimizationQuestions()
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

  /** Stage 5 (compose path): map validated answers onto move selection. */
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

  /** Stage 5→6 (compose path): which enhancement moves apply. */
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

  /**
   * Stage 3: compact partnership classification from the decision layer.
   * Non-fatal: when the decision maker is unavailable the rewrite proceeds
   * unsteered (recorded as a warning).
   */
  private async collectHints(
    request: NormalizedOptimizePromptRequest
  ): Promise<{ hints?: string; decisions: Record<string, string | number | boolean>; latencyMs: number; warnings: string[] }> {
    const decisions: Record<string, string | number | boolean> = {}
    const warnings: string[] = []
    const startedAt = Date.now()
    try {
      const { response } = await this.decide(request, ['intent', 'vagueness', 'tone'])
      const context = this.buildMoveContext(request, response)
      decisions.intent = context.intent as PromptIntent
      decisions.vagueness = Number(context.vagueness.toFixed(2))
      decisions.tone = context.tone
      const lines = [
        `task type: ${context.intent}`,
        `specificity: ${context.vagueness.toFixed(1)}/3 (0 = very vague, 3 = fully specified)`,
        `implied tone: ${context.tone}`,
      ]
      if (context.vagueness < VaguenessGuardrailBelow) {
        lines.push('the request is under-specified: surface assumptions explicitly instead of inventing details')
      }
      return {
        hints: lines.join('\n'),
        decisions,
        latencyMs: Date.now() - startedAt,
        warnings,
      }
    } catch (error) {
      warnings.push(
        `decision-layer hints unavailable (${error instanceof PromptOptimizationError ? error.message : 'classification failed'}); the rewrite proceeded unsteered`
      )
      return { decisions, latencyMs: Date.now() - startedAt, warnings }
    }
  }

  /** The generative Prompt-Engineer path (with compose fallback at the caller). */
  private async engineerOptimize(
    request: NormalizedOptimizePromptRequest,
    validationMode: ValidationMode
  ): Promise<PromptOptimizationResult> {
    const rewriter = this.rewriter
    if (!rewriter) throw new PromptOptimizationError('provider_error', 'no rewrite model configured')

    const warnings: string[] = []
    const decisions: Record<string, string | number | boolean> = {}
    let decisionLatencyMs = 0
    let questionCount = 0

    // Stage 3 (partnership): decision-layer classification steers the rewrite.
    let hints: string | undefined
    if (this.decisionHints) {
      const hintResult = await this.collectHints(request)
      hints = hintResult.hints
      decisionLatencyMs += hintResult.latencyMs
      questionCount += this.decisionHints ? 3 : 0
      Object.assign(decisions, hintResult.decisions)
      warnings.push(...hintResult.warnings)
    }

    // Stages 4-5: generative rewrite → structured, schema-validated result.
    let engineered: EngineeredPromptResult
    try {
      engineered = await rewriter.rewrite({ request, hints, signal: request.signal })
    } catch (error) {
      const code = error instanceof DecisionMakerError ? error.code : 'unexpected_error'
      throw new PromptOptimizationError(
        'provider_error',
        `generative rewrite failed (${code}): ${error instanceof Error ? error.message : 'unknown error'}`,
        error
      )
    }

    warnings.push(...engineered.warnings)
    if (engineered.optimized_prompt.trim() === request.prompt.trim()) {
      warnings.push('the rewrite returned the input unchanged')
    }

    // Stage 6: calibrated gates over the rewrite (strict). Policy for the
    // engineer mode: only a flagged TASK change is fatal (the rewrite is
    // expected to add role/audience/format framing); added scope is disclosed
    // as a warning — the assumptions list already names every addition.
    if (validationMode === 'strict') {
      const gate = await runDecisionGates(this.provider, request, engineered.optimized_prompt)
      questionCount += 2
      if (gate.detail?.startsWith('gates skipped')) {
        warnings.push(`validation gates were skipped: ${gate.detail}`)
      } else if (!gate.intentPreserved) {
        throw new PromptOptimizationError(
          'validation_failed',
          `decision gates rejected the rewrite (${gate.detail ?? 'no detail'})`
        )
      } else if (!gate.noNewRequirements) {
        warnings.push(
          `the rewrite adds framing beyond the original request (${gate.detail ?? 'no detail'}); every addition is listed in the assumptions`
        )
      }
    }

    const result: PromptOptimizationResult = {
      optimized_prompt: engineered.optimized_prompt,
      changes: engineered.changes,
      assumptions: engineered.assumptions,
      warnings,
      ...(engineered.clarifying_questions.length > 0
        ? { clarifying_questions: engineered.clarifying_questions }
        : {}),
      meta: {
        provider: rewriter.id,
        model: engineered.model,
        validation: validationMode,
        mode: 'engineer',
        questionCount,
        ...(decisionLatencyMs > 0 ? { decisionLatencyMs } : {}),
        ...(Object.keys(decisions).length > 0 ? { decisions } : {}),
      },
    }

    const finalParse = promptOptimizationResultSchema.safeParse(result)
    if (!finalParse.success) {
      throw new PromptOptimizationError(
        'validation_failed',
        `structured optimization result failed schema validation: ${finalParse.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      )
    }
    this.logger.debug('optimization.engineer.ok', {
      rewriter: rewriter.id,
      model: engineered.model,
      latencyMs: engineered.latencyMs,
      warningCount: warnings.length,
      validation: validationMode,
    })
    return finalParse.data
  }

  /** The deterministic decision-driven composition path (also the fallback). */
  private async composeOptimize(
    request: NormalizedOptimizePromptRequest,
    validationMode: ValidationMode
  ): Promise<PromptOptimizationResult> {
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
        mode: 'compose',
        questionCount: Object.keys(response.answers).length,
        decisionLatencyMs: latencyMs,
        decisions,
      },
    }

    const finalParse = promptOptimizationResultSchema.safeParse(result)
    if (!finalParse.success) {
      throw new PromptOptimizationError(
        'validation_failed',
        `structured optimization result failed schema validation: ${finalParse.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      )
    }
    this.logger.debug('optimization.compose.ok', {
      provider: this.provider.id,
      model: response.model,
      latencyMs,
      appliedMoves: assembly.appliedMoveIds,
      warningCount: warnings.length,
      validation: validationMode,
    })
    return finalParse.data
  }

  /** The full pipeline: engineer mode with deterministic fallback. */
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

    if (this.mode === 'engineer' && this.rewriter) {
      try {
        return await this.engineerOptimize(request, validationMode)
      } catch (error) {
        // Gates rejecting the rewrite are not transport failures: still fall
        // back, but keep the reason visible in the result warnings.
        const reason = error instanceof Error ? error.message : 'unknown error'
        const fallback = await this.composeOptimize(request, validationMode)
        fallback.warnings = [
          `generative rewrite was not used (${reason}); deterministic composition fallback applied`,
          ...fallback.warnings,
        ]
        this.logger.debug('optimization.fallback', { reason })
        return fallback
      }
    }

    return this.composeOptimize(request, validationMode)
  }

  /** Connectivity check for the configured decision provider. */
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
  const rewriter =
    config.mode === 'engineer'
      ? new ChatPromptRewriter(
          {
            baseUrl: config.rewrite.baseUrl,
            endpoint: config.rewrite.endpoint,
            apiKey: config.rewrite.apiKey,
            model: config.rewrite.model,
            temperature: config.rewrite.temperature,
            maxTokens: config.rewrite.maxTokens,
            timeoutMs: config.rewrite.timeoutMs,
            retries: config.retries,
          },
          options.logger
        )
      : undefined
  return new PromptOptimizer({
    provider,
    rewriter,
    mode: config.mode,
    decisionHints: config.decisionHints,
    validation: config.validation,
    maxStateChars: config.maxStateChars,
    logger: options.logger,
  })
}
