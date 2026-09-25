import { describe, it, expect } from 'vitest'
import {
  loadDecisionMakerConfig,
  redactConfig,
  validateBaseUrl,
} from '../../../src/services/decision-maker/config'
import { DecisionMakerConfigError } from '../../../src/services/decision-maker/errors'

describe('loadDecisionMakerConfig', () => {
  it('applies documented defaults', () => {
    const config = loadDecisionMakerConfig({})
    expect(config.provider).toBe('jev')
    expect(config.jev.baseUrl).toBe('https://api.commandcode.ai/provider/v1')
    expect(config.jev.model).toBe('typesafe/jev')
    expect(config.laya.baseUrl).toBe('http://127.0.0.1:8787')
    expect(config.laya.model).toBe('english')
    expect(config.retries).toBe(2)
    expect(config.validation).toBe('strict')
  })

  it('selects providers via PROMPT_OPTIMIZER_PROVIDER', () => {
    expect(loadDecisionMakerConfig({ PROMPT_OPTIMIZER_PROVIDER: 'laya' }).provider).toBe('laya')
    expect(() => loadDecisionMakerConfig({ PROMPT_OPTIMIZER_PROVIDER: 'gpt' })).toThrow(
      DecisionMakerConfigError
    )
  })

  it('reads keys from JEV_API_KEY and falls back to COMMANDCODE_API_KEY', () => {
    expect(loadDecisionMakerConfig({ JEV_API_KEY: 'a' }).jev.apiKey).toBe('a')
    expect(loadDecisionMakerConfig({ COMMANDCODE_API_KEY: 'b' }).jev.apiKey).toBe('b')
    expect(
      loadDecisionMakerConfig({ COMMANDCODE_API_KEY: 'b', JEV_API_KEY: 'a' }).jev.apiKey
    ).toBe('a')
    expect(loadDecisionMakerConfig({}).jev.apiKey).toBeUndefined()
  })

  it('validates numeric settings', () => {
    expect(loadDecisionMakerConfig({ PROMPT_OPTIMIZER_RETRIES: '0' }).retries).toBe(0)
    expect(() => loadDecisionMakerConfig({ PROMPT_OPTIMIZER_RETRIES: 'many' })).toThrow(
      DecisionMakerConfigError
    )
    expect(() => loadDecisionMakerConfig({ PROMPT_OPTIMIZER_TIMEOUT_MS: '-5' })).toThrow(
      DecisionMakerConfigError
    )
  })

  it('validates the validation mode', () => {
    expect(loadDecisionMakerConfig({ PROMPT_OPTIMIZER_VALIDATION: 'basic' }).validation).toBe('basic')
    expect(() => loadDecisionMakerConfig({ PROMPT_OPTIMIZER_VALIDATION: 'yolo' })).toThrow(
      DecisionMakerConfigError
    )
  })

  it('rejects non-http(s) base URLs and URLs with embedded credentials', () => {
    expect(() => validateBaseUrl('ftp://example.com', 'X')).toThrow(DecisionMakerConfigError)
    expect(() => validateBaseUrl('http://user:pass@example.com', 'X')).toThrow(DecisionMakerConfigError)
    expect(() => validateBaseUrl('not a url', 'X')).toThrow(DecisionMakerConfigError)
    expect(validateBaseUrl('https://api.example.com/v1/', 'X')).toBe('https://api.example.com/v1')
  })

  it('redacts key material from the loggable view', () => {
    const config = loadDecisionMakerConfig({ JEV_API_KEY: 'top-secret', LAYA_API_KEY: 'laya-secret' })
    const serialized = JSON.stringify(redactConfig(config))
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('laya-secret')
    expect(serialized).toContain('"***"')
  })
})
