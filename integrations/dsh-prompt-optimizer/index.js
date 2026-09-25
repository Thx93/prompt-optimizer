/**
 * DeepSeek Harness tool plugin: `optimize_prompt`.
 *
 * Registers one model-facing tool backed by the prompt-optimizer fork's
 * decision-driven pipeline (providers: JEV via Command Code, or local Laya).
 *
 * Contract highlights:
 * - inputs are schema-validated by the tool registry and re-checked here
 * - the decision-maker is invoked through the provider abstraction in
 *   `@prompt-optimizer/core` (built entry `packages/core/dist/decision-maker.js`,
 *   imported lazily and in-process: no daemon, no ports)
 * - outputs are schema-validated before they reach the model
 * - secrets come from the environment or the harness credential store, are
 *   held only in memory, and are never logged or echoed in errors
 * - prompt contents are never logged by default
 * - hard timeout (tool timeoutMs) and bounded provider retries
 * - disable or replace with `plugin_manager set_plugin/remove_bundle`
 */
const name = 'dsh-prompt-optimizer';
const inject = ['tools', 'commands'];

const TOOL_NAME = 'optimize_prompt';
const COMMAND_NAME = 'optimize-prompt';
const TOOL_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 64_000;
const MAX_CONTEXT_CHARS = 16_000;
const MAX_INSTRUCTIONS_CHARS = 8_000;
const MAX_CONSTRAINTS = 20;
const MAX_CONSTRAINT_CHARS = 2_000;

/** Load the fork's light core entry (relative to this file's real location). */
async function loadCore() {
  const url = new URL('../../packages/core/dist/decision-maker.js', import.meta.url).href;
  try {
    return await import(url);
  } catch (cause) {
    throw new Error(
      'optimize_prompt: built core entry not found at packages/core/dist/decision-maker.js — ' +
        'run `pnpm -F @prompt-optimizer/core build` in the prompt-optimizer checkout first'
    );
  }
}

/**
 * Merge row config with the process environment. Environment variables take
 * precedence (deployment convention: env > config file); the row config fills
 * any non-secret field the environment leaves unset.
 */
function buildEnv(rowConfig) {
  const env = { ...process.env };
  const put = (key, value) => {
    if (env[key] !== undefined && env[key] !== '') return; // environment wins
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      env[key] = String(value);
    }
  };
  put('PROMPT_OPTIMIZER_PROVIDER', rowConfig.provider);
  put('PROMPT_OPTIMIZER_VALIDATION', rowConfig.validation);
  put('PROMPT_OPTIMIZER_TIMEOUT_MS', rowConfig.timeoutMs);
  put('PROMPT_OPTIMIZER_RETRIES', rowConfig.retries);
  put('PROMPT_OPTIMIZER_MAX_STATE_CHARS', rowConfig.maxStateChars);
  if (rowConfig.jev && typeof rowConfig.jev === 'object') {
    put('JEV_BASE_URL', rowConfig.jev.baseUrl);
    put('JEV_MODEL', rowConfig.jev.model);
    put('JEV_ENDPOINT', rowConfig.jev.endpoint);
    put('JEV_TIMEOUT_MS', rowConfig.jev.timeoutMs);
  }
  if (rowConfig.laya && typeof rowConfig.laya === 'object') {
    put('LAYA_BASE_URL', rowConfig.laya.baseUrl);
    put('LAYA_MODEL', rowConfig.laya.model);
    put('LAYA_ENDPOINT', rowConfig.laya.endpoint);
    put('LAYA_TIMEOUT_MS', rowConfig.laya.timeoutMs);
  }
  return env;
}

/**
 * Resolve a secret from the harness credential store (which itself checks the
 * environment first). Returns undefined rather than throwing: a missing key
 * surfaces as a clean provider auth error later.
 */
async function resolveSecret(ctx, ref) {
  try {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
    if (!credentials || typeof credentials.resolve !== 'function') return undefined;
    const resolved = await credentials.resolve(ref);
    if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) {
      return resolved.value;
    }
  } catch {
    /* no credential available: fall through */
  }
  return undefined;
}

function requireString(value, field, maxChars) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`optimize_prompt: ${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxChars) {
    throw new Error(`optimize_prompt: ${field} must be at most ${maxChars} characters`);
  }
  return trimmed;
}

function normalizeConstraints(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('optimize_prompt: constraints must be an array of strings');
  if (value.length > MAX_CONSTRAINTS) {
    throw new Error(`optimize_prompt: constraints accepts at most ${MAX_CONSTRAINTS} items`);
  }
  const items = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('optimize_prompt: each constraint must be a string');
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_CONSTRAINT_CHARS) {
      throw new Error(`optimize_prompt: each constraint must be at most ${MAX_CONSTRAINT_CHARS} characters`);
    }
    items.push(trimmed);
  }
  return items.length > 0 ? items : undefined;
}

/** Best-effort machine-readable error code without leaking content. */
function errorCode(error) {
  const cause = error && error.cause ? error.cause : undefined;
  return (
    (cause && cause.code ? String(cause.code) : undefined) ||
    (error && error.code ? String(error.code) : 'unexpected_error')
  );
}

/** Human-readable result rendering (shared by tool output and command text). */
function resultText(value) {
  const parts = [`Optimized prompt:\n\n${value.optimized_prompt}`];
  if (value.changes && value.changes.length > 0) {
    parts.push(`Changes:\n${value.changes.map((c) => `- ${c}`).join('\n')}`);
  }
  if (value.assumptions && value.assumptions.length > 0) {
    parts.push(`Assumptions:\n${value.assumptions.map((a) => `- ${a}`).join('\n')}`);
  }
  if (value.warnings && value.warnings.length > 0) {
    parts.push(`Warnings:\n${value.warnings.map((w) => `- ${w}`).join('\n')}`);
  }
  parts.push(
    `(decision-maker: ${value.provider} · ${value.model} · ${value.decision_latency_ms} ms · validation: ${value.validation})`
  );
  return parts.join('\n\n');
}

/**
 * Parse the command's raw input: a JSON request object (button path, may set
 * `response: 'json'`) or plain prompt text (slash-command path).
 */
function parseCommandInput(rawInput) {
  const text = String(rawInput ?? '').trim();
  if (text.length === 0) throw new Error('optimize-prompt: provide the prompt to optimize');
  if (text.length > MAX_PROMPT_CHARS + MAX_CONTEXT_CHARS + 32_000) {
    throw new Error('optimize-prompt: input is too large');
  }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string') {
        return {
          prompt: parsed.prompt,
          context: typeof parsed.context === 'string' ? parsed.context : undefined,
          targetModel: typeof parsed.target_model === 'string' ? parsed.target_model : undefined,
          constraints: normalizeConstraints(parsed.constraints),
          instructions: typeof parsed.instructions === 'string' ? parsed.instructions : undefined,
          response: parsed.response === 'json' ? 'json' : 'text',
        };
      }
    } catch {
      /* not JSON after all: treat as plain prompt text */
    }
  }
  return { prompt: text, response: 'text' };
}

function apply(ctx, config = {}) {
  const rowConfig = config && typeof config === 'object' ? config : {};
  let runtimePromise;

  async function runtime() {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const core = await loadCore();
        const env = buildEnv(rowConfig);
        const decisionConfig = core.loadDecisionMakerConfig(env);
        const credentialsRef =
          typeof rowConfig.credentialsRef === 'string' && rowConfig.credentialsRef.trim()
            ? rowConfig.credentialsRef.trim()
            : 'COMMANDCODE_API_KEY';
        if (decisionConfig.provider === 'jev' && !decisionConfig.jev.apiKey) {
          const secret = await resolveSecret(ctx, credentialsRef);
          if (secret) decisionConfig.jev.apiKey = secret;
        }
        if (decisionConfig.provider === 'laya' && !decisionConfig.laya.apiKey) {
          const secret = await resolveSecret(ctx, 'LAYA_API_KEY');
          if (secret) decisionConfig.laya.apiKey = secret;
        }
        return { core, decisionConfig };
      })().catch((error) => {
        runtimePromise = undefined; // allow retry after a transient failure
        throw error;
      });
    }
    return runtimePromise;
  }

  /** Shared optimize path (tool execute + command handler). */
  async function runOptimize(request) {
    const prompt = requireString(request.prompt, 'prompt', MAX_PROMPT_CHARS);
    if (!prompt) throw new Error('prompt must be a non-empty string');
    const context = requireString(request.context, 'context', MAX_CONTEXT_CHARS);
    const targetModel = requireString(request.targetModel, 'target_model', 200);
    const constraints = normalizeConstraints(request.constraints);

    const { core, decisionConfig } = await runtime();
    const provider = core.createDecisionMakerProvider(decisionConfig);
    const optimizer = new core.PromptOptimizer({
      provider,
      validation: decisionConfig.validation,
      maxStateChars: decisionConfig.maxStateChars,
    });

    const result = await optimizer.optimize({ prompt, context, targetModel, constraints, signal: request.signal });
    return {
      optimized_prompt: result.optimized_prompt,
      changes: result.changes,
      assumptions: result.assumptions,
      warnings: result.warnings,
      provider: result.meta ? result.meta.provider : decisionConfig.provider,
      model: result.meta ? result.meta.model : '',
      validation: result.meta ? result.meta.validation : decisionConfig.validation,
      decision_latency_ms: result.meta && result.meta.decisionLatencyMs ? result.meta.decisionLatencyMs : 0,
    };
  }

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Optimize a prompt before sending it to a model. Takes the original prompt plus optional context, ' +
      'target model and constraints, and returns an enhanced prompt that preserves the original request ' +
      'verbatim, together with a change/assumption/warning summary. Use it to make vague requests concrete, ' +
      'to add missing structure, and to surface assumptions — never to change what is being asked.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'The original prompt to enhance. It is preserved verbatim inside the result.',
        },
        context: {
          type: 'string',
          description: 'Optional objective or background: what the prompt is for, who will read the answer.',
        },
        target_model: {
          type: 'string',
          description: 'Optional identifier of the model the optimized prompt will be sent to.',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional requirements that MUST be preserved verbatim in the optimized prompt (length, format, language, ...).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'optimized_prompt',
          'changes',
          'assumptions',
          'warnings',
          'provider',
          'model',
          'validation',
          'decision_latency_ms',
        ],
        properties: {
          optimized_prompt: { type: 'string' },
          changes: { type: 'array', items: { type: 'string' } },
          assumptions: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          provider: { type: 'string' },
          model: { type: 'string' },
          validation: { type: 'string' },
          decision_latency_ms: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: resultText(value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const prompt = requireString(args.prompt, 'prompt', MAX_PROMPT_CHARS);
      if (!prompt) throw new Error('optimize_prompt: prompt must be a non-empty string');
      const context = requireString(args.context, 'context', MAX_CONTEXT_CHARS);
      const targetModel = requireString(args.target_model, 'target_model', 200);
      const constraints = normalizeConstraints(args.constraints);

      const signal = exec && exec.signal && typeof exec.signal.addEventListener === 'function' ? exec.signal : undefined;
      try {
        return await runOptimize({ prompt, context, targetModel, constraints, signal });
      } catch (error) {
        // Surface a concise, content-free error: codes and provider names only.
        throw new Error(`optimize_prompt failed (${errorCode(error)}): ${error && error.message ? error.message : 'unknown error'}`);
      }
    },
  });

  /**
   * Host command — the bridge the composer button calls through
   * `remote.commands.execute`. `rawInput` is the prompt itself or a JSON
   * request object (the button sends JSON with `"response": "json"`).
   * `recordInput: false` keeps the prompt payload out of the session log.
   */
  ctx.commands.register({
    name: COMMAND_NAME,
    description:
      'Optimize a prompt with the configured decision-maker (JEV/Laya) and show the enhanced version. ' +
      'Used by the composer button; also available as /' + COMMAND_NAME + ' <prompt>.',
    input: { hint: 'the prompt to optimize' },
    recordInput: false,
    async handler(invocation) {
      try {
        const request = parseCommandInput(invocation.rawInput);
        const result = await runOptimize(request);
        if (request.response === 'json') {
          return { kind: 'success', text: JSON.stringify(result) };
        }
        return { kind: 'success', text: resultText(result) };
      } catch (error) {
        return {
          kind: 'error',
          text: `optimize-prompt failed (${errorCode(error)}): ${error && error.message ? error.message : 'unknown error'}`,
        };
      }
    },
  });
}

export { name, inject, apply };
