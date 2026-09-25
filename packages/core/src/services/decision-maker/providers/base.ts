/**
 * Shared SystemOne decision-provider implementation.
 *
 * Subclasses only describe how to reach their endpoint and how to fill the
 * request envelope; capability checks, dispatch, response validation and
 * answer canonicalization live here once.
 */
import type {
  DecisionMakerCapabilities,
  DecisionMakerProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
  DecisionAnswer,
} from '../types'
import { DecisionMakerError } from '../errors'
import { canonicalConfidence, type ParsedDecisionResponse } from '../schemas'
import { callSystemOne, noopLogger, type SystemOneLogger } from '../systemone-client'

export interface SystemOneProviderOptions {
  apiKey?: string
  logger?: SystemOneLogger
}

export abstract class SystemOneDecisionProvider implements DecisionMakerProvider {
  abstract readonly id: string
  abstract readonly displayName: string
  abstract readonly kind: 'jev' | 'laya'
  abstract readonly capabilities: DecisionMakerCapabilities

  protected readonly apiKey?: string
  protected readonly logger: SystemOneLogger

  constructor(options: SystemOneProviderOptions = {}) {
    this.apiKey = options.apiKey
    this.logger = options.logger ?? noopLogger
  }

  /** Full endpoint URL for this provider. */
  protected abstract endpoint(): string
  /** Provider-specific envelope fields (e.g. the `model` id). */
  protected abstract envelopeFields(): Record<string, unknown>

  /** Validate request size/shape against this provider's documented limits. */
  protected checkRequest(request: DecisionRequest): void {
    const caps = this.capabilities
    if (request.questions.length === 0) {
      throw new DecisionMakerError('invalid_request', 'at least one question is required', {
        provider: this.id,
      })
    }
    if (request.questions.length > caps.maxQuestionsPerCall) {
      throw new DecisionMakerError(
        'invalid_request',
        `${this.id} accepts at most ${caps.maxQuestionsPerCall} questions per call (got ${request.questions.length})`,
        { provider: this.id }
      )
    }
    if (request.state.length > caps.maxStateChars) {
      throw new DecisionMakerError(
        'invalid_request',
        `${this.id} accepts at most ${caps.maxStateChars} state characters (got ${request.state.length})`,
        { provider: this.id }
      )
    }
    const seen = new Set<string>()
    for (const question of request.questions) {
      if (seen.has(question.key)) {
        throw new DecisionMakerError('invalid_request', `duplicate question key ${JSON.stringify(question.key)}`, {
          provider: this.id,
        })
      }
      seen.add(question.key)
      if (question.type === 'choice') {
        const optionCount = Object.keys(question.criteria).length
        if (optionCount === 0) {
          throw new DecisionMakerError('invalid_request', `choice question ${question.key} needs options`, {
            provider: this.id,
          })
        }
        if (optionCount > caps.maxChoiceOptions) {
          throw new DecisionMakerError(
            'invalid_request',
            `choice question ${question.key} has ${optionCount} options; ${this.id} allows ${caps.maxChoiceOptions}`,
            { provider: this.id }
          )
        }
      }
      if (question.type === 'score') {
        const [min, max] = caps.scoreLevelRange
        if (question.criteria.length < min || question.criteria.length > max) {
          throw new DecisionMakerError(
            'invalid_request',
            `score question ${question.key} needs ${min}..${max} levels (got ${question.criteria.length})`,
            { provider: this.id }
          )
        }
      }
      if (question.instructions.trim().length === 0) {
        throw new DecisionMakerError('invalid_request', `question ${question.key} has empty instructions`, {
          provider: this.id,
        })
      }
    }
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    this.checkRequest(request)

    const body = {
      ...this.envelopeFields(),
      state: request.state,
      questions: Object.fromEntries(request.questions.map((q) => [q.key, toWireQuestion(q)])),
    }

    const parsed = await callSystemOne({
      provider: this.id,
      url: this.endpoint(),
      apiKey: this.apiKey,
      body,
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs(),
      retries: this.defaultRetries(),
      signal: request.signal,
      logger: this.logger,
    })

    return this.canonicalize(request, parsed)
  }

  /** Providers may override retry defaults. */
  protected defaultTimeoutMs(): number {
    return 30_000
  }

  protected defaultRetries(): number {
    return 2
  }

  /** Ensure every requested question came back with a usable answer. */
  protected canonicalize(request: DecisionRequest, parsed: ParsedDecisionResponse): DecisionResponse {
    const answers: Record<string, DecisionAnswer> = {}
    for (const question of request.questions) {
      const answer = parsed.answers[question.key]
      if (!answer) {
        throw new DecisionMakerError(
          'malformed_response',
          `${this.id} returned no answer for question ${JSON.stringify(question.key)}`,
          { provider: this.id }
        )
      }
      if (answer.type !== question.type) {
        throw new DecisionMakerError(
          'malformed_response',
          `${this.id} answered question ${JSON.stringify(question.key)} with type ${answer.type}, expected ${question.type}`,
          { provider: this.id }
        )
      }
      answers[question.key] = normalizeAnswer(question, answer)
    }

    const raw: Record<string, unknown> = {}
    if (parsed.routing) raw.routing = parsed.routing
    if (parsed.usage) raw.usage = parsed.usage

    return {
      model: parsed.model,
      answers,
      usage: parsed.usage,
      raw,
    }
  }

  async testConnection(): Promise<void> {
    await this.decide({
      state: 'connectivity check',
      questions: [
        {
          key: 'ok',
          type: 'noul',
          instructions: 'Is this state readable text?',
          criteria: { true: 'readable', false: 'not readable' },
        },
      ],
    })
  }
}

function toWireQuestion(question: DecisionQuestion): Record<string, unknown> {
  if (question.type === 'noul') {
    return {
      type: 'noul',
      instructions: question.instructions,
      ...(question.criteria ? { criteria: question.criteria } : {}),
    }
  }
  if (question.type === 'choice') {
    return { type: 'choice', instructions: question.instructions, criteria: question.criteria }
  }
  return { type: 'score', instructions: question.instructions, criteria: question.criteria }
}

/** Canonicalize one answer: calibrated confidence, bounded values. */
function normalizeAnswer(
  question: DecisionQuestion,
  answer: NonNullable<ParsedDecisionResponse['answers'][string]>
): DecisionAnswer {
  const confidence = canonicalConfidence(answer)
  if (answer.type === 'noul') {
    return {
      type: 'noul',
      noul: Math.min(1, Math.max(0, answer.noul)),
      ...(confidence !== undefined ? { confidence } : {}),
    }
  }
  if (answer.type === 'choice') {
    const known = question.type === 'choice' ? Object.keys(question.criteria) : []
    const choice = known.includes(answer.choice)
      ? answer.choice
      : known.length > 0
        ? closestOption(answer.choice, known)
        : answer.choice
    return {
      type: 'choice',
      choice,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
    }
  }
  return {
    type: 'score',
    score: answer.score,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(answer.legend ? { legend: answer.legend } : {}),
    ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
  }
}

/** Fall back to the first known option when the model echoes an unknown label. */
function closestOption(value: string, known: string[]): string {
  const normalized = value.trim().toLowerCase()
  const exact = known.find((option) => option.toLowerCase() === normalized)
  return exact ?? known[0]
}
