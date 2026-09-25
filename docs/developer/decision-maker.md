# Decision-Maker Prompt Optimization (JEV / Laya) — Architecture & Operations

This fork adds a **decision-driven prompt-enhancement pipeline** to
prompt-optimizer and exposes it to the DeepSeek Harness as the
`optimize_prompt` tool.

> **Core fact behind the design.** Both candidate decision models are
> non-generative *System One decision models*: they answer typed questions
> (`noul` yes/no probability, `choice` calibrated selection, `score` rubric
> value) and **never generate text** — so they cannot "write" a better prompt.
> Instead they *decide* how to enhance one. Every text fragment in the output
> comes from the user's own input or from a reviewed enhancement-move library;
> the decision-maker selects which moves apply, and calibrated gates verify
> intent preservation before the result is returned.

- JEV (TypeSafe AI) is reached through the Command Code provider API:
  `POST https://api.commandcode.ai/provider/v1/systemone`, model `typesafe/jev`.
- Laya (convaiinnovations/laya) runs locally via `laya-serve`:
  `POST http://127.0.0.1:8787/v1/systemone` (Jev-compatible envelope).

## 1. Architecture overview

```
DeepSeek Harness (web or headless session)
   └─ tool: optimize_prompt            integrations/dsh-prompt-optimizer/
        └─ PromptOptimizer (8 stages) packages/core/src/services/optimization/
             ├─ normalize & validate input (zod)
             ├─ compose requirements/objective state
             ├─ build typed decision questions
             ├─ DecisionMakerProvider.decide()   packages/core/src/services/decision-maker/
             │    ├─ JEVProvider  → Command Code /systemone
             │    └─ LayaProvider → laya-serve /v1/systemone
             ├─ validate structured decisions (zod)
             ├─ assemble enhanced prompt (deterministic; move library)
             ├─ validate output (mechanical + decision gates)
             └─ PromptOptimizationResult { optimized_prompt, changes,
                  assumptions, warnings, meta }
```

Pipeline stages are explicit in
[`pipeline.ts`](../packages/core/src/services/optimization/pipeline.ts);
provider-specific logic is confined to
[`decision-maker/`](../packages/core/src/services/decision-maker/).

The `PromptOptimizationResult` schema
([`schema.ts`](../packages/core/src/services/optimization/schema.ts)) is
validated before anything reaches the caller:

| Field | Meaning |
| --- | --- |
| `optimized_prompt` | final prompt; always contains the original request verbatim |
| `changes` | human-readable summary of applied enhancements |
| `assumptions` | anything the enhancement assumed — never silent |
| `warnings` | gate downgrades, truncation, under-specification notes |
| `meta` | provider, model id, validation mode, latency, decision summary |

## 2. Installation

Verified on this VPS (Ubuntu 24.04, x86_64). A Node 24 toolchain + pnpm 10.6.1
is required by the repo (`engines.node ^24`, `packageManager pnpm@10.6.1`).

```bash
# 1. get the fork
git clone https://github.com/Thx93/prompt-optimizer.git
cd prompt-optimizer

# 2. install dependencies (skip the Electron binary download on a server)
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install

# 3. build the core (produces packages/core/dist/decision-maker.js used by the plugin)
pnpm -F @prompt-optimizer/core build

# 4. run the test suites
pnpm -F @prompt-optimizer/core test
node --test integrations/dsh-prompt-optimizer/test/tool.test.mjs
```

## 3. Configuration

All configuration is environment-driven
([`config.ts`](../packages/core/src/services/decision-maker/config.ts)).
Secrets are **only** read from the environment or the host application's
credential store — never from files in this repository.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROMPT_OPTIMIZER_PROVIDER` | `jev` | decision-maker backend: `jev` or `laya` |
| `PROMPT_OPTIMIZER_VALIDATION` | `strict` | `strict` (decision gates) / `basic` / `off` |
| `PROMPT_OPTIMIZER_RETRIES` | `2` | bounded retries (0–10) on 429/5xx/network |
| `PROMPT_OPTIMIZER_TIMEOUT_MS` | — | global timeout override (ms) |
| `PROMPT_OPTIMIZER_MAX_STATE_CHARS` | — | optional state-size cap override |
| `JEV_API_KEY` | — | JEV key (falls back to `COMMANDCODE_API_KEY`, then `TYPESAFE_API_KEY`) |
| `JEV_BASE_URL` | `https://api.commandcode.ai/provider/v1` | Command Code provider API |
| `JEV_MODEL` | `typesafe/jev` | model id (TypeSafe native: `jev-latest`) |
| `JEV_TIMEOUT_MS` | `15000` | per-request timeout |
| `LAYA_BASE_URL` | `http://127.0.0.1:8787` | laya-serve base URL |
| `LAYA_MODEL` | `english` | checkpoint: `english` / `multilingual` / `typed-decisions` |
| `LAYA_API_KEY` | — | optional laya-serve bearer key |
| `LAYA_TIMEOUT_MS` | `60000` | per-request timeout |

Base URLs must be http(s) without embedded credentials (validated at load).

## 4. JEV setup (remote, default provider)

1. Get a Command Code API key (it must have API access — GOAT plan or the
   pay-as-you-go Provider plan; see https://commandcode.ai/models/jev).
2. Export it (or let the DeepSeek Harness credential store supply it):
   ```bash
   export JEV_API_KEY=<your command code key>
   export PROMPT_OPTIMIZER_PROVIDER=jev
   ```
3. Smoke-test:
   ```bash
   node scripts/optimize.mjs --prompt "write a report about ai" --constraint "under 500 words"
   ```

To use TypeSafe's native API instead: `JEV_BASE_URL=https://api.typesafe.ai/v1`,
`JEV_MODEL=jev-latest`, `JEV_API_KEY=<typesafe key>`.

## 5. Laya setup (local, optional provider)

Laya is served on this VPS with the official `laya` package (CPU):

```bash
python3 -m venv .venv-laya
./.venv-laya/bin/pip install "laya[serve]"

export HF_HOME=/root/Prompt-Enhancer/.cache/huggingface   # keep weights out of $HOME
export LAYA_HOST=127.0.0.1 LAYA_PORT=8787 LAYA_DEVICE=cpu LAYA_THREADS=2 \
       LAYA_MODELS=english LAYA_PRELOAD=1
./.venv-laya/bin/laya-serve
```

Notes verified against laya 0.3.20:

- `GET /health` → `{"status":"ok","loaded":["english"],"device":"cpu"}`
- always pin `LAYA_MODELS` (empty means *all three* checkpoints ≈ too much RAM)
- the English checkpoint attends to ~512 tokens of state — keep prompts compact
- measured on this VPS (4 vCPU): ~1.0–1.3 s per 3-question call, ~2.5 GiB RSS
- `laya-serve` takes no CLI flags (config is env-only; `--help` starts the server)

Then select it: `PROMPT_OPTIMIZER_PROVIDER=laya` (optionally `LAYA_API_KEY`).

For persistent serving, see `deploy/laya-serve.service` (systemd unit).

## 6. DeepSeek Harness plugin setup

The plugin is a native harness tool bundle:
[`integrations/dsh-prompt-optimizer/`](../integrations/dsh-prompt-optimizer/)
(package manifest `package.json`, registration `cordis.patch.yml`, tool
definition + schema in `index.js`).

```bash
# install into the web profile (persistent, applies to every session)
#   → via the agent: plugin_manager install_bundle
#   → or via CLI:
dsh plugin --profile web add /root/Prompt-Enhancer/prompt-optimizer/integrations/dsh-prompt-optimizer

# install into the headless profile (used for smoke tests/automation)
dsh plugin --profile headless add /root/Prompt-Enhancer/prompt-optimizer/integrations/dsh-prompt-optimizer
```

The tool interface (the harness registry validates it):

```
optimize_prompt(prompt, context?, target_model?, constraints?) →
  { optimized_prompt, changes[], assumptions[], warnings[],
    provider, model, validation, decision_latency_ms }
```

**Composer button + `/optimize-prompt` command.** The bundle also ships a
client half (`client.js`) that registers a wand button into the composer tool
row (`conversation.input.right`, directly before the send action). Clicking it
optimizes the current composer draft and replaces the draft with the enhanced
prompt, then shows the change/assumption/warning summary as a composer notice.
The host side of the bridge is a regular harness command (`optimize-prompt`,
also usable from the slash menu), executed through `remote.commands.execute`;
its `recordInput: false` keeps the prompt payload out of the session log. After
installing or updating the bundle, refresh the Web UI page once so the browser
picks up the client artifact.

Non-secret settings may be placed in the bundle's `cordis.patch.yml` `config:`
block (`provider`, `validation`, `jev.baseUrl`, `laya.model`, `timeoutMs`,
`retries`, `credentialsRef`, …). Environment variables take precedence
(`PROMPT_OPTIMIZER_PROVIDER=laya` switches providers at runtime); the block
fills any non-secret field the environment leaves unset. **Secrets never go in
that file**: the plugin resolves keys from `process.env` first and otherwise
from the Harness credential store via the ref named by `credentialsRef`
(default `COMMANDCODE_API_KEY`).

Disable or remove at any time:

```
plugin_manager set_plugin <entry-id> enabled=false    # toggle
plugin_manager remove_bundle @local/dsh-prompt-optimizer
```

## 7. Development workflow

```bash
pnpm -F @prompt-optimizer/core typecheck     # types
pnpm -F @prompt-optimizer/core test          # full core suite
pnpm -F @prompt-optimizer/core exec vitest run tests/unit/decision-maker tests/unit/optimization
node --test integrations/dsh-prompt-optimizer/test/tool.test.mjs
pnpm -F @prompt-optimizer/core build         # rebuild dist after src changes
```

The plugin imports `packages/core/dist/decision-maker.js` lazily and
in-process: after changing core sources, rebuild — no service restart beyond
the harness's own plugin reload.

## 8. Testing

| Layer | Where | How |
| --- | --- | --- |
| transport (timeouts/retries/auth/size caps) | `tests/unit/decision-maker/systemone-client.test.ts` | mocked `fetch` |
| config & secret redaction | `tests/unit/decision-maker/config.test.ts` | pure |
| JEV/Laya request+response handling | `tests/unit/decision-maker/providers.test.ts` | mocked `fetch` |
| output schema / malformed output | `tests/unit/optimization/schema.test.ts`, `pipeline.test.ts` | pure |
| prompt preservation & gates | `tests/unit/optimization/pipeline.test.ts` | fake provider |
| optimizer → provider → HTTP | `tests/integration/decision-optimization.test.ts` | real response shapes, mocked endpoints |
| plugin contract & tool behavior | `integrations/dsh-prompt-optimizer/test/tool.test.mjs` | `node --test`, stubbed transport |
| end-to-end via harness | `dsh headless "Call the optimize_prompt tool ..."` | live decision-maker |

Live smoke tests (real providers) are run manually with the CLI or the
harness; no credentials are stored in the repository.

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `optimize_prompt failed (auth): ... rejected the credentials` | no key found: export `JEV_API_KEY` (or `COMMANDCODE_API_KEY`), or store it in the harness credential store |
| `built core entry not found ...` | run `pnpm -F @prompt-optimizer/core build` |
| `optimize_prompt failed (timeout)` | provider slow/unreachable: raise `JEV_TIMEOUT_MS`/`LAYA_TIMEOUT_MS`, check `LAYA_BASE_URL`, `curl http://127.0.0.1:8787/health` |
| `optimize_prompt failed (invalid_request)` | input over limits (prompt 64k chars, 20 constraints) or provider question caps |
| result always "minimal form" | the strict gates flagged intent/scope drift — see `warnings`; use `PROMPT_OPTIMIZER_VALIDATION=basic` to inspect the ungated assembly |
| laya-serve dies at startup with `PermissionError ... /root/.cache/huggingface` | set `HF_HOME` to a writable path (see §5) |
| Laya answers degrade on long prompts | the English checkpoint attends to ~512 tokens; shorten the state or use `multilingual` (1,024) |

## 10. Security considerations

- **Secrets**: only from environment variables or the harness credential
  store; never logged, never in URLs, never in the repository. `redactConfig()`
  masks keys in the loggable config view.
- **Prompt/data flow**: prompts are sent to the configured decision-maker.
  With `jev` that is the Command Code/TypeSafe API (third-party processing);
  with `laya` everything stays on this machine. Choose accordingly.
- **No code execution**: model output is typed data validated by zod schemas;
  the enhanced prompt is assembled from reviewed library fragments plus the
  user's own text. Nothing model-generated is executed or interpreted.
- **Bounded resources**: request timeouts (15 s JEV / 60 s Laya, tool cap
  120 s), retries ≤ 10 (default 2) with exponential backoff and jitter,
  response bodies capped at 1 MiB, state/question/constraint size caps,
  `noul`/`choice`/`score` answers range-checked.
- **SSRF hygiene**: provider base URLs are operator configuration, validated
  (http/https, no embedded credentials); the request path is fixed
  (`/systemone`, `/v1/systemone`) and never model-derived.
- **Logging**: metadata only (provider, status, latency, question keys) —
  never prompt content, question text, answers, or credentials.
- **Least privilege**: the plugin registers one tool and reads at most one
  named credential ref; it uses no filesystem or shell facilities.

## Provider comparison (recorded 2026-09-25)

| Criterion | JEV (via Command Code) | Laya (local, laya-serve) |
| --- | --- | --- |
| Integration complexity | one HTTPS POST + bearer key | one local POST; venv + weights |
| Local execution | no (hosted) | yes (CPU, ~2.5 GiB RSS) |
| API availability | always-on cloud endpoint | only while laya-serve runs |
| Structured output | intrinsic (typed answers) | intrinsic (typed answers) |
| Context length | 32K tokens (state + longest question) | ~512 tokens EN (1,024 multi/typed) |
| Latency | 70–500 ms, flat in question count | ~0.5 s per question (measured 1.0–1.3 s / 3 q) |
| Resource requirements | none locally | 4 vCPU-friendly, 2.5 GiB RAM |
| Reliability | depends on Command Code/TypeSafe uptime | local process; no network |
| Cost / dependency | $0.042/M input, output free; external account | free (Apache-2.0); offline |
| Fit for prompt optimization | strong: large state, parallel questions | workable for short prompts; gating/scoring strength |

**Selection**: `jev` is the default decision-maker (large context, sub-second,
zero local footprint); `laya` is the fully implemented local/privacy
alternative behind the same interface (`PROMPT_OPTIMIZER_PROVIDER=laya`).
