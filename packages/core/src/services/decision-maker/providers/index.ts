/**
 * Provider factory: build the configured decision-maker without any
 * provider-specific logic leaking into callers.
 */
import type { DecisionMakerConfig } from '../config'
import type { DecisionMakerProvider } from '../types'
import type { SystemOneLogger } from '../systemone-client'
import { JEVProvider } from './jev'
import { LayaProvider } from './laya'

export { JEVProvider, LayaProvider }
export type { JEVProviderConfig } from './jev'
export type { LayaProviderConfig } from './laya'
export type { SystemOneProviderOptions } from './base'

export interface CreateProviderOptions {
  logger?: SystemOneLogger
}

/** Build the provider selected by `config.provider`. */
export function createDecisionMakerProvider(
  config: DecisionMakerConfig,
  options: CreateProviderOptions = {}
): DecisionMakerProvider {
  if (config.provider === 'jev') {
    return new JEVProvider(
      {
        baseUrl: config.jev.baseUrl,
        endpoint: config.jev.endpoint,
        apiKey: config.jev.apiKey,
        model: config.jev.model,
        timeoutMs: config.jev.timeoutMs,
        retries: config.retries,
      },
      { logger: options.logger }
    )
  }
  return new LayaProvider(
    {
      baseUrl: config.laya.baseUrl,
      endpoint: config.laya.endpoint,
      apiKey: config.laya.apiKey,
      model: config.laya.model,
      timeoutMs: config.laya.timeoutMs,
      retries: config.retries,
    },
    { logger: options.logger }
  )
}
