import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ChatPromptRewriter,
  ENGINEER_SYSTEM_PROMPT,
  buildRewriteMessage,
  extractJsonObject,
  parseEngineeredResult,
} from '../../../src/services/optimization/engineer'
import { DecisionMakerError } from '../../../src/services/decision-maker/errors'
import { optimizePromptRequestSchema } from '../../../src/services/optimization/schema'

function normalize(input: Record<string, unknown>) {
  return optimizePromptRequestSchema.parse(input)
}

const rewriterConfig = {
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4.1-flash',
  temperature: 0.5,
  maxTokens: 2_400,
  timeoutMs: 5_000,
  retries: 0,
}

const CHAT_RESPONSE = {
  model: 'deepseek/deepseek-v4.1-flash',
  choices: [
    {
      message: {
        content: JSON.stringify({
          optimized_prompt: 'You are a technical writer.\n\nWrite a report about AI.',
          changes: ['Added a role', 'Kept the task'],
          assumptions: ['Assumed a general audience'],
          warnings: [],
          clarifying_questions: [],
        }),
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 80 },
}

describe('engineer stage', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('ships a Prompt-Engineer style system prompt with the CO-STAR elements', () => {
    for (const needle of ['ROLE', 'CONTEXT', 'OBJECTIVE', 'REQUIREMENTS & CONSTRAINTS', 'AUDIENCE', 'TONE & STYLE', 'OUTPUT FORMAT', 'SUCCESS CRITERIA', 'CLARIFICATION BEHAVIOR']) {
      expect(ENGINEER_SYSTEM_PROMPT).toContain(needle)
    }
    expect(ENGINEER_SYSTEM_PROMPT).toContain('ONLY a JSON object')
  })

  it('builds a rewrite message carrying the prompt, constraints and hints', () => {
    const message = buildRewriteMessage(
      normalize({
        prompt: 'write a report',
        context: 'for managers',
        targetModel: 'gpt-5',
        constraints: ['under 800 words'],
      }),
      'task type: generation\nspecificity: 1.0/3'
    )
    expect(message).toContain('write a report')
    expect(message).toContain('for managers')
    expect(message).toContain('under 800 words')
    expect(message).toContain('task type: generation')
    expect(message).toContain('Binding constraints')
  })

  it('extracts JSON objects from plain, fenced and prose-wrapped output', () => {
    const value = { optimized_prompt: 'x' }
    expect(extractJsonObject(JSON.stringify(value))).toEqual(value)
    expect(extractJsonObject('```json\n' + JSON.stringify(value) + '\n```')).toEqual(value)
    expect(extractJsonObject('Sure! Here you go:\n' + JSON.stringify(value) + '\nHope that helps.')).toEqual(value)
    expect(() => extractJsonObject('not json at all')).toThrow(DecisionMakerError)
    expect(() => extractJsonObject('[1,2,3]')).toThrow(DecisionMakerError)
  })

  it('validates the structured rewrite result', () => {
    const result = parseEngineeredResult(
      {
        optimized_prompt: '  Engineed prompt  ',
        changes: ['a'],
        assumptions: [],
        warnings: ['w'],
        clarifying_questions: ['q1'],
      },
      'deepseek/deepseek-v4.1-flash',
      12
    )
    expect(result.optimized_prompt).toBe('Engineed prompt')
    expect(result.clarifying_questions).toEqual(['q1'])
    expect(result.model).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('rejects rewrite output without an optimized prompt', () => {
    expect(() => parseEngineeredResult({ changes: [] }, 'm', 1)).toThrow(DecisionMakerError)
  })

  it('rewrites through the chat endpoint and returns the structured result', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(CHAT_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const rewriter = new ChatPromptRewriter(rewriterConfig)
    const result = await rewriter.rewrite({ request: normalize({ prompt: 'write a report about ai' }) })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.commandcode.ai/provider/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('deepseek/deepseek-v4.1-flash')
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].content).toContain('write a report about ai')

    expect(result.optimized_prompt).toContain('Write a report about AI.')
    expect(result.changes).toContain('Added a role')
    expect(result.assumptions).toContain('Assumed a general audience')
    expect(result.model).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('rejects non-JSON rewrite output and malformed envelopes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: 'just prose' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
    const rewriter = new ChatPromptRewriter(rewriterConfig)
    const error = await rewriter
      .rewrite({ request: normalize({ prompt: 'x' }) })
      .catch((e) => e as DecisionMakerError)
    expect(error.code).toBe('malformed_response')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify({ model: 'm', choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
    const error2 = await rewriter
      .rewrite({ request: normalize({ prompt: 'x' }) })
      .catch((e) => e as DecisionMakerError)
    expect(error2.code).toBe('malformed_response')
  })

  it('surfaces authentication failures from the chat endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify({ error: { message: 'invalid key', type: 'authentication_error' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
    const rewriter = new ChatPromptRewriter(rewriterConfig)
    const error = await rewriter
      .rewrite({ request: normalize({ prompt: 'x' }) })
      .catch((e) => e as DecisionMakerError)
    expect(error.code).toBe('auth')
  })
})
