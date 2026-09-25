/**
 * Light entry point for external integrations (e.g. the DeepSeek harness
 * plugin). Exports the decision-maker abstraction and the optimization
 * pipeline WITHOUT the heavy service graph of the main entry (no browser
 * storage, no vendor SDKs): only zod and local modules.
 */
export * from './services/decision-maker/index'
export * from './services/optimization/index'
