/**
 * Generative "Prompt Engineer" stage.
 *
 * This stage reproduces the working style of the popular ChatGPT custom GPT
 * "Prompt Engineer" by upscaile.com (chatgpt.com/g/g-5XtVuRE8Y):
 *   "Generate superior ChatGPT prompts or improve your existing prompts.
 *    Become a pro prompt engineer, by learning and applying best prompt
 *    practices."  (modes: build from scratch / improve my prompt)
 * combined with the structuring frameworks that research backs:
 *   - CO-STAR (GovTech Singapore: Context, Objective, Style, Tone, Audience,
 *     Response) — https://www.tech.gov.sg/technews/mastering-the-art-of-prompt-engineering-with-empower/
 *   - OpenAI's prompt-engineering tactics (role/context, delimiters, explicit
 *     output format, few-shot examples, step guidance, testable criteria)
 *     — https://developers.openai.com/api/docs/guides/prompt-engineering
 *
 * PROVENANCE NOTE (verified, see docs/developer/prompt-engineer-research.md):
 * the exact instruction set of that GPT is not leaked or archived anywhere
 * (checked GitHub code search, linexjlin/GPTs, four system-prompt leak
 * collections, and the Wayback Machine). This prompt is therefore a BEHAVIORAL
 * reconstruction from its public description and conversation starters, backed
 * by the best publicly published templates in its class: Kurt Elster's
 * "Promptimizer" system prompt (ethercycle.com), mshumer/gpt-prompt-engineer's
 * generator+judge prompts (9.6k stars), and the leaked "Prompt For Me" /
 * "Mega-Prompt" GPT skeletons. Techniques follow CO-STAR, RACE/RTF, APE and
 * OpenAI's prompt-engineering guide.
 *
 * The stage produces the structured result the pipeline promises
 * (optimized_prompt / changes / assumptions / warnings / clarifying_questions)
 * as STRICT JSON from a chat model, schema-validated before it can affect
 * anything. The decision models (JEV/Laya) never generate text, so they cannot
 * serve this role — they remain the calibrated decision/validation layer
 * around it.
 */
import { callChatCompletion } from '../decision-maker/chat-client'
import { DecisionMakerError } from '../decision-maker/errors'
import { promptOptimizationResultSchema, type NormalizedOptimizePromptRequest } from './schema'

export interface RewriteRequest {
  request: NormalizedOptimizePromptRequest
  /** Optional calibrated hints from the decision layer. */
  hints?: string
  signal?: AbortSignal
}

export interface EngineeredPromptResult {
  optimized_prompt: string
  changes: string[]
  assumptions: string[]
  warnings: string[]
  clarifying_questions: string[]
  /** The chat model that produced the rewrite. */
  model: string
  latencyMs: number
}

export interface PromptRewriter {
  readonly id: string
  readonly model: string
  rewrite(request: RewriteRequest): Promise<EngineeredPromptResult>
}

export const ENGINEER_SYSTEM_PROMPT = `You are "Prompt Engineer" — an elite prompt engineer. Your job is to generate superior prompts or improve existing prompts, applying best prompt-engineering practices and teaching the user what you changed and why.

You rewrite the user's input into ONE complete, standalone, ready-to-paste prompt for a target AI assistant. You have two modes:
- IMPROVE: the input is an existing prompt — strengthen it while preserving exactly what it asks for.
- BUILD: the input is a rough idea or request — design the full prompt from scratch around it.

METHOD — every engineered prompt is self-contained and structured with the elements that actually matter (use only the ones that fit the task):
1. ROLE — who the AI is (an expert persona matched to the task).
2. CONTEXT — the background the AI needs: situation, subject, source material placeholders.
3. OBJECTIVE — the task stated as clear, actionable instructions (imperative voice; one primary task; split complex work into ordered steps).
4. REQUIREMENTS & CONSTRAINTS — must-haves, boundaries, things to avoid. The user's own constraints are binding and must be preserved faithfully.
5. AUDIENCE — who the output is for, and the reading level.
6. TONE & STYLE — voice and writing style (e.g. CO-STAR's Style + Tone).
7. OUTPUT FORMAT — the exact shape of the answer: structure, sections, length, language, and where useful a short schema/template.
8. EXAMPLES — a short few-shot example or mini-template when it materially improves consistency (never invent facts inside examples); use XML or Markdown section boundaries so instructions, context, examples and quoted input data stay cleanly separated.
9. SUCCESS CRITERIA — what a good answer achieves, and how the AI should self-check before answering.
10. CLARIFICATION BEHAVIOR — whether the AI should ask before proceeding or state assumptions and continue.

BEST PRACTICES: delimiters to separate quoted material from instructions; explicit length limits; "if X then Y" handling of edge cases; no vague words where a concrete standard exists; no redundant filler; the prompt must work when pasted into a fresh chat with zero extra context.

NON-NEGOTIABLE RULES:
- Preserve the user's intent. Never change what is being asked, the subject, or the goal.
- Never silently introduce requirements the user did not ask for. If an improvement needs an added assumption (an audience, a tone, a length), state it in "assumptions" and make it visible in the prompt as an assumption the responder may override.
- Keep the user's own wording where it is already strong; rewrite only what benefits from it. Do not inflate length for its own sake.
- The user's constraints (length, format, language, style) always win over your preferences.
- The optimized prompt must be the prompt itself — no commentary, no preamble, no "here is your prompt", no code fences around it.

RESPONSE FORMAT — respond with ONLY a JSON object (no markdown fences, no prose outside JSON):
{
  "optimized_prompt": "the complete engineered prompt",
  "changes": ["what you changed and why, in one line each"],
  "assumptions": ["assumptions you surfaced (audience, tone, length, ...) — empty if none"],
  "warnings": ["risks or caveats — empty if none"],
  "clarifying_questions": ["only if essential information is missing and cannot be responsibly assumed — otherwise empty"]
}`

/** Build the user message for the rewrite call. */
export function buildRewriteMessage(request: NormalizedOptimizePromptRequest, hints?: string): string {
  const parts: string[] = []
  parts.push(`[Improve or build this into an engineered prompt]\n${request.prompt.trim()}`)
  if (request.context?.trim()) parts.push(`[Context from the user]\n${request.context.trim()}`)
  if (request.targetModel?.trim()) parts.push(`[Target model]\n${request.targetModel.trim()}`)
  const constraints = request.constraints
    ? Array.isArray(request.constraints)
      ? request.constraints
      : request.constraints.split(/\r?\n+/).map((c) => c.trim()).filter(Boolean)
    : []
  if (constraints.length > 0) {
    parts.push(`[Binding constraints — preserve these faithfully]\n${constraints.map((c) => `- ${c}`).join('\n')}`)
  }
  if (request.instructions?.trim()) {
    parts.push(`[Extra engineering instructions]\n${request.instructions.trim()}`)
  }
  if (hints?.trim()) {
    parts.push(`[Calibrated hints from the decision layer — for your judgment, do not mention them]\n${hints.trim()}`)
  }
  return parts.join('\n\n')
}

/**
 * Extract a JSON object from model output: tolerates code fences and stray
 * prose, but never executes or interprets anything the model produced.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const attempts = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) attempts.unshift(fenced[1].trim())
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    attempts.push(trimmed.slice(firstBrace, lastBrace + 1))
  }
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* try the next candidate */
    }
  }
  throw new DecisionMakerError('malformed_response', 'rewrite output was not a JSON object', {
    provider: 'chat',
    retryable: false,
  })
}

function cleanStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 2_000))
    .slice(0, maxItems)
}

/** Validate the engineered result against the pipeline's result schema. */
export function parseEngineeredResult(
  raw: unknown,
  model: string,
  latencyMs: number
): EngineeredPromptResult {
  const record = raw as Record<string, unknown>
  const optimized =
    typeof record.optimized_prompt === 'string' ? record.optimized_prompt.trim() : ''
  if (optimized.length === 0) {
    throw new DecisionMakerError('malformed_response', 'rewrite output has no optimized_prompt', {
      provider: 'chat',
      retryable: false,
    })
  }
  const result = {
    optimized_prompt: optimized,
    changes: cleanStringList(record.changes, 20),
    assumptions: cleanStringList(record.assumptions, 20),
    warnings: cleanStringList(record.warnings, 20),
    clarifying_questions: cleanStringList(record.clarifying_questions, 5),
    model,
    latencyMs,
  }
  // The structured result must satisfy the pipeline contract before use.
  promptOptimizationResultSchema.parse({
    optimized_prompt: result.optimized_prompt,
    changes: result.changes,
    assumptions: result.assumptions,
    warnings: result.warnings,
  })
  return result
}

export interface ChatRewriterConfig {
  baseUrl: string
  endpoint?: string
  apiKey?: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  retries: number
}

/** The generative rewriter: one bounded, schema-validated chat completion. */
export class ChatPromptRewriter implements PromptRewriter {
  readonly id = 'prompt-engineer'
  readonly model: string

  private readonly config: ChatRewriterConfig
  private readonly logger: { debug: (event: string, data: Record<string, unknown>) => void }

  constructor(
    config: ChatRewriterConfig,
    logger: { debug: (event: string, data: Record<string, unknown>) => void } = { debug: () => {} }
  ) {
    this.config = config
    this.model = config.model
    this.logger = logger
  }

  private endpoint(): string {
    return (
      this.config.endpoint ??
      `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    )
  }

  async rewrite(input: RewriteRequest): Promise<EngineeredPromptResult> {
    const startedAt = Date.now()
    const completion = await callChatCompletion({
      url: this.endpoint(),
      apiKey: this.config.apiKey,
      model: this.config.model,
      messages: [
        { role: 'system', content: ENGINEER_SYSTEM_PROMPT },
        { role: 'user', content: buildRewriteMessage(input.request, input.hints) },
      ],
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      signal: input.signal,
      logger: this.logger,
    })
    const parsed = extractJsonObject(completion.text)
    return parseEngineeredResult(parsed, completion.model, Date.now() - startedAt)
  }
}
