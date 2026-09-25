/**
 * Deterministic prompt assembly.
 *
 * The enhanced prompt is built from the user's own text (verbatim) plus
 * decision-selected fragments from the reviewed enhancement-move library.
 * No model-generated text is ever executed or inserted.
 */
import type { NormalizedOptimizePromptRequest } from './schema'
import type { EnhancementMove, MoveContext } from './moves'
import { normalizeConstraints } from './questions'

export interface AssemblyInput {
  request: NormalizedOptimizePromptRequest
  context: MoveContext
  moves: EnhancementMove[]
  /** When true, only the user's own material is used (strict-mode downgrade). */
  minimal: boolean
}

export interface Assembly {
  prompt: string
  /** Move ids actually applied (empty in minimal mode). */
  appliedMoveIds: string[]
}

/**
 * Assemble the final prompt. The original request always appears verbatim
 * under the Request heading, and every constraint appears verbatim in the
 * Constraints section — intent preservation is guaranteed by construction,
 * then re-checked by the validation stage.
 */
export function assemblePrompt(input: AssemblyInput): Assembly {
  const { request, context, moves, minimal } = input
  const sections: string[] = []
  const appliedMoveIds: string[] = []

  const framing: string[] = []
  const requirements: string[] = []
  const approach: string[] = []
  const output: string[] = []

  if (!minimal) {
    for (const move of moves) {
      appliedMoveIds.push(move.id)
      const text = move.text(context)
      switch (move.section) {
        case 'framing':
          framing.push(text)
          break
        case 'requirements':
          requirements.push(text)
          break
        case 'approach':
          approach.push(text)
          break
        case 'output':
          output.push(text)
          break
      }
    }
  }

  if (framing.length > 0) sections.push(framing.join('\n'))

  sections.push(`## Request\n${request.prompt.trim()}`)

  if (request.context?.trim()) {
    sections.push(`## Context\n${request.context.trim()}`)
  }

  const constraints = normalizeConstraints(request.constraints)
  const requirementLines = [...constraints, ...requirements].map((item, index) => `${index + 1}. ${item}`)
  if (requirementLines.length > 0) {
    sections.push(`## Constraints\n${requirementLines.join('\n')}`)
  }

  if (approach.length > 0) sections.push(`## Approach\n${approach.join('\n')}`)
  if (output.length > 0) sections.push(`## Output\n${output.join('\n')}`)

  return { prompt: sections.join('\n\n'), appliedMoveIds }
}
