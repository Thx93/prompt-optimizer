/**
 * Standalone tests for the harness tool plugin (no harness required):
 *   node --test integrations/dsh-prompt-optimizer/test/tool.test.mjs
 *
 * Requires the built core entry (`pnpm -F @prompt-optimizer/core build`).
 * The HTTP transport is stubbed; no network and no credentials are used.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { name as pluginName, inject, apply } from '../index.js';

const JEV_SHAPED_RESPONSE = {
  model: 'typesafe/jev',
  answers: {
    intent: { type: 'choice', choice: 'generation', confidence: 1, probabilities: { generation: 1 } },
    vagueness: {
      type: 'score',
      score: 1.0,
      confidence: 0.8,
      legend: { '0': 'very vague', '1': 'somewhat vague', '2': 'clear', '3': 'fully specified' },
      probabilities: { '1': 1 },
    },
    add_role_framing: { type: 'noul', noul: 0.7 },
    add_output_shape: { type: 'noul', noul: 0.6 },
    add_process_steps: { type: 'noul', noul: 0.6 },
    add_clarification_guardrail: { type: 'noul', noul: 0.8 },
    add_safety_scope: { type: 'noul', noul: 0.6 },
    tone: { type: 'choice', choice: 'unspecified', confidence: 1, probabilities: { unspecified: 1 } },
    intent_preserved: { type: 'noul', noul: 0.97 },
    no_new_requirements: { type: 'noul', noul: 0.1 },
  },
  usage: { input_tokens: 100, output_tokens: 0 },
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeHarness() {
  const calls = [];
  let registered;
  const ctx = {
    tools: {
      register(definition) {
        registered = definition;
      },
    },
    get(service) {
      if (service === 'credentials') {
        return {
          async resolve(ref) {
            return ref === 'COMMANDCODE_API_KEY' ? { value: 'credential-store-key', source: 'file' } : undefined;
          },
        };
      }
      return undefined;
    },
  };
  return {
    ctx,
    calls,
    get registered() {
      return registered;
    },
  };
}

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.PROMPT_OPTIMIZER_PROVIDER = 'jev';
  process.env.PROMPT_OPTIMIZER_VALIDATION = 'strict';
  process.env.JEV_API_KEY = 'test-key';
});
afterEach(() => {
  process.env = savedEnv;
  delete globalThis.__pluginTestFetch;
});

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    return handler(String(url), init, body);
  };
}

test('plugin exports the loader contract and registers one tool', () => {
  assert.equal(pluginName, 'dsh-prompt-optimizer');
  assert.deepEqual(inject, ['tools']);
  const harness = makeHarness();
  apply(harness.ctx, { provider: 'jev', validation: 'strict', credentialsRef: 'COMMANDCODE_API_KEY' });
  assert.ok(harness.registered, 'tool must be registered');
  assert.equal(harness.registered.name, 'optimize_prompt');
  assert.equal(harness.registered.parameters.required[0], 'prompt');
  assert.equal(harness.registered.parameters.additionalProperties, false);
  assert.equal(typeof harness.registered.execute, 'function');
  assert.equal(typeof harness.registered.output.render, 'function');
  assert.ok(harness.registered.timeoutMs > 0);
});

test('execute runs end-to-end and preserves the original prompt and constraints', async () => {
  const requests = [];
  stubFetch((url, init, body) => {
    requests.push({ url, init, body });
    return jsonResponse(200, JEV_SHAPED_RESPONSE);
  });

  const harness = makeHarness();
  apply(harness.ctx, {});
  const value = await harness.registered.execute(
    {
      prompt: 'Write an article about solar power.',
      context: 'Company blog for managers.',
      target_model: 'gpt-5',
      constraints: ['Under 800 words', 'Include an intro'],
    },
    {}
  );

  assert.ok(value.optimized_prompt.includes('Write an article about solar power.'));
  assert.ok(value.optimized_prompt.includes('Under 800 words'));
  assert.ok(value.optimized_prompt.includes('Include an intro'));
  assert.equal(value.provider, 'jev');
  assert.equal(value.model, 'typesafe/jev');
  assert.equal(value.validation, 'strict');
  assert.ok(Array.isArray(value.changes) && value.changes.length > 0);
  assert.ok(Array.isArray(value.assumptions));
  assert.ok(Array.isArray(value.warnings));

  // provider routing + auth from env
  assert.equal(requests[0].url, 'https://api.commandcode.ai/provider/v1/systemone');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(requests[0].body.model, 'typesafe/jev');
  assert.ok(requests[0].body.state.includes('Write an article about solar power.'));

  // render produces a readable text block
  const rendered = harness.registered.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.includes('Optimized prompt:'));
});

test('execute validates inputs before touching the provider', async () => {
  let fetched = false;
  stubFetch(() => {
    fetched = true;
    return jsonResponse(200, JEV_SHAPED_RESPONSE);
  });
  const harness = makeHarness();
  apply(harness.ctx, {});

  await assert.rejects(() => harness.registered.execute({ prompt: '   ' }, {}), /non-empty string/);
  await assert.rejects(() => harness.registered.execute({ prompt: 'ok', constraints: 'not-an-array' }, {}));
  await assert.rejects(
    () => harness.registered.execute({ prompt: 'ok', constraints: ['x'.repeat(2_001)] }, {}),
    /at most 2000 characters/
  );
  await assert.rejects(
    () => harness.registered.execute({ prompt: 'x'.repeat(64_001) }, {}),
    /at most 64000 characters/
  );
  assert.equal(fetched, false);
});

test('execute surfaces auth failures without leaking the key', async () => {
  stubFetch(() =>
    jsonResponse(401, { error: { message: 'invalid key', type: 'authentication_error' } })
  );
  const harness = makeHarness();
  apply(harness.ctx, {});

  const error = await harness.registered
    .execute({ prompt: 'hello world' }, {})
    .then(() => null)
    .catch((e) => e);
  assert.ok(error instanceof Error);
  assert.match(error.message, /optimize_prompt failed \(auth\)/);
  assert.ok(!error.message.includes('test-key'), 'error must not contain the API key');
});

test('falls back to the harness credential store when no env key is set', async () => {
  delete process.env.JEV_API_KEY;
  let authHeader;
  stubFetch((url, init) => {
    authHeader = init.headers.Authorization;
    return jsonResponse(200, JEV_SHAPED_RESPONSE);
  });

  const harness = makeHarness();
  apply(harness.ctx, {});
  await harness.registered.execute({ prompt: 'hello world' }, {});
  assert.equal(authHeader, 'Bearer credential-store-key');
});

test('row config fills non-secret fields the environment leaves unset', async () => {
  delete process.env.JEV_BASE_URL;
  let requestedUrl;
  stubFetch((url) => {
    requestedUrl = url;
    return jsonResponse(200, JEV_SHAPED_RESPONSE);
  });

  const harness = makeHarness();
  apply(harness.ctx, { jev: { baseUrl: 'https://jev.example.internal/v1', model: 'jev-latest' } });
  await harness.registered.execute({ prompt: 'hello world' }, {});
  assert.equal(requestedUrl, 'https://jev.example.internal/v1/systemone');
});

test('environment variables take precedence over row config', async () => {
  process.env.PROMPT_OPTIMIZER_PROVIDER = 'jev';
  process.env.JEV_BASE_URL = 'https://from-env.example/v1';
  let requestedUrl;
  stubFetch((url) => {
    requestedUrl = url;
    return jsonResponse(200, JEV_SHAPED_RESPONSE);
  });

  const harness = makeHarness();
  apply(harness.ctx, { jev: { baseUrl: 'https://from-row.example/v1' } });
  await harness.registered.execute({ prompt: 'hello world' }, {});
  assert.equal(requestedUrl, 'https://from-env.example/v1/systemone');
});
