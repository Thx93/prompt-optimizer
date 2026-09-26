/**
 * OpenAI-compatible chat-completion transport for the generative
 * prompt-engineering stage.
 *
 * WHY THIS EXISTS: the decision models (JEV, Laya) never generate text — they
 * only answer typed questions. Producing a Prompt-Engineer-style REWRITTEN
 * prompt therefore needs a chat model. This transport is deliberately thin and
 * reuses the reliability policy of `systemone-client`: hard timeouts, bounded
 * retries, response-size caps, schema-validated JSON extraction and
 * metadata-only logging (never prompts, never credentials).
 */
import { DecisionMakerError, errorFromStatus } from './errors'
import { callSystemOne } from './systemone-client'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionRequest {
  /** Absolute endpoint, e.g. https://api.commandcode.ai/provider/v1/chat/completions */
  url: string
  apiKey?: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  timeoutMs: number
  retries: number
  signal?: AbortSignal
  logger?: { debug: (event: string, data: Record<string, unknown>) => void }
}

export interface ChatCompletionResult {
  text: string
  model: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

const DEFAULT_MAX_RESPONSE_BYTES = 2_097_152 // 2 MiB
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

/**
 * Perform one chat completion. Non-streaming by design (the rewrite is one
 * bounded JSON document); streaming is deliberately unsupported here.
 */
export async function callChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
  const {
    url,
    apiKey,
    model,
    messages,
    temperature,
    maxTokens,
    timeoutMs,
    retries,
    signal,
    logger = { debug: () => {} },
  } = request

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: temperature ?? 0.5,
  }
  if (maxTokens !== undefined) body.max_tokens = maxTokens

  const maxAttempts = Math.max(1, Math.floor(retries) + 1)
  let lastError: DecisionMakerError | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startedAt = Date.now()
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) {
        throw new DecisionMakerError('timeout', 'request aborted before dispatch', { provider: 'chat' })
      }
      signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const raw = await res.text()
      if (raw.length > DEFAULT_MAX_RESPONSE_BYTES) {
        throw new DecisionMakerError('malformed_response', 'chat response exceeds the size cap', {
          provider: 'chat',
          retryable: false,
        })
      }

      if (!res.ok) {
        let detail: string | undefined
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          const error = parsed.error
          if (typeof error === 'string') detail = error.slice(0, 200)
          else if (error && typeof error === 'object') {
            const message = (error as Record<string, unknown>).message
            if (typeof message === 'string') detail = message.slice(0, 200)
          }
        } catch {
          /* non-JSON error body */
        }
        const error = errorFromStatus(res.status, 'chat', detail)
        logger.debug('chat.http_error', {
          status: res.status,
          code: error.code,
          retryable: error.retryable,
          attempt,
          latencyMs: Date.now() - startedAt,
        })
        if (error.retryable && attempt < maxAttempts - 1) {
          lastError = error
          const backoff = Math.min(400 * 2 ** attempt, MAX_RETRY_BASE_MS)
          const retryAfter = Number(res.headers.get('retry-after'))
          const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 30_000) : backoff
          await sleep(wait, signal)
          continue
        }
        throw error
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (cause) {
        throw new DecisionMakerError('malformed_response', 'chat endpoint returned non-JSON output', {
          provider: 'chat',
          retryable: false,
          cause,
        })
      }

      const envelope = parsed as {
        model?: string
        choices?: Array<{ message?: { content?: unknown } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const content = envelope.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.length === 0) {
        throw new DecisionMakerError('malformed_response', 'chat response carried no message content', {
          provider: 'chat',
          retryable: false,
        })
      }

      logger.debug('chat.ok', {
        attempt,
        latencyMs: Date.now() - startedAt,
        status: res.status,
        contentChars: content.length,
      })
      return {
        text: content,
        model: typeof envelope.model === 'string' ? envelope.model : model,
        usage: {
          input_tokens: envelope.usage?.prompt_tokens,
          output_tokens: envelope.usage?.completion_tokens,
        },
      }
    } catch (cause) {
      if (cause instanceof DecisionMakerError) {
        if (!cause.retryable || attempt >= maxAttempts - 1) throw cause
        lastError = cause
        const backoff = Math.min(400 * 2 ** attempt, MAX_RETRY_BASE_MS)
        await sleep(backoff + Math.random() * backoff * 0.25, signal)
        continue
      }
      const aborted = controller.signal.aborted
      const error = new DecisionMakerError(
        aborted ? 'timeout' : 'network',
        aborted
          ? `chat request timed out after ${timeoutMs}ms`
          : `chat request failed: ${(cause as Error)?.message ?? 'network error'}`,
        { provider: 'chat', retryable: !aborted, cause }
      )
      logger.debug('chat.transport_error', {
        code: error.code,
        attempt,
        latencyMs: Date.now() - startedAt,
      })
      if (!error.retryable || attempt >= maxAttempts - 1) throw error
      lastError = error
      const backoff = Math.min(400 * 2 ** attempt, MAX_RETRY_BASE_MS)
      await sleep(backoff + Math.random() * backoff * 0.25, signal)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onOuterAbort)
    }
  }

  throw lastError ?? new DecisionMakerError('server', 'chat request failed', { provider: 'chat' })
}

export { callSystemOne }
