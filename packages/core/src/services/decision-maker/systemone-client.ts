/**
 * Shared HTTP transport for Jev-compatible `/systemone` decision APIs.
 *
 * Used by both the JEV provider (Command Code provider API) and the Laya
 * provider (`laya-serve`). The request/response envelope is the same shape on
 * both surfaces; only the URL, auth and limits differ.
 *
 * Reliability policy:
 * - hard request timeout (default from config) via AbortController
 * - bounded retries (default 2) with exponential backoff + jitter, only for
 *   retryable failures (network, 429, 5xx); `Retry-After` is honoured
 * - response body size is capped before parsing
 * - every response is schema-validated before it reaches callers
 * - logs carry metadata only (provider, latency, status, question keys) —
 *   never credentials, state, question text, or answers
 */
import { DecisionMakerError, errorFromStatus } from './errors'
import { decisionResponseSchema, type ParsedDecisionResponse } from './schemas'

export interface SystemOneLogger {
  debug: (event: string, data: Record<string, unknown>) => void
}

export const noopLogger: SystemOneLogger = { debug: () => {} }

export interface SystemOneCallOptions {
  provider: string
  url: string
  apiKey?: string
  /** Header name used for the key. Defaults to Authorization: Bearer. */
  authHeader?: 'Authorization' | 'x-api-key'
  body: unknown
  timeoutMs: number
  retries: number
  retryBaseMs?: number
  maxResponseBytes?: number
  signal?: AbortSignal
  logger?: SystemOneLogger
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576 // 1 MiB
const DEFAULT_RETRY_BASE_MS = 400
const MAX_RETRY_BASE_MS = 8_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DecisionMakerError('timeout', 'request aborted during retry backoff', { retryable: false }))
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** Read a response body with a hard byte cap (protects against oversized output). */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const text = await res.text()
  if (text.length > maxBytes) {
    throw new DecisionMakerError(
      'malformed_response',
      `response body exceeds the ${maxBytes} byte cap`,
      { retryable: false }
    )
  }
  return text
}

/** Extract a short, content-free detail from an error envelope, if any. */
function safeErrorDetail(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error ?? parsed.detail ?? parsed.message
    if (typeof error === 'string') return error.slice(0, 200)
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string') return message.slice(0, 200)
    }
  } catch {
    /* non-JSON error body: ignore */
  }
  return undefined
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after')
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000)
  return undefined
}

/**
 * Perform one `/systemone` call with timeout, bounded retries and response
 * validation. Returns the parsed, schema-checked response envelope.
 */
export async function callSystemOne(options: SystemOneCallOptions): Promise<ParsedDecisionResponse> {
  const {
    provider,
    url,
    apiKey,
    authHeader = 'Authorization',
    body,
    timeoutMs,
    retries,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    signal,
    logger = noopLogger,
  } = options

  const maxAttempts = Math.max(1, Math.floor(retries) + 1)
  let lastError: DecisionMakerError | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startedAt = Date.now()
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) {
        throw new DecisionMakerError('timeout', 'request aborted before dispatch', { provider })
      }
      signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      }
      if (apiKey) {
        headers[authHeader] =
          authHeader === 'Authorization' ? `Bearer ${apiKey}` : apiKey
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const rawBody = await readBodyCapped(res, maxResponseBytes)

      if (!res.ok) {
        const detail = safeErrorDetail(rawBody)
        const error = errorFromStatus(res.status, provider, detail)
        logger.debug('systemone.http_error', {
          provider,
          status: res.status,
          code: error.code,
          retryable: error.retryable,
          attempt,
          latencyMs: Date.now() - startedAt,
        })
        if (error.retryable && attempt < maxAttempts - 1) {
          lastError = error
          const backoff = Math.min(retryBaseMs * 2 ** attempt, MAX_RETRY_BASE_MS)
          const wait = retryAfterMs(res) ?? backoff + Math.random() * backoff * 0.25
          await sleep(wait, signal)
          continue
        }
        throw error
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(rawBody)
      } catch (cause) {
        throw new DecisionMakerError('malformed_response', `${provider} returned non-JSON output`, {
          provider,
          retryable: false,
          cause,
        })
      }

      const parsed = decisionResponseSchema.safeParse(parsedJson)
      if (!parsed.success) {
        logger.debug('systemone.schema_error', {
          provider,
          issues: parsed.error.issues.length,
          attempt,
        })
        throw new DecisionMakerError(
          'malformed_response',
          `${provider} returned a response that failed schema validation`,
          { provider, retryable: false }
        )
      }

      logger.debug('systemone.ok', {
        provider,
        attempt,
        latencyMs: Date.now() - startedAt,
        status: res.status,
        questionCount: (body as { questions?: Record<string, unknown> }).questions
          ? Object.keys((body as { questions: Record<string, unknown> }).questions).length
          : 0,
      })
      return parsed.data
    } catch (cause) {
      if (cause instanceof DecisionMakerError) {
        if (!cause.retryable || attempt >= maxAttempts - 1) throw cause
        lastError = cause
        const backoff = Math.min(retryBaseMs * 2 ** attempt, MAX_RETRY_BASE_MS)
        await sleep(backoff + Math.random() * backoff * 0.25, signal)
        continue
      }
      // fetch/network/abort failures
      const aborted = controller.signal.aborted
      const error = new DecisionMakerError(
        aborted ? 'timeout' : 'network',
        aborted
          ? `${provider} request timed out after ${timeoutMs}ms`
          : `${provider} request failed: ${(cause as Error)?.message ?? 'network error'}`,
        { provider, retryable: !aborted, cause }
      )
      logger.debug('systemone.transport_error', {
        provider,
        code: error.code,
        attempt,
        latencyMs: Date.now() - startedAt,
      })
      if (!error.retryable || attempt >= maxAttempts - 1) throw error
      lastError = error
      const backoff = Math.min(retryBaseMs * 2 ** attempt, MAX_RETRY_BASE_MS)
      await sleep(backoff + Math.random() * backoff * 0.25, signal)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onOuterAbort)
    }
  }

  throw lastError ?? new DecisionMakerError('server', `${provider} request failed`, { provider })
}
