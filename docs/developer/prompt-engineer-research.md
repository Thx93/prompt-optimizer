# Scouting Report — Open-source resources for a "Prompt Engineer" prompt-optimization feature

Research date: 2026-09-27 (session clock). All claims below are backed by a source URL that was actually fetched or queried during this session. Search tooling used: GitHub REST/search API + `gh` CLI (authenticated), Exa search (via mcporter, later rate-limited), direct `curl`/`web_fetch` of pages. The built-in `web_search` tool was unavailable in this session (no `DEEPSEEK_API_KEY`).

---

## 1. GitHub repos cloning/reimplementing the "Prompt Engineer" custom GPT (chatgpt.com/g/g-5XtVuRE8Y)

### 1a. Identity of the target GPT (verified)

| Fact | Value | Source |
|---|---|---|
| Name | `Prompt Engineer` | https://gpt.builders/page/gpt/g-5XtVuRE8Y-prompt-engineer (mirror, now 410) , https://app.aiprm.com/gpts/g-5XtVuRE8Y/prompt-engineer |
| Author | `upscaile.com` | https://app.aiprm.com/gpts/g-5XtVuRE8Y/prompt-engineer |
| Description (verbatim) | "Generate superior ChatGPT prompts or improve your existing prompts. Become a pro prompt engineer, by learning and applying best prompt practices." | https://app.aiprm.com/gpts/g-5XtVuRE8Y/prompt-engineer , https://chatbotsplace.com/gpt/g-5XtVuRE8Y |
| Conversation starters (verbatim) | "Build a new prompt from scratch" and "Improve my prompt: [Paste Prompt]" | https://app.aiprm.com/gpts/g-5XtVuRE8Y/prompt-engineer |
| Popularity | No.56 in a top-500 GPT list, "1M" conversations, ★4.5 | https://github.com/AINativeLab/top-500-best-gpts (README.MD) |
| Popularity (mirror) | ~900,000 chats, rating 50770 from 11,465 raters, "2 essential tools" | https://gpt.builders/page/gpt/g-5XtVuRE8Y-prompt-engineer (via Exa index; live page returns HTTP 410) |
| Status now | Mirrors return 410 / "GPT no longer exist" | https://chatbotsplace.com/gpt/g-5XtVuRE8Y (fetched: "410 GPT no longer exist") |

### 1b. The leaked system prompt for THIS GPT: NOT FOUND (searched hard)

I could not find any public leak/mirror of the `g-5XtVuRE8Y` instructions, and I am not fabricating one. Negative results, so the parent agent can trust the gap:

- GitHub code search `"g-5XtVuRE8Y"` → only `AINativeLab/top-500-best-gpts` (a ranking list with links, no prompt text). Source: `gh search code "g-5XtVuRE8Y"` (api.github.com/search/code).
- GitHub code search `"Generate superior ChatGPT prompts"` → 0 results (no one mirrored the prompt/config).
- `linexjlin/GPTs` (leaked GPT prompts) → **no** "Prompt Engineer" file (full file listing checked). Source: https://github.com/linexjlin/GPTs/tree/main/prompts
- Leak collections `ManuelSLemos/awesome-llm-system-prompts`, `dontriskit/awesome-ai-system-prompts`, `elder-plinius/CL4R1T4S`, `asgeirtj/system_prompts_leaks` → no entry for this GPT (repo-scoped code searches).
- Mirror sites: gpt.builders → HTTP 410 Gone (live fetch), chatbotsplace → "410 GPT no longer exist", AIPRM page → only description + conversation starters (fetched).
- Wayback Machine availability API for both `gpt.builders/page/gpt/g-5XtVuRE8Y-prompt-engineer` and `chatgpt.com/g/g-5XtVuRE8Y-prompt-engineer` → `archived_snapshots: {}` (no snapshots). Source: http://archive.org/wayback/available?url=...

### 1c. Exact-clone repos: none found (searched)

Repo searches run via GitHub API (`gh search repos` / `search/repositories?q=`) with the requested terms — "prompt engineer gpt", "prompt-engineer-gpt", "prompt engineer chatgpt clone", "g-5XtVuRE8Y", "prompt engineer system prompt", "prompt engineer custom GPT", `prompt-engineer in:name` — found **no repository that clones g-5XtVuRE8Y**. Results were course notes, prompt collections, and unrelated projects. Specific checks:

- `travistang/ChatGPT-Prompt-Engineer` → **HTTP 404, does not exist** (GitHub REST `repos/travistang/ChatGPT-Prompt-Engineer`); the user `travistang` has no prompt/GPT-related repo at all (`users/travistang/repos` listing checked). Source: https://api.github.com/users/travistang/repos
- `f/awesome-chatgpt-prompts` (now **f/prompts.chat**, 171,337★) → no "Prompt Engineer" act-prompt; README only advertises a free prompt-engineering guide. Sources: https://github.com/f/prompts.chat , https://raw.githubusercontent.com/f/awesome-chatgpt-prompts/main/README.md
- `topics/prompt-engineering` top repos are guides/collections (dair-ai/Prompt-Engineering-Guide 78,646★, promptslab/Awesome-Prompt-Engineering 6,344★, etc.), not GPT clones. Source: https://api.github.com/search/repositories?q=topic:prompt-engineering&sort=stars

### 1d. Closest OSS implementations of the *idea* (prompt → engineered prompt)

| Repo | Stars / last push | What it is | Source |
|---|---|---|---|
| `mshumer/gpt-prompt-engineer` | 9,678★ / 2025-10-16 | Matt Shumer's canonical tool: generates many candidate prompts from a task description + test cases, then ranks them pairwise with an LLM judge + ELO. This is the best-known open reimplementation of "Prompt Engineer as a system". Prompt texts quoted verbatim below. | https://github.com/mshumer/gpt-prompt-engineer |
| `keirp/automatic_prompt_engineer` | 1,365★ / 2024-04-29 | Open implementation of the APE paper (instruction candidate search). | https://github.com/keirp/automatic_prompt_engineer |
| Anthropic `claude-cookbooks` metaprompt notebook | — | Official "prompt generator": a meta-prompt template that expands a task into a full system prompt (Claude's answer to this GPT genre). | https://colab.research.google.com/github/anthropics/claude-cookbooks/blob/main/misc/metaprompt.ipynb (linked from https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview) |

### 1e. Verbatim system-prompt texts found (usable as templates)

**(i) `g-5XtVuRE8Y` public text — everything that is verifiably public** (from https://app.aiprm.com/gpts/g-5XtVuRE8Y/prompt-engineer):

```
Description: Generate superior ChatGPT prompts or improve your existing prompts. Become a pro prompt engineer, by learning and applying best prompt practices.

Conversation Starters:
Build a new prompt from scratch
Improve my prompt: [Paste Prompt]
```

**(ii) mshumer/gpt-prompt-engineer — `system_gen_system_prompt`** (verbatim from https://raw.githubusercontent.com/mshumer/gpt-prompt-engineer/main/gpt_prompt_engineer.ipynb):

```
Your job is to generate system prompts for GPT-4, given a description of the use-case and some test cases.

The prompts you will be generating will be for freeform tasks, such as generating a landing page headline, an intro paragraph, solving a math problem, etc.

In your generated prompt, you should describe how the AI should behave in plain English. Include what it will see, and what it's allowed to output. Be creative with prompts to get the best possible results. The AI knows it's an AI -- you don't need to tell it this.

You will be graded based on the performance of your prompt... but don't cheat! You cannot include specifics about the test cases in your prompt. Any prompts with examples will be disqualified.

Most importantly, output NOTHING but the prompt. Do not include anything else in your message.
```

**mshumer/gpt-prompt-engineer — `ranking_system_prompt`** (verbatim, same source):

```
Your job is to rank the quality of two outputs generated by different prompts. The prompts are used to generate a response for a given task.

You will be provided with the task description, the test prompt, and two generations - one for each system prompt.

Rank the generations in order of quality. If Generation A is better, respond with 'A'. If Generation B is better, respond with 'B'.

Remember, to be considered 'better', a generation must not just be good, it must be noticeably superior to the other.

Also, keep in mind that you are a very harsh critic. Only rank a generation as better if it truly impresses you more than the other.

Respond with your ranking, and nothing else. Be fair and unbiased in your judgement.
```

**(iii) "Promptimizer: The Prompt Engineer Prompt" — Kurt Elster / Ethercycle** (full system prompt, verbatim from https://ethercycle.com/pages/the-prompt-engineer-prompt; a senior-prompt-engineer system prompt, best free-standing analogue of the target GPT):

```
<role>
You are a senior prompt engineer specializing in AI optimization.
Your job is to help users create, improve, and format prompts that
get the best results from AI assistants like Claude, ChatGPT, and others.
</role>

<workflow>
When a user provides a prompt or describes what they need:

1. Analyze - Identify what they're trying to accomplish
   and what's missing or unclear
2. Improve - Apply prompting best practices to create
   an optimized version
3. Explain - Briefly note the key changes and why they matter
</workflow>

<principles>

<principle name="clarity">
Replace vague instructions with explicit, measurable criteria.
Define success clearly so the AI knows what "good" looks like.
Tell it what TO do, not what NOT to do.
Include context it needs but might not assume.
</principle>

<principle name="structure">
Use XML tags to separate components: instructions, context,
examples, input data. Use semantic tag names that describe content.
For long prompts, place documents at top with instructions and
queries at bottom. Nest tags for hierarchy when needed.
</principle>

<principle name="examples">
Add 3-5 diverse, relevant examples when output format or
style matters. Structure examples with clear input/output pairs.
Cover edge cases in examples, not just happy paths.
Use examples from the actual domain when possible.
</principle>

<principle name="chain_of_thought">
For complex reasoning, analysis, or multi-step problems,
give the AI space to think. Use thinking and answer tags
to separate reasoning from final output. Specify the
thinking process when it matters. Skip chain of thought
for simple tasks since it adds latency without benefit.
</principle>

<principle name="output_control">
State format explicitly with structure examples.
Match prompt formatting style to desired output style.
When format control is critical, show the exact structure
you want in the prompt itself.
</principle>

</principles>

<output_formats>

<format name="improving_existing_prompt">
Respond with this structure:

<analysis>
2-3 sentences on what the prompt is trying to do and key issues
</analysis>

<improved_prompt>
The optimized prompt, properly formatted with XML tags
</improved_prompt>

<key_changes>
Bullet list of 3-5 significant improvements and why they matter
</key_changes>
</format>

<format name="creating_new_prompt">
Respond with this structure:

<understanding>
Confirm what they need in 1-2 sentences.
Ask clarifying questions if critical info is missing.
</understanding>

<prompt>
The complete prompt with proper XML structure
</prompt>

<usage_notes>
How to use it, what to customize, limitations
</usage_notes>
</format>

</output_formats>

<guidelines>
Preserve the user's intent. Improve execution, don't change goals.
Don't over-engineer simple prompts. Match complexity to the task.
If critical information is missing, ask before guessing.
Show, don't just tell. Demonstrate best practices in your output.
Keep explanations brief. The prompt itself is the main deliverable.
</guidelines>

<xml_patterns>

<pattern name="role_and_context">
<role>You are a...</role>
<context>Background information here</context>
</pattern>

<pattern name="input_data">
<documents>
  <document index="1">
    <source>filename.ext</source>
    <content>{{DATA}}</content>
  </document>
</documents>
</pattern>

<pattern name="examples">
<examples>
  <example>
    <input>example input</input>
    <o>example output</o>
  </example>
</examples>
</pattern>

<pattern name="thinking_structure">
<thinking>reasoning here</thinking>
<answer>final answer here</answer>
</pattern>

<pattern name="task_structure">
<instructions>what to do</instructions>
<constraints>rules and limits</constraints>
<output_format>how to structure response</output_format>
</pattern>

</xml_patterns>
```

**(iv) Leaked GPT "Prompt For Me" (g-jaTKZXfJ0, by hansgpt.me)** — a prompt-refinement GPT; verbatim leak from https://github.com/linexjlin/GPTs/blob/main/prompts/Prompt%20For%20Me.md (the `【oaicite:N】` markers are artifacts in the source file):

```
Hello! 😊 When crafting prompts, especially for language models like ChatGPT and Claude, it’s key to keep a few crucial steps in mind:

1. **Define the Persona**: Who is the model supposed to emulate? This helps tailor the response style and depth appropriately.
2. **Set the Context**: Provide background information that helps narrow down the type of content the model should consider.
3. **Clarify the Task and Goal**: Start with an action verb to make the desired outcome clear.
4. **Determine Essential Information**: Pin down the specifics needed for the model to generate useful and accurate outputs.
5. **Establish Constraints**: Set boundaries to guide the responses towards desired accuracy and quality.

For instance, in structured prompts for specific tasks, you might define the user’s environment, outline explicit instructions, and use examples to guide the model``【oaicite:2】``.

For ChatGPT and other LLMs, the approach involves:
- Defining and clarifying user goals and intentions.
- Confirming core and basic information needed to address the query.
- Keeping the structure concise and clear``【oaicite:1】``.

For more interactive or role-based scenarios, you could specify characters and roles for the AI to assume, ensuring a dynamic and engaging user interaction``【oaicite:0】``. This framework not only aids in maintaining a consistent style and depth appropriate to the user's needs but also ensures the AI's responses are relevant and on point! 🌟
```

**(v) Leaked GPT "Mega-Prompt" (g-NsIbKRLA1, by Aisen Lopez)** — "Generates high-quality, detailed mega prompts based on user requirements"; a full leak showing the `#CONTEXT / #ROLE / #RESPONSE GUIDELINES / #...CRITERIA / #INFORMATION ABOUT ME / #RESPONSE FORMAT` skeleton, verbatim from https://github.com/linexjlin/GPTs/blob/main/prompts/Mega-Prompt.md (abridged here to its non-task-specific skeleton — the full file adds a marketing-plan example):

```
#CONTEXT:
You are a Marketing Strategy AI, an expert in crafting comprehensive marketing plans... Your objective is to assist users in developing adaptable and effective marketing strategies...

#ROLE:
As an expert in ... development, your role is to guide the user through the process of generating a ... plan...

#RESPONSE GUIDELINES:
1. ... 9. ...

#MARKETING PLAN CRITERIA:
- The ... plan should be flexible ...
- Recommendations should be practical ...
- Emphasize creativity and differentiation ...
- The plan should be comprehensive ...

#INFORMATION ABOUT ME:
- My business: [INSERT SHORT DESCRIPTION ABOUT YOUR BUSINESS, PRODUCT/SERVICE]
- My marketing goals: [LIST YOUR MARKETING GOALS]
- My target audience: [DESCRIBE YOUR TARGET AUDIENCE]
- My budget for marketing: [SPECIFY YOUR MARKETING BUDGET]

#RESPONSE FORMAT: Provide your response in a structured outline format using Markdown for easy readability.

MOST IMPORTANT!: Give your output in an outline format.
```

---

## 2. Prompt-engineering STRUCTURING frameworks (one line + source)

| Framework | One-line description | Source |
|---|---|---|
| **CO-STAR** | Prompt scaffold from GovTech Singapore: **C**ontext, **O**bjective, **S**tyle, **T**one, **A**udience, **R**esponse — covers every factor that shapes an LLM answer's effectiveness/relevance. | https://www.tech.gov.sg/technews/mastering-the-art-of-prompt-engineering-with-empower/ ; original write-up by Sheila Teo: https://towardsdatascience.com/how-i-won-singapores-gpt-4-prompt-engineering-competition-34c195a93d41/ |
| **RTF** | Minimal three-slot template — **R**ole, **T**ask, **F**ormat — "the smallest useful structured prompt framework", ideal for reusable recurring-task templates. | https://www.promptedit.app/prompt-framework/rtf |
| **RACE** | Four-component template — **R**ole, **A**ction, **C**ontext, **E**xpectation — adds a dedicated Context slot vs RTF; "Expectation" (format/length/tone/constraints) is the most-skipped and highest-impact part. | https://www.promptedit.app/prompt-framework/race |
| **RISEN / CRISPE** | Heavier siblings of RACE cited as alternatives: RISEN adds Instructions + Narrowing; CRISPE adds Style + Examples. | https://www.promptedit.app/prompt-framework/race |
| **Chain-of-Thought (CoT)** | Include intermediate reasoning steps/exemplars in the prompt to unlock multi-step reasoning (Wei et al. 2022, arXiv:2201.11903). | https://arxiv.org/abs/2201.11903 ; https://www.promptingguide.ai/techniques/cot |
| **APE (Automatic Prompt Engineer)** | Treat the instruction as a program: an LLM proposes a pool of instruction candidates and they are searched/ranked by a score function to pick the best (Zhou et al., arXiv:2211.01910) — the academic basis for "generate N prompts, judge them" tools. | https://arxiv.org/abs/2211.01910 ; https://www.promptingguide.ai/techniques/ape |
| **Meta Prompting** | Use a prompt about prompting: an LLM (re)writes/expands a user request into a well-formed prompt using a fixed meta-template (the technique behind Claude's official metaprompt notebook and most "prompt engineer" GPTs). | https://www.promptingguide.ai/techniques/meta-prompting ; https://colab.research.google.com/github/anthropics/claude-cookbooks/blob/main/misc/metaprompt.ipynb |
| **Prompt Perfect / PromptPerfect** | Commercial "AI prompt generator and optimizer" (Jina AI) that rewrites short prompts into optimized ones — the product archetype this feature would clone; OSS analogues in §3. | https://promptperfect.jina.ai/ |
| **OpenAI's canonical developer-message skeleton** | OpenAI's own guidance orders a system/developer message as Identity → Instructions → Examples → Context (with Markdown/XML for boundaries). | https://developers.openai.com/api/docs/guides/prompt-engineering |

---

## 3. Actively maintained prompt-optimization/enhancement OSS (rewrite user prompts into engineered prompts)

Top 5 (stars & pushed_at from GitHub REST API, queried 2026-09-27):

| # | Repo | Stars | Last push | Technique |
|---|---|---|---|---|
| 1 | **linshenkx/prompt-optimizer** | 35,812★ | 2026-09-24 | **Single-LLM rewrite with built-in meta-templates**: one-click optimization, "dual mode" (system-prompt vs user-prompt optimization), multi-round iterative improvement, plus an analysis → evaluation → compare-evaluation → "evaluation-driven smart rewrite" loop; multi-model (OpenAI/Gemini/DeepSeek/Grok/…), web/desktop/Chrome/MCP. Source: https://github.com/linshenkx/prompt-optimizer (README "Core Features" / "Advanced Testing Mode") |
| 2 | **stanfordnlp/dspy** | 38,350★ | 2026-09-26 | **Metric-driven optimizer search**: `dspy.MIPROv2` bootstraps execution traces, drafts many candidate instructions ("grounded proposal stage"), then does discrete search with a surrogate model; `BootstrapFewShot` synthesizes few-shot examples; `dspy.GEPA` / `BootstrapFinetune` / `Ensemble` composable. Source: https://github.com/stanfordnlp/dspy (docs/learn/optimization/optimizers.md), paper https://arxiv.org/abs/2406.11695 |
| 3 | **gepa-ai/gepa** | 6,754★ | 2026-09-26 | **Reflective evolutionary optimization**: LLMs read full execution traces (errors, logs) to diagnose why a candidate failed, then mutate + Pareto-aware selection evolves prompts/code/agent configs against any metric ("Genetic-Pareto"). Source: https://github.com/gepa-ai/gepa , paper https://arxiv.org/abs/2507.19457 |
| 4 | **microsoft/PromptWizard** | 4,013★ | 2025-10-13 | **Self-evolving generate→critique→refine** ("feedback-driven refinement"): LLM generates, critiques and refines its own instructions, synthesizes diverse task-aware examples, and self-generates CoT steps; optimizes instructions + in-context examples in tandem. Source: https://github.com/microsoft/PromptWizard , paper https://arxiv.org/abs/2405.18369 , blog https://www.microsoft.com/en-us/research/blog/promptwizard-the-future-of-prompt-optimization-through-feedback-driven-self-evolving-prompts/ |
| 5 | **meta-llama/prompt-ops** | 1,036★ | 2026-04-21 | **Metric-driven transformation on datasets** built on DSPy: input prompt + dataset + customizable metrics → model-optimized prompt with performance metrics; adds PDO "Prompt Duel Optimizer" (label-free dueling bandits + Thompson sampling). Source: https://github.com/meta-llama/prompt-ops , paper https://www.arxiv.org/abs/2510.13907 |

Runners-up / other verified options:

| Repo | Stars | Last push | Technique |
|---|---|---|---|
| `microsoft/promptflow` | 11,240★ | 2026-08-26 | Not a rewriter per se: prompt-flow orchestration with prompt **variants**, bulk test, evaluation & tracing — the "test-and-compare" harness around prompts. https://github.com/microsoft/promptflow |
| `mshumer/gpt-prompt-engineer` | 9,678★ | 2025-10-16 | **Multi-candidate + LLM judge (ELO)**: N candidate prompts generated from description+test cases, pairwise judged (positional-bias-controlled A/B swap), ranked by ELO. https://github.com/mshumer/gpt-prompt-engineer |
| `langchain-ai/langchain` | 147,116★ | 2026-09-26 | `ChatPromptTemplate`/prompt templates + few-shot selectors (code: `libs/core/langchain_core/prompts/chat.py`) and LangSmith Hub for shared prompts (https://smith.langchain.com/hub). https://github.com/langchain-ai/langchain |
| `SalesforceAIResearch/promptomatix` | 977★ | 2026-06-02 | "Automatic Prompt Optimization Framework for LLMs". https://github.com/SalesforceAIResearch/promptomatix |
| `microsoft/sammo` | 779★ | 2025-06-23 | Structure-aware multi-objective metaprompt optimization. https://github.com/microsoft/sammo |
| `hinthornw/promptimizer` | 899★ | 2025-04-17 | Prompt-optimization experiments (LangChain lineage). https://github.com/hinthornw/promptimizer |
| Anthropic metaprompt notebook | — | — | Official prompt-generator meta-prompt. https://colab.research.google.com/github/anthropics/claude-cookbooks/blob/main/misc/metaprompt.ipynb |

**Technique taxonomy observed** (useful for the feature design):
1. **LLM rewrite with a system meta-template** — prompt-optimizer, Promptimizer, "Prompt For Me", PromptPerfect, metaprompt notebook. Cheap, one-shot, good UX fit.
2. **Multi-candidate + judge** — mshumer (ELO pairwise), prompt-ops PDO (dueling bandits). Needs test cases.
3. **Iterative generate → critique → refine (reflection)** — PromptWizard, GEPA, prompt-optimizer's "multi-round iterative improvement".
4. **Metric-driven search over prompts (+ few-shot synthesis)** — DSPy MIPROv2, sammo, promptomatix, prompt-ops. Needs dataset + metric.

---

## 4. What a high-quality "Prompt Engineer" assistant's OUTPUT contains — checklist

Derived from the artifacts in §1–§2 (each item sourced):

**A. Pre-output / intake (when info is missing)**
- [ ] Confirm intent in 1–2 sentences ("understanding" section). Src: Promptimizer `<understanding>` (https://ethercycle.com/pages/the-prompt-engineer-prompt)
- [ ] **Ask clarifying questions before guessing** if critical info is missing. Src: Promptimizer `<guidelines>` ("If critical information is missing, ask before guessing") and `<understanding>` ("Ask clarifying questions if critical info is missing").
- [ ] Diagnose what's missing/unclear in the rough prompt before rewriting. Src: Promptimizer `<workflow>` step 1 "Analyze".

**B. The engineered prompt itself (the main deliverable)**
- [ ] **Role/Identity** — who the model is (persona, domain, seniority). Src: OpenAI "Identity" section (https://developers.openai.com/api/docs/guides/prompt-engineering); RACE "Role" (https://www.promptedit.app/prompt-framework/race); Prompt For Me step 1 (linexjlin/GPTs).
- [ ] **Context/background** — scenario, audience, proprietary data. Src: CO-STAR "Context" (https://www.tech.gov.sg/technews/mastering-the-art-of-prompt-engineering-with-empower/); dair-ai "Context" element (https://www.promptingguide.ai/introduction/elements); OpenAI "Context" section.
- [ ] **Task/Objective** — explicit action verb + object. Src: CO-STAR "Objective"; RTF "Task" (https://www.promptedit.app/prompt-framework/rtf); Prompt For Me step 3 ("Start with an action verb").
- [ ] **Constraints / rules / boundaries** — what to do and never do, limits. Src: Prompt For Me step 5 ("Establish Constraints"); Promptimizer `<pattern name="task_structure">` `<constraints>`; OpenAI "Instructions" ("What rules should it follow? ... what should the model never do?").
- [ ] **Style** and **Tone** (when they matter). Src: CO-STAR "Style"/"Tone".
- [ ] **Audience**. Src: CO-STAR "Audience".
- [ ] **Output format / response spec** — structure, length, deliverable shape (most-skipped, highest-impact). Src: CO-STAR "Response"; RTF "Format"; RACE "Expectation" ("the component most people skip"); dair-ai "Output Indicator".
- [ ] **Examples / few-shot** — 3–5 diverse input/output pairs, incl. edge cases, domain-real. Src: Promptimizer `<principle name="examples">`; OpenAI "Examples" section.
- [ ] **Thinking scaffolds for complex tasks** — `<thinking>/<answer>` or CoT steps (skip for simple tasks). Src: Promptimizer `chain_of_thought` principle; CoT paper https://arxiv.org/abs/2201.11903.
- [ ] **Success criteria / definition of "good"** — explicit, measurable. Src: Promptimizer `clarity` principle ("Define success clearly so the AI knows what 'good' looks like"); Anthropic "Before prompt engineering: a clear definition of the success criteria ... empirical tests" (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview).
- [ ] **Deliberate structure** — XML tags or Markdown sections separating instructions / context / examples / input data; docs at top, instructions+query at bottom for long prompts. Src: Promptimizer `structure` principle + `<xml_patterns>`; OpenAI "Markdown formatting and XML tags" guidance.

**C. Meta output around the prompt**
- [ ] **`<analysis>`** — 2–3 sentences on what the original tried to do and its key issues. Src: Promptimizer `improving_existing_prompt` format.
- [ ] **`<key_changes>`** — 3–5 significant improvements and why they matter. Src: Promptimizer `improving_existing_prompt` format.
- [ ] **`<usage_notes>`** — how to use it, what to customize, limitations. Src: Promptimizer `creating_new_prompt` format.
- [ ] **Judgment rules**: preserve user intent ("Improve execution, don't change goals"); don't over-engineer simple prompts; show don't just tell; keep explanations brief (prompt is the main deliverable). Src: Promptimizer `<guidelines>`.
- [ ] **Testing hook** — suggest how to verify (test cases, side-by-side compare, evals). Src: Anthropic "Some ways to empirically test against those criteria" (docs URL above); prompt-optimizer's "analysis, single-result evaluation, and multi-result compare evaluation" (https://github.com/linshenkx/prompt-optimizer); mshumer's test-case + ELO ranking loop.

**Interaction model of the target GPT** (for parity): two entry points — "Build a new prompt from scratch" and "Improve my prompt: [Paste Prompt]" (https://app.aiprm.com/gpts/g-5XtVuRE8Y/prompt-engineer), i.e. create-mode and improve-mode — exactly the two `<output_formats>` in the Promptimizer template.

---

## Confidence & gaps

**High confidence (fetched/queried directly this session):** all GitHub star counts and push dates (GitHub REST API, 2026-09-27); mshumer's two system prompts (raw notebook fetched); Promptimizer full text (page fetched); "Prompt For Me" & "Mega-Prompt" leaks (raw GitHub fetched); CO-STAR definitions (tech.gov.sg + Towards Data Science fetched); RACE/RTF definitions (promptedit.app fetched); APE & CoT abstracts (arXiv pages fetched); dair-ai prompt elements (raw MDX fetched); DSPy optimizer mechanics (repo docs fetched); PromptWizard/GEPA/prompt-ops/prompt-optimizer techniques (their READMEs fetched).

**Medium confidence:** the gpt.builders popularity stats (~900K chats, 50,770 rating) come from a search-engine snippet — the live page now returns 410 so I could not re-verify; AIPRM's "32 73.9K 35" counter block was not disambiguated; the GPT's current status (removed vs. just delisted from mirrors) is inferred from 410s on mirrors, not from OpenAI (the real chatgpt.com page requires login and is not archivable).

**Gaps / caveats:**
1. **No leaked system prompt for `g-5XtVuRE8Y` exists in any source I could reach** (Exa index, GitHub code search, Wayback, 4 major leak collections all negative). If the feature needs that exact text, it will have to be reconstructed from behavior or obtained from a logged-in ChatGPT session. The Promptimizer template (§1e-iii) is the closest high-quality, freely-licensed-by-publication substitute.
2. **No true clone repo exists** for this GPT; `travistang/ChatGPT-Prompt-Engineer` is a 404 and `f/awesome-chatgpt-prompts` has no such prompt. The de-facto OSS equivalents are `mshumer/gpt-prompt-engineer` and the prompt-optimizer apps in §3.
3. **Tooling limits:** the built-in `web_search` tool was unusable (no API key) and Exa (mcporter) hit its free rate limit partway through; web discovery after that used direct URL fetches and GitHub search only. Two DuckDuckGo HTML queries returned empty result lists. A few source URLs (LangChain's docs) 404'd due to doc-site migration, so LangChain claims rest on GitHub code paths + smith.langchain.com/hub returning HTTP 200.
4. Star counts are a point-in-time snapshot; langchain (147k★) is listed as a runner-up rather than a "prompt rewriter" since it is a general framework.
