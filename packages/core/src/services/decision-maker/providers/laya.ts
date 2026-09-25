/**
 * Laya provider — convaiinnovations/laya served locally with `laya-serve`
 * (`POST {base}/v1/systemone`), a Jev-compatible decision API.
 *
 * Verified against laya 0.3.20 on CPU (see docs/decision-maker.md):
 * - request: `{state?, model?, questions}`; questions `noul`/`choice`/`score`
 * - caps: 64 questions, 50,000 state chars, 2 MiB body (HTTP 413 beyond)
 * - answers add `answer_confidence` (calibrated) and `routing` metadata
 * - auth optional: `Authorization: Bearer <LAYA_API_KEY>` when configured
 * - the English checkpoint attends to ~512 tokens of state (multilingual /
 *   typed-decisions: 1,024): keep states compact for decision quality
 * - CPU inference is ~0.5s per question and serialized server-side
 */
import type { DecisionMakerCapabilities } from '../types'
import { SystemOneDecisionProvider, type SystemOneProviderOptions } from './base'

export interface LayaProviderConfig {
  /** laya-serve base URL; answers at `{baseUrl}/v1/systemone`. */
  baseUrl: string
  endpoint?: string
  apiKey?: string
  /** Checkpoint: `english` | `multilingual` | `typed-decisions`. */
  model: string
  timeoutMs: number
  retries: number
}

export class LayaProvider extends SystemOneDecisionProvider {
  readonly id = 'laya'
  readonly displayName = 'Laya (convaiinnovations/laya, local)'
  readonly kind = 'laya' as const

  readonly capabilities: DecisionMakerCapabilities = {
    // CPU cost grows ~linearly per question; the pipeline keeps question sets
    // small and treats calls as sequential.
    parallelQuestions: false,
    maxStateChars: 40_000,
    maxQuestionsPerCall: 64,
    // HF community notes report saturation beyond ~11 options; stay clear.
    maxChoiceOptions: 20,
    scoreLevelRange: [2, 10],
    // English checkpoint defaults to 512 tokens (~2k chars) of attention.
    effectiveStateChars: 2_000,
  }

  private readonly config: LayaProviderConfig

  constructor(config: LayaProviderConfig, options: SystemOneProviderOptions = {}) {
    super({ ...options, apiKey: config.apiKey ?? options.apiKey })
    this.config = config
  }

  protected endpoint(): string {
    return this.config.endpoint ?? `${this.config.baseUrl.replace(/\/+$/, '')}/v1/systemone`
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
