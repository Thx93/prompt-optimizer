#!/usr/bin/env node
/**
 * Standalone CLI for the decision-driven prompt optimizer.
 *
 * Usage:
 *   node scripts/optimize.mjs --prompt "write a report about ai" \
 *     [--context "..."] [--target-model "..."] [--constraint "..."]... \
 *     [--instructions "..."] [--validation strict|basic|off] [--json]
 *
 * Configuration comes from the environment (see docs/decision-maker.md):
 *   PROMPT_OPTIMIZER_PROVIDER=jev|laya, JEV_API_KEY/COMMANDCODE_API_KEY,
 *   LAYA_BASE_URL, ... — secrets are never passed as arguments.
 */
import { createPromptOptimizer } from '../packages/core/dist/decision-maker.js'

function parseArgs(argv) {
  const out = { prompt: '', constraints: [], json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      return value
    }
    switch (arg) {
      case '--prompt':
        out.prompt = next()
        break
      case '--context':
        out.context = next()
        break
      case '--target-model':
        out.targetModel = next()
        break
      case '--constraint':
        out.constraints.push(next())
        break
      case '--instructions':
        out.instructions = next()
        break
      case '--validation':
        out.validation = next()
        break
      case '--json':
        out.json = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.prompt) {
    console.error('usage: node scripts/optimize.mjs --prompt "..." [--context "..."] [--constraint "..."] [--json]')
    process.exit(2)
  }
  const optimizer = createPromptOptimizer(process.env)
  const result = await optimizer.optimize({
    prompt: args.prompt,
    context: args.context,
    targetModel: args.targetModel,
    constraints: args.constraints.length > 0 ? args.constraints : undefined,
    instructions: args.instructions,
    validation: args.validation,
  })
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${result.optimized_prompt}\n`)
    if (result.changes.length > 0) {
      process.stdout.write(`\nChanges:\n${result.changes.map((c) => `- ${c}`).join('\n')}\n`)
    }
    if (result.assumptions.length > 0) {
      process.stdout.write(`\nAssumptions:\n${result.assumptions.map((a) => `- ${a}`).join('\n')}\n`)
    }
    if (result.warnings.length > 0) {
      process.stdout.write(`\nWarnings:\n${result.warnings.map((w) => `- ${w}`).join('\n')}\n`)
    }
  }
}

main().catch((error) => {
  console.error(`optimize failed (${error && error.code ? error.code : 'unexpected_error'}): ${error && error.message ? error.message : error}`)
  process.exit(1)
})
