/**
 * Error hierarchy for the decision-maker layer.
 *
 * Errors never carry request content (state/questions) or credentials; they
 * carry machine-readable codes so callers can decide on retry/fallback without
 * parsing messages.
 */

export type DecisionMakerErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'invalid_request'
  | 'server'
  | 'malformed_response'
  | 'config'

export class DecisionMakerError extends Error {
  readonly code: DecisionMakerErrorCode
  readonly retryable: boolean
  readonly status?: number
  readonly provider?: string

  constructor(
    code: DecisionMakerErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number; provider?: string; cause?: unknown } = {}
  ) {
    super(message)
    if (options.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
    this.name = 'DecisionMakerError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.status = options.status
    this.provider = options.provider
  }
}

export class DecisionMakerConfigError extends DecisionMakerError {
  constructor(message: string) {
    super('config', message)
    this.name = 'DecisionMakerConfigError'
  }
}

/** Map an HTTP status to a typed, retry-aware error. */
export function errorFromStatus(
  status: number,
  provider: string,
  detail?: string
): DecisionMakerError {
  const suffix = detail ? `: ${detail}` : ''
  if (status === 401 || status === 403) {
    return new DecisionMakerError('auth', `${provider} rejected the credentials (HTTP ${status})${suffix}`, {
      retryable: false,
      status,
      provider,
    })
  }
  if (status === 429) {
    return new DecisionMakerError('rate_limit', `${provider} rate limited the request (HTTP 429)${suffix}`, {
      retryable: true,
      status,
      provider,
    })
  }
  if (status === 400 || status === 422) {
    return new DecisionMakerError(
      'invalid_request',
      `${provider} rejected the request as invalid (HTTP ${status})${suffix}`,
      { retryable: false, status, provider }
    )
  }
  if (status >= 500) {
    return new DecisionMakerError('server', `${provider} failed server-side (HTTP ${status})${suffix}`, {
      retryable: true,
      status,
      provider,
    })
  }
  return new DecisionMakerError('server', `${provider} returned HTTP ${status}${suffix}`, {
    retryable: false,
    status,
    provider,
  })
}
