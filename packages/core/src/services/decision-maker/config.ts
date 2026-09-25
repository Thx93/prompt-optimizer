/**
 * Environment-driven configuration for the decision-maker layer.
 *
 * Secrets are read EXCLUSIVELY from the environment (or from the embedding
 * application's credential store — see the harness plugin). Nothing in this
 * file may hard-code credentials, and the config object is safe to log: its
 * `toJSON()` masks key material.
 */
import { DecisionMakerConfigError } from './errors'

export type ProviderKind = 'jev' | 'laya'
export type ValidationMode = 'strict' | 'basic' | 'off'

export interface ProviderEndpointConfig {
  baseUrl: string
  /** Full endpoint override; defaults derive from baseUrl per provider. */
  endpoint?: string
  apiKey?: string
  model: string
  timeoutMs: number
}

export interface DecisionMakerConfig {
  provider: ProviderKind
  retries: number
  validation: ValidationMode
  /** Optional cap applied to the rendered state before dispatch. */
  maxStateChars?: number
  jev: ProviderEndpointConfig
  laya: ProviderEndpointConfig
}

const DEFAULTS = {
  provider: 'jev' as ProviderKind,
  retries: 2,
  validation: 'strict' as ValidationMode,
  jev: {
    // Command Code provider API (JEV lives at {base}/systemone).
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    model: 'typesafe/jev',
    timeoutMs: 15_000,
  },
  laya: {
    // Local laya-serve (Jev-compatible, {base}/v1/systemone).
    baseUrl: 'http://127.0.0.1:8787',
    model: 'english',
    timeoutMs: 60_000,
  },
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > 600_000) {
    throw new DecisionMakerConfigError(`${name} must be a positive integer (got ${JSON.stringify(raw)})`)
  }
  return value
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new DecisionMakerConfigError(`${name} must be an integer between 0 and 10 (got ${JSON.stringify(raw)})`)
  }
  return value
}

/**
 * Validate an operator-supplied base URL. Only http(s) URLs without embedded
 * credentials are accepted (SSRF/secret-hygiene hardening: this is operator
 * config, but a malformed or credential-bearing URL is always a mistake).
 */
export function validateBaseUrl(url: string, name: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DecisionMakerConfigError(`${name} must be a valid http(s) URL (got ${JSON.stringify(url)})`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DecisionMakerConfigError(`${name} must use http or https (got ${parsed.protocol})`)
  }
  if (parsed.username || parsed.password) {
    throw new DecisionMakerConfigError(`${name} must not embed credentials in the URL`)
  }
  return url.replace(/\/+$/, '')
}

function parseProviderKind(raw: string | undefined): ProviderKind {
  const value = (raw ?? DEFAULTS.provider).trim().toLowerCase()
  if (value === 'jev' || value === 'laya') return value
  throw new DecisionMakerConfigError(
    `PROMPT_OPTIMIZER_PROVIDER must be "jev" or "laya" (got ${JSON.stringify(raw)})`
  )
}

function parseValidationMode(raw: string | undefined): ValidationMode {
  const value = (raw ?? DEFAULTS.validation).trim().toLowerCase()
  if (value === 'strict' || value === 'basic' || value === 'off') return value
  throw new DecisionMakerConfigError(
    `PROMPT_OPTIMIZER_VALIDATION must be "strict", "basic" or "off" (got ${JSON.stringify(raw)})`
  )
}

export type EnvLike = Record<string, string | undefined>

/**
 * Build the decision-maker configuration from environment variables.
 *
 *   PROMPT_OPTIMIZER_PROVIDER      jev | laya            (default: jev)
 *   PROMPT_OPTIMIZER_RETRIES       0..10                 (default: 2)
 *   PROMPT_OPTIMIZER_VALIDATION    strict|basic|off      (default: strict)
 *   PROMPT_OPTIMIZER_TIMEOUT_MS    global timeout override
 *   PROMPT_OPTIMIZER_MAX_STATE_CHARS  optional state cap override
 *   JEV_API_KEY / COMMANDCODE_API_KEY / TYPESAFE_API_KEY (first set wins)
 *   JEV_BASE_URL                   (default: https://api.commandcode.ai/provider/v1)
 *   JEV_MODEL                      (default: typesafe/jev; TypeSafe native: jev-latest)
 *   JEV_ENDPOINT                   optional full endpoint override
 *   LAYA_BASE_URL                  (default: http://127.0.0.1:8787)
 *   LAYA_MODEL                     (default: english)
 *   LAYA_API_KEY                   optional (laya-serve auth, off by default)
 *   LAYA_ENDPOINT                  optional full endpoint override
 */
export function loadDecisionMakerConfig(env: EnvLike = process.env): DecisionMakerConfig {
  const provider = parseProviderKind(env.PROMPT_OPTIMIZER_PROVIDER)
  const globalTimeout = parsePositiveInt(env.PROMPT_OPTIMIZER_TIMEOUT_MS, 0, 'PROMPT_OPTIMIZER_TIMEOUT_MS')
  const maxStateChars = env.PROMPT_OPTIMIZER_MAX_STATE_CHARS
    ? parsePositiveInt(env.PROMPT_OPTIMIZER_MAX_STATE_CHARS, 0, 'PROMPT_OPTIMIZER_MAX_STATE_CHARS')
    : undefined

  const jevApiKey = env.JEV_API_KEY || env.COMMANDCODE_API_KEY || env.TYPESAFE_API_KEY || undefined
  const jev: ProviderEndpointConfig = {
    baseUrl: validateBaseUrl(env.JEV_BASE_URL || DEFAULTS.jev.baseUrl, 'JEV_BASE_URL'),
    model: (env.JEV_MODEL || DEFAULTS.jev.model).trim(),
    apiKey: jevApiKey,
    timeoutMs: globalTimeout || parsePositiveInt(env.JEV_TIMEOUT_MS, DEFAULTS.jev.timeoutMs, 'JEV_TIMEOUT_MS'),
  }
  if (env.JEV_ENDPOINT) jev.endpoint = env.JEV_ENDPOINT.trim()

  const laya: ProviderEndpointConfig = {
    baseUrl: validateBaseUrl(env.LAYA_BASE_URL || DEFAULTS.laya.baseUrl, 'LAYA_BASE_URL'),
    model: (env.LAYA_MODEL || DEFAULTS.laya.model).trim(),
    apiKey: env.LAYA_API_KEY || undefined,
    timeoutMs: globalTimeout || parsePositiveInt(env.LAYA_TIMEOUT_MS, DEFAULTS.laya.timeoutMs, 'LAYA_TIMEOUT_MS'),
  }
  if (env.LAYA_ENDPOINT) laya.endpoint = env.LAYA_ENDPOINT.trim()

  if (!jev.model) throw new DecisionMakerConfigError('JEV_MODEL must not be empty')
  if (!laya.model) throw new DecisionMakerConfigError('LAYA_MODEL must not be empty')

  return {
    provider,
    retries: parseNonNegativeInt(env.PROMPT_OPTIMIZER_RETRIES, DEFAULTS.retries, 'PROMPT_OPTIMIZER_RETRIES'),
    validation: parseValidationMode(env.PROMPT_OPTIMIZER_VALIDATION),
    maxStateChars,
    jev,
    laya,
  }
}

/** JSON-safe view of the config: never exposes key material. */
export function redactConfig(config: DecisionMakerConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    retries: config.retries,
    validation: config.validation,
    maxStateChars: config.maxStateChars ?? null,
    jev: {
      baseUrl: config.jev.baseUrl,
      model: config.jev.model,
      timeoutMs: config.jev.timeoutMs,
      apiKey: config.jev.apiKey ? '***' : null,
    },
    laya: {
      baseUrl: config.laya.baseUrl,
      model: config.laya.model,
      timeoutMs: config.laya.timeoutMs,
      apiKey: config.laya.apiKey ? '***' : null,
    },
  }
}
