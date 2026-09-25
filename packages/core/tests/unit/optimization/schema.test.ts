import { describe, it, expect } from 'vitest'
import {
  optimizePromptRequestSchema,
  promptOptimizationResultSchema,
} from '../../../src/services/optimization/schema'

describe('optimizePromptRequestSchema', () => {
  it('accepts a minimal request and normalizes optional fields', () => {
    const parsed = optimizePromptRequestSchema.parse({ prompt: 'write a haiku' })
    expect(parsed.prompt).toBe('write a haiku')
    expect(parsed.context).toBeUndefined()
  })

  it('accepts constraints as a string or a list', () => {
    expect(
      optimizePromptRequestSchema.parse({ prompt: 'p', constraints: 'use markdown' }).constraints
    ).toBe('use markdown')
    expect(
      optimizePromptRequestSchema.parse({ prompt: 'p', constraints: ['a', 'b'] }).constraints
    ).toEqual(['a', 'b'])
  })

  it('rejects empty or oversized prompts', () => {
    expect(optimizePromptRequestSchema.safeParse({ prompt: '' }).success).toBe(false)
    expect(optimizePromptRequestSchema.safeParse({ prompt: 'x'.repeat(64_001) }).success).toBe(false)
  })

  it('rejects unknown validation modes and empty constraints', () => {
    expect(
      optimizePromptRequestSchema.safeParse({ prompt: 'p', validation: 'maybe' }).success
    ).toBe(false)
    expect(optimizePromptRequestSchema.safeParse({ prompt: 'p', constraints: [''] }).success).toBe(false)
  })
})

describe('promptOptimizationResultSchema', () => {
  const valid = {
    optimized_prompt: '## Request\nhello',
    changes: ['Preserved the original request verbatim to protect intent.'],
    assumptions: ['Assumed a neutral tone because none was specified.'],
    warnings: ['the request is under-specified'],
    meta: {
      provider: 'jev',
      model: 'typesafe/jev',
      validation: 'strict' as const,
      questionCount: 8,
      decisionLatencyMs: 420,
      decisions: { intent: 'generation', vagueness: 1, tone: 'neutral' },
    },
  }

  it('accepts a well-formed result', () => {
    expect(promptOptimizationResultSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects an empty optimized prompt', () => {
    const result = promptOptimizationResultSchema.safeParse({ ...valid, optimized_prompt: '' })
    expect(result.success).toBe(false)
  })

  it('rejects non-string list entries and oversized lists', () => {
    expect(promptOptimizationResultSchema.safeParse({ ...valid, changes: ['ok', 42] }).success).toBe(false)
    expect(
      promptOptimizationResultSchema.safeParse({
        ...valid,
        warnings: Array.from({ length: 51 }, () => 'w'),
      }).success
    ).toBe(false)
  })

  it('rejects invalid meta values', () => {
    expect(
      promptOptimizationResultSchema.safeParse({
        ...valid,
        meta: { ...valid.meta, validation: 'loose' },
      }).success
    ).toBe(false)
    expect(
      promptOptimizationResultSchema.safeParse({
        ...valid,
        meta: { ...valid.meta, decisionLatencyMs: -1 },
      }).success
    ).toBe(false)
  })
})
