import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { JEVProvider } from '../../../src/services/decision-maker/providers/jev'
import { LayaProvider } from '../../../src/services/decision-maker/providers/laya'
import { DecisionMakerError } from '../../../src/services/decision-maker/errors'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const jevConfig = {
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  apiKey: 'test-key',
  model: 'typesafe/jev',
  timeoutMs: 5_000,
  retries: 0,
}

const layaConfig = {
  baseUrl: 'http://127.0.0.1:8787',
  model: 'english',
  timeoutMs: 5_000,
  retries: 0,
}

const questions = [
  {
    key: 'is_vague',
    type: 'noul' as const,
    instructions: 'Is the request vague?',
    criteria: { true: 'vague', false: 'specific' },
  },
]

describe('JEVProvider', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('posts the documented SystemOne envelope to {base}/systemone', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { is_vague: { type: 'noul', noul: 0.84 } },
        usage: { input_tokens: 450, output_tokens: 78 },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new JEVProvider(jevConfig)
    const response = await provider.decide({ state: 'state text', questions })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.commandcode.ai/provider/v1/systemone')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('typesafe/jev')
    expect(body.state).toBe('state text')
    expect(body.questions.is_vague).toMatchObject({ type: 'noul', instructions: 'Is the request vague?' })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')

    expect(response.model).toBe('jev-1.13.0')
    expect(response.answers.is_vague).toEqual({ type: 'noul', noul: 0.84 })
    expect(response.usage?.input_tokens).toBe(450)
  })

  it('rejects requests over its capability limits before dispatch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const provider = new JEVProvider(jevConfig)

    const tooMany = Array.from({ length: 33 }, (_, i) => ({
      key: `q${i}`,
      type: 'noul' as const,
      instructions: 'x',
    }))
    const error = await provider
      .decide({ state: 's', questions: tooMany })
      .catch((e) => e as DecisionMakerError)
    expect(error.code).toBe('invalid_request')
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(provider.decide({ state: 's', questions: [] })).rejects.toBeInstanceOf(DecisionMakerError)
    await expect(
      provider.decide({ state: 'x'.repeat(97_000), questions })
    ).rejects.toBeInstanceOf(DecisionMakerError)
  })

  it('fails with malformed_response when an answer is missing or mistyped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { model: 'jev-1.13.0', answers: {} }))
    )
    const provider = new JEVProvider(jevConfig)
    const error = await provider
      .decide({ state: 's', questions })
      .catch((e) => e as DecisionMakerError)
    expect(error.code).toBe('malformed_response')
    expect(error.message).toContain('is_vague')
  })
})

describe('LayaProvider', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('posts to {base}/v1/systemone and canonicalizes Laya answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'laya-rl-agent',
        answers: {
          is_vague: {
            type: 'noul',
            noul: 0.1587,
            confidence: 0.8413,
            answer_confidence: 0.8413,
            action: { act_probability: 1.0 },
          },
        },
        usage: { input_tokens: 150, output_tokens: 0 },
        routing: { model: 'english' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new LayaProvider(layaConfig)
    const response = await provider.decide({ state: 'state text', questions })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8787/v1/systemone')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('english')
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()

    // calibrated answer_confidence wins over confidence
    expect(response.answers.is_vague).toEqual({ type: 'noul', noul: 0.1587, confidence: 0.8413 })
    expect(response.raw?.routing).toEqual({ model: 'english' })
    expect(response.usage?.output_tokens).toBe(0)
  })

  it('sends bearer auth when LAYA_API_KEY is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'laya-rl-agent', answers: { is_vague: { type: 'noul', noul: 0.5 } } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new LayaProvider({ ...layaConfig, apiKey: 'laya-key' })
    await provider.decide({ state: 's', questions })
    const init = fetchMock.mock.calls[0][1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer laya-key')
  })

  it('falls back to a known option when choice answers echo an unknown label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          model: 'laya-rl-agent',
          answers: {
            intent: { type: 'choice', choice: 'WRITING!', probabilities: { writing: 0.9 }, confidence: 0.9 },
          },
        })
      )
    )
    const provider = new LayaProvider(layaConfig)
    const response = await provider.decide({
      state: 's',
      questions: [
        {
          key: 'intent',
          type: 'choice',
          instructions: 'intent?',
          criteria: { writing: 'write', code: 'software' },
        },
      ],
    })
    expect((response.answers.intent as { choice: string }).choice).toBe('writing')
  })

  it('validates question bounds against its own capabilities', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const provider = new LayaProvider(layaConfig)

    const manyOptions = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`o${i}`, null]))
    const error = await provider
      .decide({
        state: 's',
        questions: [{ key: 'big', type: 'choice', instructions: 'x', criteria: manyOptions }],
      })
      .catch((e) => e as DecisionMakerError)
    expect(error.code).toBe('invalid_request')
    expect(fetchMock).not.toHaveBeenCalled()

    const scoreError = await provider
      .decide({ state: 's', questions: [{ key: 'sc', type: 'score', instructions: 'x', criteria: ['only'] }] })
      .catch((e) => e as DecisionMakerError)
    expect(scoreError.code).toBe('invalid_request')
  })
})
