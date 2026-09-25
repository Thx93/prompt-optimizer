/**
 * Decision-maker provider abstraction.
 *
 * Both supported decision models — JEV (TypeSafe "System One" model, reachable
 * through the Command Code provider API) and Laya (convaiinnovations/laya, run
 * locally) — are NON-GENERATIVE decision models: they answer typed questions
 * (`noul` / `choice` / `score`) with calibrated probabilities and never emit
 * free text. The abstraction therefore models *decisions*, not chat turns.
 *
 * Provider-specific behaviour is confined to `providers/`; everything upstream
 * (the optimization pipeline) programs against {@link DecisionMakerProvider}.
 */

export type QuestionType = 'noul' | 'choice' | 'score'

/** Yes/no question. Answer is the calibrated probability of "yes". */
export interface NoulQuestion {
  key: string
  type: 'noul'
  /** The full question text. The key is not used for inference. */
  instructions: string
  /** Optional meaning of the poles. */
  criteria?: { true?: string; false?: string }
}

/** Single-choice question over a closed option set. */
export interface ChoiceQuestion {
  key: string
  type: 'choice'
  instructions: string
  /** option key -> description (or null). Max 255 options (JEV bound). */
  criteria: Record<string, string | null>
}

/** Rubric question. Answer is the expected value over level indices. */
export interface ScoreQuestion {
  key: string
  type: 'score'
  instructions: string
  /** Ordered level descriptions, lowest first. 2..10 levels (JEV bound). */
  criteria: string[]
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulAnswer {
  type: 'noul'
  /** Probability of "yes" in [0, 1]. */
  noul: number
  /** Confidence in [0, 1] when the provider reports one. */
  confidence?: number
}

export interface ChoiceAnswer {
  type: 'choice'
  choice: string
  confidence?: number
  probabilities?: Record<string, number>
}

export interface ScoreAnswer {
  type: 'score'
  /** Expected value over level indices; may fall between levels. */
  score: number
  confidence?: number
  legend?: Record<string, string>
  probabilities?: Record<string, number>
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export interface DecisionUsage {
  input_tokens?: number
  output_tokens?: number
}

export interface DecisionResponse {
  /** Model identifier echoed by the provider. */
  model: string
  /** One answer per requested question key. */
  answers: Record<string, DecisionAnswer>
  usage?: DecisionUsage
  /** Opaque provider extras (e.g. Laya routing info), preserved for observability. */
  raw?: Record<string, unknown>
}

export interface DecisionRequest {
  /** The state (prompt + objective + constraints) the questions are asked against. */
  state: string
  questions: DecisionQuestion[]
  timeoutMs?: number
  signal?: AbortSignal
}

export interface DecisionMakerCapabilities {
  /** JEV evaluates all questions in one parallel query; Laya costs ~per question. */
  parallelQuestions: boolean
  /** Hard cap on state characters (provider request limits). */
  maxStateChars: number
  /**
   * Soft cap for decision quality: the state window the model actually
   * attends to (JEV: 32k tokens; Laya english: ~512 tokens). The pipeline
   * warns when the rendered state exceeds this.
   */
  effectiveStateChars?: number
  maxQuestionsPerCall: number
  maxChoiceOptions: number
  scoreLevelRange: readonly [number, number]
}

/**
 * A prompt-enhancement decision-maker: evaluates typed questions against a
 * state and returns calibrated, structured answers.
 *
 * Note on the "structured output / temperature / max tokens / streaming"
 * knobs of generative providers: these decision models have no sampling
 * parameters and no streaming; their output is typed by construction. The
 * interface exposes only what the underlying APIs actually support.
 */
export interface DecisionMakerProvider {
  readonly id: string
  readonly displayName: string
  readonly kind: 'jev' | 'laya'
  readonly capabilities: DecisionMakerCapabilities
  /** Evaluate the questions against the state. Validates the response shape. */
  decide(request: DecisionRequest): Promise<DecisionResponse>
  /** Cheap connectivity check (no state, one trivial question). */
  testConnection(): Promise<void>
}
