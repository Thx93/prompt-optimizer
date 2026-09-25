import { describe, it, expect, vi } from 'vitest'
import {
  PromptOptimizer,
  PromptOptimizationError,
  createPromptOptimizer,
} from '../../../src/services/optimization/pipeline'
import type {
  DecisionMakerProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
} from '../../../src/services/decision-maker/types'
import { DecisionMakerError } from '../../../src/services/decision-maker/errors'

/**
 * Fake decision-maker: answers questions from a canned map so the pipeline can
 * be exercised deterministically without any network.
 */
class FakeProvider implements DecisionMakerProvider {
  readonly id = 'fake'
  readonly displayName = 'Fake'
  readonly kind = 'jev' as const
  readonly capabilities = {
    parallelQuestions: true,
    maxStateChars: 96_000,
    effectiveStateChars: 110_000,
    maxQuestionsPerCall: 32,
    maxChoiceOptions: 255,
    scoreLevelRange: [2, 10] as [number, number],
  }

  lastRequest?: DecisionRequest
  callCount = 0

  constructor(
    private readonly answers: Record<string, DecisionResponse['answers'][string]>,
    private readonly options: { failWith?: Error; model?: string } = {}
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    this.callCount++
    this.lastRequest = request
    if (this.options.failWith) throw this.options.failWith
    const requested: Record<string, DecisionResponse['answers'][string]> = {}
    for (const question of request.questions) {
      const answer = this.answers[question.key]
      if (!answer) {
        throw new Error(`fake provider has no answer for ${question.key}`)
      }
      requested[question.key] = answer
    }
    return { model: this.options.model ?? 'fake-1', answers: requested }
  }

  async testConnection(): Promise<void> {}
}

const positiveAnswers = {
  intent: { type: 'choice' as const, choice: 'generation', confidence: 0.9 },
  vagueness: { type: 'score' as const, score: 2, confidence: 0.8 },
  add_role_framing: { type: 'noul' as const, noul: 0.9 },
  add_output_shape: { type: 'noul' as const, noul: 0.8 },
  add_process_steps: { type: 'noul' as const, noul: 0.7 },
  add_clarification_guardrail: { type: 'noul' as const, noul: 0.3 },
  add_safety_scope: { type: 'noul' as const, noul: 0.6 },
  tone: { type: 'choice' as const, choice: 'neutral', confidence: 0.7 },
  intent_preserved: { type: 'noul' as const, noul: 0.95 },
  no_new_requirements: { type: 'noul' as const, noul: 0.1 },
}

describe('PromptOptimizer', () => {
  it('produces an optimized prompt that preserves the original request verbatim', async () => {
    const provider = new FakeProvider(positiveAnswers)
    const optimizer = new PromptOptimizer({ provider })
    const result = await optimizer.optimize({
      prompt: 'Write a haiku about winter mornings.',
      constraints: ['Keep it under 20 words', 'Use JSON format'],
    })

    expect(result.optimized_prompt).toContain('Write a haiku about winter mornings.')
    expect(result.optimized_prompt).toContain('Keep it under 20 words')
    expect(result.optimized_prompt).toContain('Use JSON format')
    expect(result.changes[0]).toContain('Preserved the original request verbatim')
  })

  it('applies decision-gated enhancement moves and reports them as changes', async () => {
    const provider = new FakeProvider(positiveAnswers)
    const optimizer = new PromptOptimizer({ provider })
    const result = await optimizer.optimize({ prompt: 'Write a haiku about winter mornings.' })

    // role framing + tone + output shape + scope guardrail voted in;
    // process steps in; clarification guardrail voted out (0.3)
    expect(result.optimized_prompt).toContain('skilled writer') // role framing
    expect(result.optimized_prompt).toContain('Use a neutral and clear tone.') // tone
    expect(result.optimized_prompt).toContain('## Output') // output shape
    expect(result.optimized_prompt).not.toContain('state your assumptions') // voted out
    expect(result.assumptions.length).toBeGreaterThan(0)
    expect(result.meta?.decisions.intent).toBe('generation')
  })

  it('skips the output-shape move when a constraint already dictates format', async () => {
    const provider = new FakeProvider(positiveAnswers)
    const optimizer = new PromptOptimizer({ provider })
    const result = await optimizer.optimize({
      prompt: 'Summarize this article.',
      constraints: ['Respond as a JSON object with keys summary, keywords'],
    })
    expect(result.optimized_prompt).not.toContain('## Output')
  })

  it('forces the assumptions guardrail for vague requests and warns', async () => {
    const answers = {
      ...positiveAnswers,
      vagueness: { type: 'score' as const, score: 0.5, confidence: 0.8 },
      add_clarification_guardrail: { type: 'noul' as const, noul: 0.1 },
    }
    const provider = new FakeProvider(answers)
    const optimizer = new PromptOptimizer({ provider })
    const result = await optimizer.optimize({ prompt: 'do the thing' })

    expect(result.optimized_prompt).toContain('state your assumptions')
    expect(result.warnings.some((w) => w.includes('under-specified'))).toBe(true)
  })

  it('downgrades to the minimal form when the decision gates fail (strict mode)', async () => {
    const answers = {
      ...positiveAnswers,
      intent_preserved: { type: 'noul' as const, noul: 0.1 },
      no_new_requirements: { type: 'noul' as const, noul: 0.9 },
    }
    const provider = new FakeProvider(answers)
    const optimizer = new PromptOptimizer({ provider, validation: 'strict' })
    const result = await optimizer.optimize({ prompt: 'Write a haiku about winter mornings.' })

    // minimal: user material only, no enhancement fragments
    expect(result.optimized_prompt).toContain('Write a haiku about winter mornings.')
    expect(result.optimized_prompt).not.toContain('## Output')
    expect(result.changes.some((c) => c.includes('minimal form'))).toBe(true)
    expect(result.warnings.some((w) => w.includes('fell back to the minimal'))).toBe(true)
  })

  it('strips only the assumption-bearing moves when scope growth is flagged', async () => {
    const answers = {
      ...positiveAnswers,
      intent_preserved: { type: 'noul' as const, noul: 0.9 },
      no_new_requirements: { type: 'noul' as const, noul: 0.9 },
    }
    const provider = new FakeProvider(answers)
    const optimizer = new PromptOptimizer({ provider, validation: 'strict' })
    const result = await optimizer.optimize({ prompt: 'Write a haiku about winter mornings.' })

    // structural guardrails survive; framing/tone/output-shape are removed
    expect(result.optimized_prompt).toContain('Stay within the scope of this request')
    expect(result.optimized_prompt).not.toContain('skilled writer')
    expect(result.optimized_prompt).not.toContain('## Output')
    expect(result.warnings.some((w) => w.includes('removed the assumption-bearing'))).toBe(true)
    expect(result.changes.some((c) => c.includes('Framed the responder'))).toBe(false)
  })

  it('does not run decision gates in basic mode', async () => {
    const provider = new FakeProvider(positiveAnswers)
    const optimizer = new PromptOptimizer({ provider, validation: 'basic' })
    await optimizer.optimize({ prompt: 'Write a haiku about winter mornings.' })
    // one call for the optimization decisions, none for validation gates
    expect(provider.callCount).toBe(1)
    expect(provider.lastRequest?.questions.map((q: DecisionQuestion) => q.key)).not.toContain(
      'intent_preserved'
    )
  })

  it('rejects invalid input without calling the provider', async () => {
    const provider = new FakeProvider(positiveAnswers)
    const optimizer = new PromptOptimizer({ provider })
    const error = await optimizer
      .optimize({ prompt: '' })
      .catch((e) => e as PromptOptimizationError)
    expect(error).toBeInstanceOf(PromptOptimizationError)
    expect(error.code).toBe('invalid_input')
    expect(provider.callCount).toBe(0)
  })

  it('surfaces provider auth failures as provider_error', async () => {
    const provider = new FakeProvider(positiveAnswers, {
      failWith: new DecisionMakerError('auth', 'rejected the credentials', { provider: 'fake' }),
    })
    const optimizer = new PromptOptimizer({ provider })
    const error = await optimizer
      .optimize({ prompt: 'hello' })
      .catch((e) => e as PromptOptimizationError)
    expect(error.code).toBe('provider_error')
    expect(error.message).toContain('credentials')
  })

  it('surfaces provider timeouts as provider_error', async () => {
    const provider = new FakeProvider(positiveAnswers, {
      failWith: new DecisionMakerError('timeout', 'request timed out', { provider: 'fake' }),
    })
    const optimizer = new PromptOptimizer({ provider })
    const error = await optimizer
      .optimize({ prompt: 'hello' })
      .catch((e) => e as PromptOptimizationError)
    expect(error.code).toBe('provider_error')
    expect(error.message).toContain('timed out')
  })

  it('rejects malformed model output before it affects the pipeline', async () => {
    const provider = new FakeProvider(positiveAnswers, {
      failWith: new DecisionMakerError('malformed_response', 'failed schema validation', {
        provider: 'fake',
      }),
    })
    const optimizer = new PromptOptimizer({ provider })
    const error = await optimizer.optimize({ prompt: 'hello' }).catch((e) => e as PromptOptimizationError)
    expect(error.code).toBe('provider_error')
    expect(error.message).toContain('schema validation')
  })

  it('builds an optimizer from environment configuration', async () => {
    const responseBody = {
      model: 'jev-1.13.0',
      answers: {
        intent: { type: 'choice', choice: 'information', confidence: 1 },
        vagueness: { type: 'score', score: 3, confidence: 1 },
        add_role_framing: { type: 'noul', noul: 0.1 },
        add_output_shape: { type: 'noul', noul: 0.1 },
        add_process_steps: { type: 'noul', noul: 0.1 },
        add_clarification_guardrail: { type: 'noul', noul: 0.1 },
        add_safety_scope: { type: 'noul', noul: 0.1 },
        tone: { type: 'choice', choice: 'unspecified', confidence: 1 },
        intent_preserved: { type: 'noul', noul: 1 },
        no_new_requirements: { type: 'noul', noul: 0 },
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    )

    const optimizer = createPromptOptimizer({ PROMPT_OPTIMIZER_PROVIDER: 'jev', JEV_API_KEY: 'k' })
    const result = await optimizer.optimize({ prompt: 'What is photosynthesis?' })
    expect(result.meta?.provider).toBe('jev')
    expect(result.optimized_prompt).toContain('What is photosynthesis?')
    vi.unstubAllGlobals()
  })
})
