/**
 * Output validation: mechanical guarantees plus decision-model gates.
 *
 * Mechanical checks (always):
 * - the original request appears verbatim in the optimized prompt
 * - every caller constraint appears verbatim
 * - size caps hold
 *
 * Decision gates (validation: strict): a second decision call compares the
 * assembled prompt with the original request. If the model flags a changed
 * task or added requirements, the pipeline downgrades to the minimal
 * assembly and records a warning — the model can only veto, never rewrite.
 */
import { DecisionMakerError } from '../decision-maker/errors'
import type { DecisionMakerProvider } from '../decision-maker/types'
import type { NormalizedOptimizePromptRequest } from './schema'
import { buildValidationQuestions, normalizeConstraints, renderValidationState } from './questions'
import { MAX_RESULT_PROMPT_CHARS } from './schema'

export interface MechanicalCheck {
  ok: boolean
  problems: string[]
}

export function mechanicalChecks(
  request: NormalizedOptimizePromptRequest,
  optimizedPrompt: string
): MechanicalCheck {
  const problems: string[] = []
  const original = request.prompt.trim()
  if (!optimizedPrompt.includes(original)) {
    problems.push('the original request does not appear verbatim in the optimized prompt')
  }
  const missing = normalizeConstraints(request.constraints).filter((c) => !optimizedPrompt.includes(c))
  if (missing.length > 0) {
    problems.push(`${missing.length} constraint(s) do not appear verbatim in the optimized prompt`)
  }
  if (optimizedPrompt.trim().length === 0) {
    problems.push('the optimized prompt is empty')
  }
  if (optimizedPrompt.length > MAX_RESULT_PROMPT_CHARS) {
    problems.push(`the optimized prompt exceeds ${MAX_RESULT_PROMPT_CHARS} characters`)
  }
  return { ok: problems.length === 0, problems }
}

export interface GateOutcome {
  passed: boolean
  intentPreserved: boolean
  noNewRequirements: boolean
  detail?: string
}

/** Thresholds: the gate passes unless the model confidently flags a problem. */
const INTENT_PRESERVED_MIN = 0.5
const NO_NEW_REQUIREMENTS_MAX = 0.5

/**
 * Run the decision gates. Fail-open on transport problems (the mechanical
 * checks still hold); fail-closed only on confident "intent changed" or
 * "new requirements" answers.
 */
export async function runDecisionGates(
  provider: DecisionMakerProvider,
  request: NormalizedOptimizePromptRequest,
  optimizedPrompt: string
): Promise<GateOutcome> {
  try {
    const response = await provider.decide({
      state: renderValidationState(request, optimizedPrompt),
      questions: buildValidationQuestions(),
      signal: request.signal,
    })

    const intent = response.answers.intent_preserved
    const requirements = response.answers.no_new_requirements
    const intentP = intent?.type === 'noul' ? intent.noul : 1
    const newReqP = requirements?.type === 'noul' ? requirements.noul : 0

    const intentPreserved = intentP >= INTENT_PRESERVED_MIN
    const noNewRequirements = newReqP <= NO_NEW_REQUIREMENTS_MAX
    return {
      passed: intentPreserved && noNewRequirements,
      intentPreserved,
      noNewRequirements,
      detail: `intent_preserved=${intentP.toFixed(2)} no_new_requirements=${newReqP.toFixed(2)}`,
    }
  } catch (error) {
    if (error instanceof DecisionMakerError && (error.code === 'timeout' || error.code === 'rate_limit')) {
      return {
        passed: true,
        intentPreserved: true,
        noNewRequirements: true,
        detail: `gates skipped (${error.code})`,
      }
    }
    throw error
  }
}
