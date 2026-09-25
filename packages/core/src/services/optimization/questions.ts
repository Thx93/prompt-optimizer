/**
 * Decision questions for the optimization pipeline.
 *
 * The decision models cannot generate text, so the pipeline asks a small,
 * fixed set of typed questions about the request and maps calibrated answers
 * onto the enhancement-move library. Question keys are internal; the full
 * question text lives in `instructions` (both APIs ignore the key).
 */
import type { DecisionQuestion } from '../decision-maker/types'
import type { NormalizedOptimizePromptRequest } from './schema'
import { PROMPT_INTENTS, TONE_CHOICES, type PromptIntent, type ToneChoice } from './moves'

/** Render the state the decision questions are asked against. */
export function renderState(request: NormalizedOptimizePromptRequest): string {
  const parts: string[] = [`[Original request]\n${request.prompt.trim()}`]
  if (request.context?.trim()) parts.push(`[Objective]\n${request.context.trim()}`)
  if (request.targetModel?.trim()) parts.push(`[Target model]\n${request.targetModel.trim()}`)
  const constraints = normalizeConstraints(request.constraints)
  if (constraints.length > 0) {
    parts.push(`[Constraints — every one must be preserved]\n${constraints.map((c) => `- ${c}`).join('\n')}`)
  }
  if (request.instructions?.trim()) {
    parts.push(`[Optimization instructions]\n${request.instructions.trim()}`)
  }
  return parts.join('\n\n')
}

/** Normalize the constraints input to a discrete list of verbatim items. */
export function normalizeConstraints(constraints: NormalizedOptimizePromptRequest['constraints']): string[] {
  if (!constraints) return []
  const items = Array.isArray(constraints) ? constraints : constraints.split(/\r?\n+/)
  return items.map((item) => item.trim()).filter((item) => item.length > 0)
}

/** The main decision set (one batched call). */
export function buildOptimizationQuestions(): DecisionQuestion[] {
  return [
    {
      key: 'intent',
      type: 'choice',
      instructions:
        'What is the primary intent of the original request? Choose the single best option. The intent is about what the requester wants the eventual responder to do.',
      criteria: Object.fromEntries(
        Object.entries(PROMPT_INTENTS).map(([key, description]) => [key, description])
      ),
    },
    {
      key: 'vagueness',
      type: 'score',
      instructions:
        'How well specified is the original request on its own — how clear is it what a good answer must contain?',
      criteria: [
        'very vague: a good answer would be mostly guesswork',
        'somewhat vague: the goal is clear but key details are missing',
        'clear: a competent responder knows what to deliver',
        'fully specified: scope, audience, length and format are all pinned down',
      ],
    },
    {
      key: 'add_role_framing',
      type: 'noul',
      instructions:
        'Would explicitly framing the responder (role or audience) improve the result for this request, without changing what is being asked?',
      criteria: {
        true: 'framing the responder would improve the result',
        false: 'framing would not help or could distort the request',
      },
    },
    {
      key: 'add_output_shape',
      type: 'noul',
      instructions:
        'Would suggesting a shape for the answer (for example: direct answer first, or summary-then-details) improve the result for this request?',
      criteria: {
        true: 'a suggested answer shape would improve the result',
        false: 'the shape is already implied or pinned down by the request',
      },
    },
    {
      key: 'add_process_steps',
      type: 'noul',
      instructions:
        'Would a short step-by-step approach (restate the ask, list key considerations, then answer) improve the result for this request?',
      criteria: {
        true: 'a brief process would improve reliability',
        false: 'the task is simple enough that a process would only add noise',
      },
    },
    {
      key: 'add_clarification_guardrail',
      type: 'noul',
      instructions:
        'Is there a real risk that a responder would invent details that the request does not specify, so the prompt should tell it to state assumptions instead?',
      criteria: {
        true: 'the prompt should instruct the responder to surface assumptions',
        false: 'the request leaves little room for invented detail',
      },
    },
    {
      key: 'add_safety_scope',
      type: 'noul',
      instructions:
        'Would an explicit instruction to stay within the scope of the request help keep the answer focused here?',
      criteria: {
        true: 'an explicit scope guardrail would help',
        false: 'the request is already narrow and self-contained',
      },
    },
    {
      key: 'tone',
      type: 'choice',
      instructions:
        'What tone does the original request imply for the answer? Choose "unspecified" when the request says nothing about tone.',
      criteria: Object.fromEntries(
        Object.entries(TONE_CHOICES).map(([key, description]) => [key, description])
      ),
    },
  ]
}

/** Post-assembly validation questions (strict mode). */
export function buildValidationQuestions(): DecisionQuestion[] {
  return [
    {
      key: 'intent_preserved',
      type: 'noul',
      instructions:
        'Compare [Original request] and [Optimized prompt] in the state. Do they ask the responder for the SAME deliverable — same subject, same goal, nothing from the original request dropped? ' +
        'Ignore added role framing, structure, style or format guidance: judge only what the responder is asked to produce.',
      criteria: {
        true: 'the deliverable and goal are the same as the original request',
        false: 'the optimized prompt drops or changes what the responder must produce',
      },
    },
    {
      key: 'no_new_requirements',
      type: 'noul',
      instructions:
        'Compare [Original request] and [Optimized prompt] in the state. Does the optimized prompt change the TASK SCOPE — different subject, audience, deliverable, or success criteria — compared with the original request? ' +
        'Added style, tone, role framing, output-structure suggestions or general good-practice guidance do NOT count: only a real change of what is being asked counts.',
      criteria: {
        true: 'the task scope or success criteria are different from the original request',
        false: 'the task scope and success criteria are unchanged',
      },
    },
  ]
}

/** Render the assembled prompt as validation state, next to the original. */
export function renderValidationState(
  request: NormalizedOptimizePromptRequest,
  optimizedPrompt: string
): string {
  return [
    `[Original request]\n${request.prompt.trim()}`,
    `[Optimized prompt]\n${optimizedPrompt.trim()}`,
  ].join('\n\n')
}

/** Map a choice answer back to a typed intent (with fallback). */
export function asIntent(value: string | undefined): PromptIntent {
  return value && value in PROMPT_INTENTS ? (value as PromptIntent) : 'information'
}

export function asTone(value: string | undefined): ToneChoice {
  return value && value in TONE_CHOICES ? (value as ToneChoice) : 'unspecified'
}
