/**
 * JEV provider — TypeSafe AI's "System One" decision model, reached through
 * the Command Code provider API (`POST {base}/systemone`, model `typesafe/jev`)
 * or directly through TypeSafe's own API (`{base}/systemone`, model
 * `jev-latest` / `jev-1.13.0`).
 *
 * Documented limits (docs.typesafe.ai, commandcode.ai/docs/provider):
 * - 64k request budget; 32k tokens for `state` plus the longest question
 * - choice <= 255 options; score 2..10 levels
 * - questions are evaluated in parallel in one query: latency is flat in the
 *   number of questions (published 70ms-500ms end to end)
 * - auth: `Authorization: Bearer <key>`; no sampling parameters exist
 */
import type { DecisionMakerCapabilities } from '../types'
import { SystemOneDecisionProvider, type SystemOneProviderOptions } from './base'

export interface JEVProviderConfig {
  /** Provider API base; JEV answers at `{baseUrl}/systemone`. */
  baseUrl: string
  /** Full endpoint override (rarely needed). */
  endpoint?: string
  /** Command Code key (Bearer) or TypeSafe key. */
  apiKey?: string
  /** `typesafe/jev` on Command Code; `jev-latest`/`jev-1.13.0` on TypeSafe. */
  model: string
  timeoutMs: number
  retries: number
}

export class JEVProvider extends SystemOneDecisionProvider {
  readonly id = 'jev'
  readonly displayName = 'JEV (TypeSafe System One via Command Code)'
  readonly kind = 'jev' as const

  readonly capabilities: DecisionMakerCapabilities = {
    parallelQuestions: true,
    // ~96k chars keeps state + longest question inside the documented 32k
    // token budget with margin for non-English text.
    maxStateChars: 96_000,
    maxQuestionsPerCall: 32,
    maxChoiceOptions: 255,
    scoreLevelRange: [2, 10],
    // 32k tokens for state + longest question (Command Code publishes 32K).
    effectiveStateChars: 110_000,
  }

  private readonly config: JEVProviderConfig

  constructor(config: JEVProviderConfig, options: SystemOneProviderOptions = {}) {
    super({ ...options, apiKey: config.apiKey ?? options.apiKey })
    this.config = config
  }

  protected endpoint(): string {
    return this.config.endpoint ?? `${this.config.baseUrl.replace(/\/+$/, '')}/systemone`
  }

  protected envelopeFields(): Record<string, unknown> {
    return { model: this.config.model }
  }

  protected override defaultTimeoutMs(): number {
    return this.config.timeoutMs
  }

  protected override defaultRetries(): number {
    return this.config.retries
  }
}
