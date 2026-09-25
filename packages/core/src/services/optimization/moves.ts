/**
 * Curated enhancement-move library.
 *
 * Decision models select WHICH moves apply (they never emit text); every piece
 * of text that can end up in an optimized prompt comes from this reviewed
 * library or from the user's own input. `invasive` marks moves that add task
 * requirements beyond presentation: those are always disclosed through the
 * `assumptions` list and can be switched off with `validation: strict` gates.
 */

export type PromptIntent =
  | 'information'
  | 'generation'
  | 'analysis'
  | 'transformation'
  | 'code'
  | 'planning'
  | 'classification'
  | 'role'

export const PROMPT_INTENTS: Record<PromptIntent, string> = {
  information: 'answer or explain something',
  generation: 'write or create content',
  analysis: 'evaluate, compare or research',
  transformation: 'rewrite, translate, summarize or convert',
  code: 'produce or fix software',
  planning: 'produce a plan, strategy or set of steps',
  classification: 'label, extract, sort or decide over items',
  role: 'hold a persona or conversation',
}

export type ToneChoice = 'neutral' | 'formal' | 'friendly' | 'technical' | 'persuasive' | 'unspecified'

export const TONE_CHOICES: Record<ToneChoice, string> = {
  neutral: 'neutral and clear',
  formal: 'formal and professional',
  friendly: 'friendly and approachable',
  technical: 'precise and technical',
  persuasive: 'confident and persuasive',
  unspecified: 'left to the responder',
}

export interface MoveContext {
  intent: PromptIntent
  vagueness: number
  tone: ToneChoice
  hasContext: boolean
  hasConstraints: boolean
  /** True when the caller's constraints already dictate an output format. */
  hasFormatConstraint: boolean
  targetModel?: string
}

export interface EnhancementMove {
  id: string
  section: 'framing' | 'requirements' | 'approach' | 'output'
  /** Noul question key that gates this move. */
  gate: string
  /** Build the prompt fragment for this move (may depend on decisions). */
  text: (ctx: MoveContext) => string
  /** Human-readable change description. */
  change: (ctx: MoveContext) => string
  /** Disclosed assumption, when the move assumes something. */
  assumption?: (ctx: MoveContext) => string
  /** Adds task requirements beyond presentation/structure. */
  invasive: boolean
  /** Extra applicability check beyond the decision gate. */
  when?: (ctx: MoveContext) => boolean
}

const FRAMEWORK_ROLES: Record<PromptIntent, string> = {
  information: 'Act as a knowledgeable expert.',
  generation: 'Act as a skilled writer.',
  analysis: 'Act as a rigorous analyst.',
  transformation: 'Act as a precise editor.',
  code: 'Act as an experienced software engineer.',
  planning: 'Act as a pragmatic planner.',
  classification: 'Act as a careful reviewer.',
  role: 'Stay in character throughout the response.',
}

const OUTPUT_SHAPES: Record<PromptIntent, string> = {
  information: 'Answer the question directly first, then add only the supporting detail that helps.',
  generation: 'Organize the answer as one complete, self-contained piece.',
  analysis: 'Open with a short summary, then the key points, then a clear conclusion.',
  transformation: 'Return only the transformed result, without commentary.',
  code: 'Return working code first, then briefly note assumptions or edge cases.',
  planning: 'Present the plan as clear, ordered steps, each with its expected outcome.',
  classification: 'Return the result as a clear list or table, one item per entry.',
  role: 'Keep the response in character and close by inviting the next input.',
}

export const ENHANCEMENT_MOVES: EnhancementMove[] = [
  {
    id: 'role-framing',
    section: 'framing',
    gate: 'add_role_framing',
    text: (ctx) => FRAMEWORK_ROLES[ctx.intent],
    change: (ctx) => `Framed the responder for a task whose goal is to ${PROMPT_INTENTS[ctx.intent]}.`,
    assumption: () => 'Assumed the responder should act as the framed expert/role.',
    invasive: true,
  },
  {
    id: 'tone-line',
    section: 'framing',
    gate: 'add_tone',
    text: (ctx) => `Use a ${TONE_CHOICES[ctx.tone]} tone.`,
    change: (ctx) => `Set the response tone to ${ctx.tone}.`,
    assumption: (ctx) => `Assumed a ${ctx.tone} tone because none was specified.`,
    invasive: true,
    when: (ctx) => ctx.tone !== 'unspecified',
  },
  {
    id: 'scope-guardrail',
    section: 'requirements',
    gate: 'add_safety_scope',
    text: () => 'Stay within the scope of this request: answer what is asked, and do not add requirements that were not requested.',
    change: () => 'Added a scope guardrail so the response stays on the requested task.',
    invasive: false,
  },
  {
    id: 'clarify-guardrail',
    section: 'requirements',
    gate: 'add_clarification_guardrail',
    text: () => 'If essential details are missing, state your assumptions briefly before answering rather than inventing specifics.',
    change: () => 'Added guidance to surface assumptions instead of inventing details.',
    invasive: false,
  },
  {
    id: 'process-steps',
    section: 'approach',
    gate: 'add_process_steps',
    text: () => 'Work through the request in a short sequence: restate what is being asked, identify the key considerations, then produce the answer.',
    change: () => 'Added a short step-by-step approach for handling the request.',
    invasive: false,
    when: (ctx) => ctx.intent !== 'transformation' && ctx.intent !== 'role',
  },
  {
    id: 'output-shape',
    section: 'output',
    gate: 'add_output_shape',
    text: (ctx) => OUTPUT_SHAPES[ctx.intent],
    change: () => 'Added an output-structure suggestion matched to the task type.',
    assumption: () => 'Assumed a preferred answer structure that was not specified.',
    invasive: true,
    when: (ctx) => !ctx.hasFormatConstraint,
  },
]

/** Moves that apply when the request is judged vague, regardless of gates. */
export const VAGUENESS_GUARDRAIL_ID = 'clarify-guardrail'
