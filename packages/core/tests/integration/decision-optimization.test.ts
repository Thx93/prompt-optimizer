/**
 * Integration tests: PromptOptimizer → provider abstraction → HTTP transport,
 * against mocked endpoints that answer with the REAL response shapes captured
 * from live smoke tests of both providers:
 * - JEV via Command Code `POST /provider/v1/systemone` (2026-09-25)
 * - Laya `laya-serve` `POST /v1/systemone` on this host (2026-09-25)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPromptOptimizer } from '../../src/services/optimization/pipeline'
import { PromptOptimizationError } from '../../src/services/optimization/pipeline'

const JEV_REAL_SHAPE = {
  model: 'typesafe/jev',
  answers: {
    intent: {
      type: 'choice',
      choice: 'generation',
      confidence: 1,
      probabilities: { generation: 1, information: 0, code: 0, analysis: 0 },
    },
    vagueness: {
      type: 'score',
      score: 1.02,
      confidence: 0.84,
      legend: { '0': 'very vague', '1': 'somewhat vague', '2': 'clear', '3': 'fully specified' },
      probabilities: { '0': 0.07, '1': 0.84, '2': 0.09, '3': 0 },
    },
    add_role_framing: { type: 'noul', noul: 0.71 },
    add_output_shape: { type: 'noul', noul: 0.62 },
    add_process_steps: { type: 'noul', noul: 0.55 },
    add_clarification_guardrail: { type: 'noul', noul: 0.88 },
    add_safety_scope: { type: 'noul', noul: 0.66 },
    tone: {
      type: 'choice',
      choice: 'unspecified',
      confidence: 1,
      probabilities: { unspecified: 1, neutral: 0, formal: 0 },
    },
    intent_preserved: { type: 'noul', noul: 0.97 },
    no_new_requirements: { type: 'noul', noul: 0.12 },
  },
  usage: { input_tokens: 450, output_tokens: 78 },
}

const LAYA_REAL_SHAPE = {
  model: 'laya-rl-agent',
  answers: {
    intent: {
      type: 'choice',
      choice: 'generation',
      probabilities: { generation: 0.9754, analysis: 0.0068, code: 0.0086, information: 0.0092 },
      confidence: 0.8973,
      answer_confidence: 0.9754,
      action: { act_probability: 1.0 },
    },
    vagueness: {
      type: 'score',
      score: 2.4918,
      legend: { '0': 'very vague', '1': 'somewhat vague', '2': 'clear', '3': 'fully specified' },
      probabilities: { '0': 0.0121, '1': 0.0822, '2': 0.3076, '3': 0.5981 },
      confidence: 0.33,
      answer_confidence: 0.5981,
      action: { act_probability: 1.0 },
    },
    add_role_framing: { type: 'noul', noul: 0.22, confidence: 0.78, answer_confidence: 0.78, action: { act_probability: 1 } },
    add_output_shape: { type: 'noul', noul: 0.71, confidence: 0.71, answer_confidence: 0.71, action: { act_probability: 1 } },
    add_process_steps: { type: 'noul', noul: 0.19, confidence: 0.81, answer_confidence: 0.81, action: { act_probability: 1 } },
    add_clarification_guardrail: { type: 'noul', noul: 0.31, confidence: 0.69, answer_confidence: 0.69, action: { act_probability: 1 } },
    add_safety_scope: { type: 'noul', noul: 0.64, confidence: 0.64, answer_confidence: 0.64, action: { act_probability: 1 } },
    tone: {
      type: 'choice',
      choice: 'unspecified',
      probabilities: { unspecified: 0.98, formal: 0.01, friendly: 0.01 },
      confidence: 0.98,
      answer_confidence: 0.98,
      action: { act_probability: 1 },
    },
    intent_preserved: { type: 'noul', noul: 0.93, confidence: 0.93, answer_confidence: 0.93, action: { act_probability: 1 } },
    no_new_requirements: { type: 'noul', noul: 0.08, confidence: 0.92, answer_confidence: 0.92, action: { act_probability: 1 } },
  },
  usage: { input_tokens: 150, output_tokens: 0 },
  routing: { model: 'english', repo: 'convaiinnovations/laya' },
}

function respondWith(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('optimizer → decision-maker integration (mocked endpoints)', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('runs end-to-end against a JEV-shaped endpoint', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => respondWith(JEV_REAL_SHAPE))
    vi.stubGlobal('fetch', fetchMock)

    const optimizer = createPromptOptimizer({ JEV_API_KEY: 'k', PROMPT_OPTIMIZER_PROVIDER: 'jev' })
    const result = await optimizer.optimize({
      prompt: 'Help me write an article about renewable energy.',
      context: 'For a company blog aimed at non-technical managers.',
      targetModel: 'gpt-5',
      constraints: ['Keep it under 800 words', 'Include a short intro'],
    })

    // provider routing
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.commandcode.ai/provider/v1/systemone')

    // intent preservation: original + every constraint verbatim
    expect(result.optimized_prompt).toContain('Help me write an article about renewable energy.')
    expect(result.optimized_prompt).toContain('Keep it under 800 words')
    expect(result.optimized_prompt).toContain('Include a short intro')

    // structured result
    expect(result.changes.length).toBeGreaterThan(1)
    expect(result.meta?.provider).toBe('jev')
    expect(result.meta?.model).toBe('typesafe/jev')
    expect(result.meta?.decisions).toMatchObject({ intent: 'generation' })

    // vagueness 1.02 → both the guardrail and the under-specification warning
    expect(result.optimized_prompt).toContain('state your assumptions')
    expect(result.warnings.some((w) => w.includes('under-specified'))).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2) // decisions + strict validation gates
  })

  it('runs end-to-end against a Laya-shaped endpoint', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => respondWith(LAYA_REAL_SHAPE))
    vi.stubGlobal('fetch', fetchMock)

    const optimizer = createPromptOptimizer({
      PROMPT_OPTIMIZER_PROVIDER: 'laya',
      LAYA_BASE_URL: 'http://127.0.0.1:8787',
    })
    const result = await optimizer.optimize({
      prompt: 'Help me write an article about renewable energy.',
      constraints: ['Keep it under 800 words'],
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8787/v1/systemone')
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()

    expect(result.optimized_prompt).toContain('Help me write an article about renewable energy.')
    expect(result.meta?.provider).toBe('laya')
    expect(result.meta?.model).toBe('laya-rl-agent')
    // answer_confidence-calibrated answers still drive the same pipeline
    expect(result.changes.some((c) => c.includes('output-structure'))).toBe(true)
  })

  it('surfaces authentication failures from the endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify({ error: { message: 'invalid key', type: 'authentication_error' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
    const optimizer = createPromptOptimizer({ JEV_API_KEY: 'wrong' })
    const error = await optimizer
      .optimize({ prompt: 'hello' })
      .catch((e) => e as PromptOptimizationError)
    expect(error.code).toBe('provider_error')
    expect(error.message).toContain('credentials')
  })

  it('preserves caller-supplied optimization instructions in the decision state', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => respondWith(JEV_REAL_SHAPE))
    vi.stubGlobal('fetch', fetchMock)

    const optimizer = createPromptOptimizer({ JEV_API_KEY: 'k' })
    await optimizer.optimize({
      prompt: 'Summarize the attached report.',
      instructions: 'The output will be read by auditors; favor precision over brevity.',
    })

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(requestBody.state).toContain('The output will be read by auditors; favor precision over brevity.')
  })
})
