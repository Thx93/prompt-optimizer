import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { callSystemOne } from '../../../src/services/decision-maker/systemone-client'
import { DecisionMakerError } from '../../../src/services/decision-maker/errors'

const URL = 'http://127.0.0.1:9999/v1/systemone'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const validBody = {
  model: 'test-model',
  answers: { q1: { type: 'noul', noul: 0.75 } },
}

const baseOptions = {
  provider: 'test',
  url: URL,
  body: { state: 's', questions: { q1: { type: 'noul', instructions: 'i' } } },
  timeoutMs: 5_000,
  retries: 2,
  retryBaseMs: 1,
}

describe('callSystemOne', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('parses a valid response and sends bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validBody))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callSystemOne({ ...baseOptions, apiKey: 'secret-key' })

    expect(result.answers.q1.type).toBe('noul')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(URL)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key')
    expect(init.method).toBe('POST')
  })

  it('does not send an Authorization header without a key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validBody))
    vi.stubGlobal('fetch', fetchMock)

    await callSystemOne(baseOptions)

    const init = fetchMock.mock.calls[0][1]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('rejects a 401 without retrying', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: { message: 'bad key', type: 'authentication_error' } }))
    vi.stubGlobal('fetch', fetchMock)

    const error = await callSystemOne({ ...baseOptions, apiKey: 'wrong' }).catch((e) => e as DecisionMakerError)
    expect(error).toBeInstanceOf(DecisionMakerError)
    expect(error.code).toBe('auth')
    expect(error.retryable).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps 429 to a retryable error and retries with backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, validBody))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callSystemOne(baseOptions)
    expect(result.model).toBe('test-model')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries 5xx and gives up after the configured attempts', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(503, { error: { message: 'down' } }))
    vi.stubGlobal('fetch', fetchMock)

    const error = await callSystemOne({ ...baseOptions, retries: 2 }).catch((e) => e as DecisionMakerError)
    expect(error.code).toBe('server')
    expect(error.retryable).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 + 2 retries
  })

  it('rejects 400 as invalid_request without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: { message: 'bad body' } }))
    vi.stubGlobal('fetch', fetchMock)

    const error = await callSystemOne(baseOptions).catch((e) => e as DecisionMakerError)
    expect(error.code).toBe('invalid_request')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails on non-JSON output with malformed_response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const error = await callSystemOne(baseOptions).catch((e) => e as DecisionMakerError)
    expect(error.code).toBe('malformed_response')
  })

  it('fails when the response does not match the answer schema', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { model: 'm', answers: { q1: { type: 'noul', noul: 'yes' } } }))
    vi.stubGlobal('fetch', fetchMock)

    const error = await callSystemOne(baseOptions).catch((e) => e as DecisionMakerError)
    expect(error.code).toBe('malformed_response')
    expect(error.message).toContain('schema validation')
  })

  it('tolerates missing answer keys at transport level (providers check completeness)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { model: 'm', answers: { other: { type: 'noul', noul: 0.1 } } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(callSystemOne(baseOptions)).resolves.toMatchObject({ model: 'm' })
  })

  it('times out and reports timeout', async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await callSystemOne({ ...baseOptions, timeoutMs: 20, retries: 0 }).catch(
      (e) => e as DecisionMakerError
    )
    expect(error.code).toBe('timeout')
  })

  it('caps oversized response bodies', async () => {
    const big = { model: 'm', answers: { q1: { type: 'noul', noul: 0.5 } }, pad: 'x'.repeat(5000) }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, big))
    vi.stubGlobal('fetch', fetchMock)

    const error = await callSystemOne({ ...baseOptions, maxResponseBytes: 1024 }).catch(
      (e) => e as DecisionMakerError
    )
    expect(error.code).toBe('malformed_response')
  })

  it('never logs credentials', async () => {
    const events: Record<string, unknown>[] = []
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validBody))
    vi.stubGlobal('fetch', fetchMock)

    await callSystemOne({
      ...baseOptions,
      apiKey: 'super-secret',
      logger: { debug: (_event, data) => events.push(data) },
    })

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('super-secret')
  })
})
