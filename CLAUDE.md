# Orchestra Swarm Engine

## 🤖 System Prompt for AI Assistants
**You are an expert AI Full-Stack Software Engineer with deep expertise in Next.js 15 (App Router), TypeScript, Zustand, and Vercel AI SDK.** 
When working on this repository, you must strictly follow these rules:
- Write robust, self-healing, and defensive code.
- Avoid introducing technical debt. If a pattern exists in the codebase (e.g., `safeWriteFile`), you MUST use it rather than reinventing standard Node.js libraries.
- Prefer explicit TypeScript typing over `any` or implicit inference.
- Do not remove existing comments unless explicitly refactoring the commented logic.
- **Consult `POST_MORTEMS.md`** before refactoring core logic (especially SSE streams, MoA, or file storage) to avoid repeating known historical bugs.

### 📚 Mandatory reading order (before any non-trivial change)

1. This file (`CLAUDE.md`) — architectural rules and contracts.
2. [`docs/request-flow.md`](./docs/request-flow.md) — end-to-end lifecycle of a user message: API entry → agent context → tools → prompts → MoA → response stream. The single best document for understanding how a request flows; everything else assumes you know this.
3. [`POST_MORTEMS.md`](./POST_MORTEMS.md) — every entry whose subsystem you are about to touch.
4. The actual source of the symbol you are changing (`agent.ts`, `moa.ts`, `tool.ts` are large — search for the function, do not skim).

If you cannot answer "what does the request flow look like for the change I am about to make?" — go read `request-flow.md` before writing code.

> **✅ DONE (2026-06): the Context-Management track.** A1–A4 + A3b + real tokenizer + OpenRouter exact windows ALL shipped (A1–A3 + MoA loop-guard committed `e4b30f0`/`8a20839`; A4/A3b/tokenizer/OpenRouter-windows in the working tree, full suite + build green). No remaining sprints. The "🧵 Context-Management Track" section below is now the reference for the contracts in force — do not regress them.

> **🚧 OPEN — next-session handoff (updated 2026-06-22, post-merge).** Four PRs landed on `main` this session (all merged + branches deleted): **PR #16** (Sprint 1 bypass double-gen + Sprint 2a/2b MoA aggregator collapse + PM #76 loop-guard & governor anchor + PM #77 proposer no-tools + scripts/e2e typecheck coverage + data-backups exclude), **PR #15** (PM #78 backup `fs.cp` race + PM #79 MoA Router output cap — renumbered from #76/#77 on rebase to resolve the number collision with PR #16), **PR #17** (Sprint 2c — flipped the inline-synthesis collapse default ON via `DEFAULT_SETTINGS`; item 1), and **PR #18** (post-collapse Sprint 1 — surface an unusable embeddings model in `/api/health`; item 4). Gates green on `main`: `npm run typecheck` 0 (main + node-side via `tsconfig.node.json`), `npm run lint` 0 errors, full suite **2768 tests**, all CIs (lint/typecheck/tests + Playwright E2E) passed. Unfinished work, priority order:
>
> 1. ✅ **DONE (2026-06-22) — Sprint 2c flipped `inlineSynthesis` default ON.** Mechanism: `DEFAULT_SETTINGS.aggregator = { mode: "synthesis", inlineSynthesis: true }` ([`settings-store.ts`](src/lib/storage/settings-store.ts)) — NOT a gate change. The [`moa.ts`](src/lib/agent/moa.ts) gate stays `=== true`, so every `getSettings()` caller (= all production) collapses by default, while a unit test passing `fakeSettings()` directly keeps the standalone aggregator unless it opts in (a gate-level `?? true` flip broke ~15 aggregator-path tests; the DEFAULT_SETTINGS route kept them green). Backed by the N=8 live A/B (deepseek-v3, OpenRouter): **quality held**, **latency −31%**, completion tokens −16%, cost −3.8%; collapse 8/8 ON vs aggregator 8/8 OFF; answers equivalent/marginally-better incl. code/long-form/contentious. Tests: `moa.test.ts` (absent-flag → aggregator, explicit-`false` opt-out) + DEFAULT_SETTINGS pin in `settings-store.test.ts`. Docs synced: README MoA prose + mermaid note, `docs/moa-aggregator-collapse.md` §header/§9.1/§10, §1 below. **Opt out: `aggregator.inlineSynthesis: false`.** (The trace-quality score the original plan named was a weak proxy — 1.000 on both arms — so quality was judged by the answers + the latency/token deltas.)
> 2. **Tournament collapse — deferred micro-sprint.** [`docs/moa-aggregator-collapse.md`](docs/moa-aggregator-collapse.md) §9.3/§10. Collapse the tournament path (it returns a verbatim winning draft, no synthesis) into the final stream via a "stream-a-fixed-string" mechanism. Orthogonal to the synthesis collapse; deliberately left out of Sprint 2 (the gate is `aggregatorMode === "synthesis"`).
> 3. **Swarm-ON vs swarm-OFF value measurement — open question, NOT started.** 2c only compared collapse ON/OFF, BOTH with swarm ON; there is NO data on MoA vs a single agent. Hypothesis: on simple/consensus prompts (every 2c prompt had `disagreement=false`, trace score 1.000) the swarm ≈ one good agent; it earns its token/latency cost on contentious / multi-faceted / fact-sensitive tasks where the forced Skeptic + diverse drafts catch what a single pass misses (the Router bypass already encodes this). To answer: same prompts (add hard/contentious/fact-sensitive) single-agent vs MoA, judge quality (LLM-judge or eyeball) + tokens/latency.
> 4. **Embeddings unconfigured — now VISIBLE (PR #18, Sprint 1); enablement is still an operator decision.** PR #18 added the `embeddings_model` `/api/health` subsystem (`warn` via `isModelKeyConfigured` in `llm-provider.ts`) so the silent degradation of RAG memory search / disagreement detection (PM #39) / trace-memory (PM #51) is no longer invisible. The operator's `embeddingsModel` (`google/gemini-embedding-001`, no key) is still UNUSABLE — to actually enable those features, set a local Ollama config `{ provider: "ollama", model: "nomic-embed-text", dimensions: 768 }` (model already pulled) + `traceMemory.enabled: true`, OR add a cloud embeddings key. Operator decision.
> 5. **gemini-2.5-flash residual proposer flakiness (PM #77 mitigated, not eliminated).** The no-tools directive recovered most empties (1/3→2/3 live), but the qa_auditor/skeptic persona can still occasionally return `(empty draft)` on tool-demanding prompts — model variance, not a regression. The "extraction ignores the reasoning channel" theory was DISPROVEN by isolation repro (gemini-2.5-flash and deepseek-r1 both populate `.text`) — see PM #77.
> 6. **Untracked, intentionally unstaged:** `.obsidian/` (editor config — consider adding to `.gitignore`) and `tests/e2e/manual-check-model-wizard.spec.ts` (WIP). NOTE: the older "model-wizards WIP on `qa/sprint3-model-wizards`" note in the Context-Management Track section below is a DIFFERENT branch/track — unrelated to the work above.

> **✅ DONE (2026-06-23) — `replace_in_file` Hardening & CRLF Protection.** 
> Completely rewrote the `replace_in_file` tool implementation to fix Regex vulnerabilities (swapped `String.replace` for `split.join`), added Smart CRLF detection to prevent git diff pollution on Windows repos, and enforced `TEXT_FILE_WRITE_MAX_CHARS` limits. Added 11 exhaustive unit tests covering all paths including ENOENT, EACCES, syntax checking, and type checking. ALL tests pass (`npx vitest run src/lib/tools/replace-in-file.test.ts` and `npx tsc --noEmit`).
> **Model Instruction:** When opening a new dialogue window, ALWAYS prefer `replace_in_file` over `write_text_file` for targeted partial edits to avoid token-limit truncations. You can verify its logic in `src/lib/tools/tool.ts` and tests in `src/lib/tools/replace-in-file.test.ts`.

---

> **🚧 OPEN — completion-OVERCLAIM bug + UNPUSHED loop/stall fixes (handoff for a fresh empty-context session, 2026-06-22 "session B").** Self-contained: act on this without the prior chat.
>
> **A. SHIPPED but UNPUSHED — branch `feat/write-grounding-pm80` (2 commits, NOT pushed, NOT merged to `main`):**
> - `83092a8` — **PM #80**: syntax-grounding signal on `write_text_file` ([`post-write-verify.ts`](src/lib/tools/post-write-verify.ts)) + chat-scoped per-file rewrite budget ([`write-rewrite-budget.ts`](src/lib/tools/write-rewrite-budget.ts)). Fixes the original P1 loop: a model emitting corrupted source rewrote it blindly forever because `write_text_file` returned only `{success,bytes}` with no validity signal; the byte-identical loop guard missed it (drifting rewrites never repeat the `(tool+args)` key, loop spans turns stitched by "continue").
> - `ffd60f2` — **honest step-cap pause** + `MAX_TOOL_STEPS_PER_TURN` 30→50 (subordinate 25). When a turn EXHAUSTS the step budget WITHOUT delivering an answer, `resolveTurnContinuation` ([`agent-response.ts`](src/lib/agent/agent-response.ts)) returns a DETERMINISTIC "reached step limit — press Continue" notice instead of a forced model "final answer" that masqueraded as completion. Threaded via `stepLimitReached` from `agent.ts` streamText `onFinish` (`event.steps.length >= cap`). See §3 "Per-turn step budget + honest pause".
> - Local gates green (typecheck 0, lint 0 errors, new suites pass). **First action:** run `npx vitest run` (full suite), then `git push -u origin feat/write-grounding-pm80` + open a PR. The operator merges PRs.
>
> **B. OPEN BUG to fix — completion OVERCLAIM (distinct from A; NOT yet started).** The agent calls the `response` tool declaring a task COMPLETE while its OWN last verification FAILED. Live evidence (chat `data/chats/a8e1a43c-….json`): the model ran `npx tsc --noEmit` → `Exit code: 2` with real errors (`Cannot find name 'None'`, `Cannot find module './index.css'`, `TS1005 ';' expected`), then wrote "Excellent! All the TypeScript code compiles without errors" and called `response("# Sprint 3 … COMPLETED SUCCESSFULLY ✅")`. Turn ended normally; operator sees "it stopped" with a broken project. **NOT a crash, NOT the step cap (pause notice fired 0×), NOT the PM #80 loop** — the grounding signal IS working (`syntaxValid:false` fires and the model reacts), but the model IGNORES failing verification for its FINAL completion claim. Root cause: the "completion-grounding gap" — nothing forces the agent to PASS verification before claiming done.
>
> **C. PROPOSED FIX + SKEPTICAL AUDIT (operator asked for the audit recorded — do NOT ship the naive version):**
> - **Proposal:** on a `response`-completion, if the LAST verification command in the turn had a non-zero exit, append a deterministic system note ("⚠️ last typecheck/test exited N — completion may be premature"). Same philosophy as the honest step-cap pause: a deterministic SYSTEM signal when the model's claim contradicts verified state.
> - **Audit — weaknesses:** (1) **Detection is fragile and glossed over.** "Last command exited non-zero" ≠ "verification failed": `grep` exits 1 on no-match, `test`/`[ ]` exit 1 normally, `git diff --exit-code` exits 1 on a diff. Naive "non-zero = broken" → false-positive warnings. MUST narrow to a WHITELIST of unambiguous checks (`tsc --noEmit`, `npm test`/`vitest`/`jest`/`pytest`, `npm run build`, `eslint`) and bias to false-NEGATIVES (miss an unknown check) over false-positives. (2) **Advisory only — does NOT stop the overclaim**, just bolts a caveat onto a "✅ done" already emitted. (3) **Model-reasoning failure, not a missing Orchestra signal** — the tsc errors WERE in context; the model chose to claim success. Orchestra can surface the contradiction, not make the model reason honestly. (4) **Narrow applicability** — only code tasks with a check; inert for Q&A/writing/research. (5) **Hard-gate variant (block `response` on a failing check) REJECTED** — unreliable detection → false-positive blocks; nonsensical for non-code tasks.
> - **Alternatives to weigh:** (a) **Prompt-level mandate** ([`src/prompts/system.md`](src/prompts/system.md)), cheapest: "Do NOT call `response` claiming completion if the most recent build/test/typecheck you ran did not pass; fix it or report the failure honestly." Targets honesty directly, no fragile parsing; soft but high value/low cost. (b) **Existing reflection subsystem** (generator→critic→revisor, `reflection.ts`/`moa.ts`) already exists for "you said done but it isn't" — a completion-critic pass may be the right lever (heavier: extra LLM call). (c) Operator runs `qwen/qwen3-coder`; overclaiming is partly model quality — a stronger orchestrator model + (a) may dissolve it without code.
> - **RECOMMENDED path:** ship (a) the prompt mandate FIRST (cheap, targets the behavior) PLUS a NARROW whitelist-based deterministic surface note (the audited proposal, false-negative-biased) as a visibility backstop. Defer reflection-critic (b) unless (a)+surface prove insufficient. Do NOT ship the hard-gate.
> - **Files/symbols:** turn-end is `agent.ts` streamText `onFinish` (scan `event.response.messages` for the last whitelisted check + exit code) → thread into `resolveTurnContinuation` ([`agent-response.ts`](src/lib/agent/agent-response.ts)) beside the existing `stepLimitReached`; `response` tool in [`tool.ts`](src/lib/tools/tool.ts); prompt mandate in [`src/prompts/system.md`](src/prompts/system.md). Regression: extend [`final-answer-guard.test.ts`](src/lib/agent/final-answer-guard.test.ts). **Verify LIVE** (§9 rule — unit tests miss the wire): a real chat where a check fails, then the model tries to claim done. If shipping the fix touches core orchestration, add a `POST_MORTEMS.md` entry (next free number is **#81**) per §7.
>
> **NOTE — scope boundary on the live repro chat:** the `a8e1a43c` chat builds a project named `telegramattacker` (a Telegram userbot mass-message/flood tool with obfuscation payloads). It is ONLY the loop/overclaim reproduction vehicle — diagnosing Orchestra's AGENT behavior (loop, pause, overclaim) is in scope; building/debugging/restoring that project's source is NOT. Keep the fix work on the Orchestra engine, not the repro's contents.

---

## 🛠 Tech Stack
- **Framework:** Next.js 15.5 (App Router, Turbopack)
- **Language:** TypeScript 5.x (Strict Mode)
- **State Management:** Zustand v5 (Frontend), Local JSON Filesystem DB (Backend)
- **AI Integration:** Vercel AI SDK (`ai`, `@ai-sdk/react`, `@ai-sdk/openai`, `@ai-sdk/anthropic`)
- **Styling:** Tailwind CSS v4, Radix UI Primitives, `class-variance-authority`
- **Testing:** Vitest, Playwright

---

## 📂 Architecture & Folder Structure Mapping

```text
/src
├── app/                  # Next.js App Router endpoints
│   ├── api/chat/         # Core API entrypoint (POST /api/chat) + history (GET /api/chat/history?id=...) + abort
│   ├── api/events/       # SSE (Server-Sent Events) endpoint for realtime UI
│   └── api/{projects,goals,memory,knowledge,settings,...}/  # Domain CRUD endpoints
├── components/           # React UI components (Tailwind + Radix)
│   ├── chat/             # Chat UI, tool output rendering, DAG visualization
│   └── ui/               # Reusable UI primitives (buttons, inputs, dialogs)
├── hooks/                # React hooks (e.g., use-background-sync.ts)
├── store/                # Zustand global state (app-store.ts)
├── prompts/              # Static prompts: system.md (orchestrator) + tool-*.md (per-tool guidance)
└── lib/                  # Core backend logic
    ├── agent/            # Swarm orchestrator (agent.ts), MoA, Daemon, ghost-sweeper, compressor, reflection
    ├── memory/           # Vector DB, embeddings, Project Blackboard
    ├── storage/          # JSON filesystem adapters (chat-store, project-store, fs-utils)
    ├── tools/            # AI tools (code-execution, web-search, MCP integrations)
    ├── realtime/         # Server-side event bus (event-bus.ts)
    └── cron/             # Cron runtime (runtime.ts) for scheduled jobs
```

For the layout of the JSON-on-disk database under `data/`, see "💾 Data Layout" further below.

---

## 🧠 Core Agentic Subsystems (New Architecture)

### 1. Mixture-of-Agents (MoA) Ensemble (`src/lib/agent/moa.ts`)
- **Dynamic Persona Generation (DPG):** Instead of static roles, the Router dynamically spawns 3-5 hyper-specialized experts based on the exact user prompt.
- **Single source of truth for activation: the UI toggle `swarmEnabled`.** When the user enables Swarm, MoA always runs — `agent.ts:runAgent` does NOT regex-filter the message. (See PM #9 — an earlier `queryNeedsMoA` regex on the entry path silently overrode the UI for non-whitelisted verbs and was removed.)
- **Internal Bypass (Router decision, NOT a UI override):** the Router inside MoA may set `requiresSwarm: false` for trivial prompts and answer directly from a single model — saves tokens on "thanks" / "hi" without spinning up 3–5 proposers. This is an *internal* MoA optimization; it never bypasses the user's intent to use Swarm. Note: a weak `utilityModel` (the Router runs on `settings.utilityModel`) can mis-classify substantive prompts as trivial — if you see surprising direct answers under Swarm-ON, upgrade `utilityModel` from a free/low-quality model to something stronger.
- **Force Swarm escape hatch (user override of the Router — PM #22):** the UI exposes a `forceSwarm` toggle (amber "Force" pill in [`src/components/chat/swarm-config.tsx`](src/components/chat/swarm-config.tsx), only visible when Swarm is ON). When set, `runMoAEnsemble` ignores `dpgResult.requiresSwarm` and always fans out the proposers. Wired end-to-end through Zustand → `chat-panel` body → `/api/chat` → `runAgent` → `runMoAEnsemble` for the **interactive** transport AND through `dispatchAgentJob` → `runBackgroundJob` → `runAgent` for the **background / Auto-Pilot** transport (the second path was added in the 2026-05 audit follow-up after it was discovered to silently drop the override — see PM #22 closing notes). The persisted `data/queue/<chatId>.json` entry written by `enqueueJob` carries `forceSwarm` too, so a server restart mid-Auto-Pilot resumes with the override intact. **Rule:** any *user-facing* feature toggle that can be short-circuited by an *internal* optimisation must ship with a `force<Feature>` escape hatch in the same PR — and that escape hatch must be threaded through EVERY dispatch path (interactive stream, background dispatch, queue persistence, daemon recovery), not just the one the original PR exercised. If a future PR adds another inner gate that can countermand user intent, add the matching override alongside it and audit every dispatch entry-point — do not wait for a user to report the silent override.
- **Zero-Latency Fact-Checking:** One of the DPG roles is *always* forced to be a "QA Auditor / Skeptic" who fact-checks claims in parallel with the other proposers.
- **Tool-less proposers must be TOLD they're tool-less (PM #77).** Proposers run without tools by default (search_web only with a key — PM #68; code_execution only on opt-in — PM #50). `augmentProposerPromptForTools` ([`moa-proposer-tools.ts`](src/lib/agent/moa-proposer-tools.ts)) appends `PROPOSER_NO_TOOLS_DIRECTIVE` for an empty/undefined toolset — the proposer-side mirror of PM #61's `PLAIN_CHAT_TOOL_OVERRIDE`. Without it, a tool-demanding user prompt ("run the code", "use the code_execution tool", "search…") makes non-code personas return `(empty draft)` instead of reasoning in prose; empties are dropped by `isSuccessfulDraft`, shrinking the ensemble below the ≥2 the inline-synthesis collapse needs. NB: this is NOT a reasoning-channel/`.text`-extraction bug — gemini-2.5-flash and deepseek-r1 both populate `.text` fine; the trigger is the tool demand, confirmed by isolation repro.
- **Aggregator Constraint:** The Aggregator must NOT be fed consecutive user messages (crashes strict models like Gemma).
- **Inline-synthesis collapse (Sprint 2 — [`docs/moa-aggregator-collapse.md`](docs/moa-aggregator-collapse.md)):** the ensemble's output is NEVER terminal — `runAgent` always runs a final tool-capable `streamText` afterward. On the swarm path that historically meant TWO brain generations per turn (aggregator `generateText`, then the stream re-synthesizing the same drafts). Behind **`settings.aggregator.inlineSynthesis` (default ON since the 2c flip — `DEFAULT_SETTINGS` ships it `true`, so the gate's literal `=== true` is satisfied for every `getSettings()` caller)**, the default synthesis path SKIPS the separate aggregator: `runMoAEnsemble` returns `MoAResult.synthesisHandoff` (drafts + PM #39 marker + `TraceSignals`) instead of a finished `text`, and `agent.ts` injects the ported directive ([`src/prompts/synthesis-inline.md`](src/prompts/synthesis-inline.md) via `loadSynthesisInlineDirective`) + the drafts (`buildInlineSynthesisInjection`) into the SYSTEM prompt (NOT a second user turn — the Aggregator Constraint above) so the existing final stream synthesizes inline — ONE brain generation, and it can call tools mid-synthesis. **Gated narrowly:** only `aggregatorMode === "synthesis"` && reflection OFF && ≥2 successful drafts. Reflection (inherently multi-pass) and tournament (verbatim winner) paths are untouched; a tournament→synthesis fallback keeps `mode === "tournament"` so it does NOT collapse. Trace-memory capture relocates to the stream's `onFinish` on this path (signals plumbed up via `synthesisHandoff`). **Default ON since the 2c flip (2026-06-22)**, after the N=8 live A/B (quality held, latency −31%, completion tokens −16%); opt out with `aggregator.inlineSynthesis: false`. To toggle the production default, change `DEFAULT_SETTINGS.aggregator.inlineSynthesis` (the gate keeps `=== true`).

### 2. Project Blackboard (`src/lib/memory/blackboard.ts`)
- **Shared Fact Storage:** Agents write to `.orchestra_blackboard.json` using vector embeddings. This allows independent agents to share and retrieve canonical truths across the entire project lifecycle without relying on linear chat history.

### 3. Fact-Checking Mandate (`src/prompts/system.md`)
- The Orchestrator operates under a strict mandate: *Never guess library versions or syntax*. If the `search_web` tool is available, the agent MUST use it to verify documentation before streaming code.

### 4. Loop Guard Middleware ([`src/lib/agent/tool-guard.ts`](src/lib/agent/tool-guard.ts) — `applyGlobalToolLoopGuard`)
- The middleware lives in [`tool-guard.ts`](src/lib/agent/tool-guard.ts) as `applyGlobalToolLoopGuard()` and wraps every `ToolSet` before it reaches `generateText`. It was extracted from `agent.ts` (the §10 `agent-tools.ts` seam, 2026-06) precisely so BOTH `agent.ts` AND `moa.ts` (proposer tool loops) can share ONE guard without an import cycle — it imports only leaf modules (`agent-response`, `event-bus`, `token-governor`), never `agent.ts`/`moa.ts`. The A3 per-tool output cap (`capToolResultSize`) is applied at the guard's return. [`tool-guard.test.ts`](src/lib/agent/tool-guard.test.ts) exercises the REAL exported function (throw→self-heal, output cap, dedup); the older `loop-guard.test.ts` inlines a copy of the conversion logic.
- **Contract:** tools wrapped by the guard must return `{ success: false, error: "..." }` on failure rather than throwing. Throwing kills the run; returning lets the agent self-heal in the next iteration.
- **Universal repeat guard (PM #76).** Beyond the fast consecutive-identical-FAILURE block (`lastDeterministicFailure`), the guard maintains a bounded ring `recentCallKeys` and blocks — WITHOUT executing — when the same `(toolName + stableSerialize(args))` key recurs ≥ `REPEAT_BLOCK_THRESHOLD` (3) within `REPEAT_WINDOW` (8) calls. This catches the loops the failure-only check missed: identical-success spam (`write_text_file` with the same args) AND `A(success)→B(error)→A(success)→B(error)` alternation (a success leg used to reset the failure memory, so B's repeat always looked "fresh"). Keyed on serialized args → a legitimate fix-loop that CHANGES content each pass is NOT flagged. `isPollLikeCall` (`process` poll/log) is EXEMPT — it owns the separate no-progress backoff (threshold 16). **Rule:** loop detection must key on `(tool+args)` recurrence over a window, independent of success/failure; never let a success between two identical failing calls reset the detector. The audit's companion "context GC / dedup" idea was measured and SKIPPED — `governMessages` Stage 1 already drops old duplicate tool results pair-safely while keeping anchors (a naive splice would break tool-call↔tool-result pairing → provider 400).
- **When refactoring:** every code path that builds a `ToolSet` for an agent invocation MUST pipe it through `applyGlobalToolLoopGuard` before passing to `generateText`. To audit, run `grep -rn applyGlobalToolLoopGuard src/lib/agent/` — every callsite that constructs tools (in `agent.ts` AND `moa.ts`) should appear. Adding a new `runAgent`-like flow OR a new MoA proposer/aggregator tool path without the wrap silently re-introduces fatal-throw behavior. The MoA **proposer** path was exactly this gap until 2026-06: a throwing tool was caught by the per-proposer try/catch and silently DROPPED that proposer's draft instead of self-healing — now fixed (`moa.ts` wraps `proposerTools`). The **aggregator** tool path, if it ever gains tools, must wrap too.
- **Multi-step tool loops use `stopWhen: stepCountIs(n)`, NEVER `maxSteps` (PM #65).** AI SDK v5+ removed `maxSteps` from `generateText`/`streamText` and defaults to `stepCountIs(1)`. A call that passes tools and must take more than one step (tool call → result → final answer) and omits `stopWhen` stops after step 1, returning empty text — the proposer/agent silently produces nothing. If you find yourself reaching for `@ts-expect-error` on an SDK option, first confirm the option still exists in the installed `ai` version (`grep <option> node_modules/ai/dist/index.d.ts`).

### 5. Tool-Capability Detection — Single Source of Truth (PM #17)
- Whether to forward `tools` to a given (provider, model) pair is decided by **`modelSupportsTools(provider, modelId)` from [`src/lib/providers/tool-support.ts`](src/lib/providers/tool-support.ts)**. The exported `NO_TOOL_PATTERNS` list is the only place to add new "this model 404s on tool calls" entries.
- **Why this matters:** PM #17 was caused by `agent.ts` having two parallel inline branches (Ollama + OpenRouter) that drifted apart. The Ollama branch consulted the full pattern list; the OpenRouter branch checked only `deepseek-r1`. A user picking `google/gemma-4-31b-it` via OpenRouter got 63 tools forwarded → OpenRouter returned 404 "No endpoints found that support tool use" → the agent died silently AFTER MoA had already produced a consensus, so the operator saw "Swarm crashed" with nothing in the UI for days.
- **Rule:** never write `if (provider === "X") { supportsTools = !modelId.includes("Y") }` inline anywhere in the agent path. Always go through the helper. The Ollama branch stays special-cased because it does a live `/api/show` capability probe, but it ALSO falls back to the helper on probe failure — the helper is universal. New providers are one-liners.
- **When you discover a new model that 404s on tools:** add the substring to `NO_TOOL_PATTERNS` (only). The universal cross-provider regression test in [`tool-support.test.ts`](src/lib/providers/tool-support.test.ts) will fail until you also write a positive case there. That keeps the two branches honest.
- **Tight prefixes only.** When you add a new pattern, prefer the narrowest substring that catches the failing family. Recent additions (2026-05): `qwen-2.5-coder` / `qwen2.5-coder` / `qwen-coder` for the coder-line (confirmed live OpenRouter 404), and `qwen-vl` / `qwen2-vl` / `qwen2.5-vl` for vision-language Qwen. **Do NOT broaden to bare `qwen-` or `llama` — generic Qwen-Instruct/Qwen3 and Llama-3.x DO support tool calling**; the broad match would disable tools for the most-used families and is the inverse PM #17.
- **Final-answer delivery is fragile — always unwrap + branch the prompt (PM #61).** The agent ships its answer via a `response` tool, but models routinely emit that call as TEXT instead of a native tool call: tool-capable models (deepseek under MoA) emit a fenced JSON blob `{"call":"response","arguments":{"message":"…"}}`; non-tool models emit `<call:…/>`. Two invariants protect the answer:
  1. **Unwrap at persistence.** `unwrapSerializedResponseCall` in `agent.ts` runs inside `convertModelMessageToChatMessages` (the single chokepoint for both stream and non-stream paths). It conservatively detects a whole-text serialized `response` call and returns the inner `message`; anything else passes through. Any new path that persists an assistant message MUST route through this conversion — do not hand-roll message persistence that skips the unwrap.
  2. **Plain-chat gets a different prompt.** When `useTools=false`, append `PLAIN_CHAT_TOOL_OVERRIDE` (`prompts.ts`) so the model is told to ignore the tool/`response`-tool/`<call:…>` instructions and answer in prose. Never feed the tool-mode system prompt to a no-tool model — it produces `<call:…>` garbage. Regression: [`unwrap-response.test.ts`](src/lib/agent/unwrap-response.test.ts). **Rule:** any mechanism requiring structured model output needs a text-level fallback parser; any capability-gated feature needs a distinct prompt for the no-capability path.

### 6. Memory & RAG Loaders — UTF-8 Invariant (PM #18)
- Every document loader under [`src/lib/memory/loaders/`](src/lib/memory/loaders/) MUST return UTF-8 text. The chunker → embedder pipeline operates on UTF-8 bytes throughout; feeding UTF-16 or any other encoding produces silent vector corruption (no error, no log signature — just unsearchable knowledge).
- **Why this matters:** PM #18 — `xlsx-loader.ts` originally called `XLSX.utils.sheet_to_txt` which emits UTF-16 LE with a BOM. The result was `A·l·i·c·e` mojibake with NULL bytes between every glyph; RAG over Excel sources returned irrelevant matches for weeks before anyone noticed.
- **Rule for new loaders:** the unit test MUST include a non-ASCII round-trip (Cyrillic / Chinese / emoji) and assert the output contains no ` ` NULL byte and does not start with a UTF-16 BOM (`﻿` at offset 0). Library helpers that "just return text" are not implicitly UTF-8 — verify the encoding explicitly. See [`src/lib/memory/loaders/xlsx-loader.test.ts`](src/lib/memory/loaders/xlsx-loader.test.ts) as the reference shape.

### 7. Cron Schedule Semantics — `every` Non-Strict Tick (PM #20)
- [`computeNextRunAtMs`](src/lib/cron/schedule.ts) has a known divergence between schedule kinds: `at` and `cron` use strict-greater-than-now semantics; `every` returns the **current aligned tick** when `nowMs` lands exactly on one. The runtime currently masks this because `CronScheduler.tick` advances `runningAtMs` before re-computing, so jobs don't loop in practice.
- **Why this matters:** PM #20 — any new caller of `computeNextRunAtMs` that naively checks `if (nextRunAtMs > nowMs)` to gate "is this in the future?" will treat aligned ticks as "due now" → re-fire → re-compute the same value → tight loop.
- **Rule:** treat `computeNextRunAtMs(...) === nowMs` as ambiguous. Use `> nowMs` at the callsite OR adopt the runtime's pattern of marking `runningAtMs` before the next compute. The long-term fix (harmonize all three kinds to strict-`>`) is tracked in PM #20.

### 8. Tools vs Skills — Two Parallel Capability Systems

Orchestra exposes capabilities to the agent through **two distinct mechanisms** that coexist and serve different purposes. Confusing them is the most common architectural mistake when adding a new feature.

| Aspect | **Tools** ([src/lib/tools/](src/lib/tools/)) | **Skills** ([bundled-skills/](bundled-skills/)) |
| --- | --- | --- |
| **Definition** | `tool({ description, inputSchema, execute })` from Vercel AI SDK | A directory with `SKILL.md` (YAML frontmatter + markdown body) |
| **Where the code lives** | TypeScript in [src/lib/tools/tool.ts](src/lib/tools/tool.ts) (and helpers) | External CLI binaries the skill *describes*, not implements |
| **Invocation model** | Function call dispatched by `generateText` tool-calling loop | Bash commands the agent runs through the standard Bash tool |
| **Always available?** | Yes — registered unconditionally in [`createAgentTools`](src/lib/tools/tool.ts) | No — only when the agent recognises a triggering phrase in the user prompt and the binary is installed |
| **When to use** | Stateful, multi-step, in-process capabilities that need access to settings, Telegram runtime, project context, MCP tools, etc. | Wrappers around an external CLI tool where the canonical UX is already a CLI |
| **Example** | `web_task` (drives Playwright in-process via an LLM loop) | `playwright-cli` (the agent runs `playwright-cli click e3` as a bash command) |

**Decision tree for adding a new capability:**

1. Does the capability require **in-process state** (settings, project ctx, the loop-guard wrapper, abortSignal propagation, UI sync events)? → **Tool.**
2. Does an existing CLI binary already do the job, and you just want the agent to know it exists? → **Skill.**
3. Does the capability need to be **conditionally available** based on prompt content (e.g. only activate for Discord-related prompts to save context budget)? → **Skill.**
4. Otherwise default to **Tool** — they are first-class, type-safe, and easier to test.

**Critical contract: tool-capability detection (PM #17) only applies to Tools.** Skills are invoked via the Bash tool, which has no model-specific tool-call validation; if a model can't tool-call at all, the agent simply can't invoke ANY tool — but skills still work because the Bash tool is the universal fallback.

**Grounding contract — a write tool must report what the MODEL cares about, not just that the side effect happened (PM #80).** `write_text_file` runs `verifyWrittenSource` ([`src/lib/tools/post-write-verify.ts`](src/lib/tools/post-write-verify.ts)) after the write: a cheap, local, SYNTAX-ONLY check (TS compiler `parseDiagnostics` for `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`; `JSON.parse` for `.json` — NO type-check, NO tsconfig resolution). On invalid content the tool result carries `syntaxValid: false` + `syntaxErrors` (first 5 diagnostics with `line:col`) + a `warning` directive ("fix in place, do NOT rewrite the whole file"); valid → `syntaxValid: true`; non-source/empty/oversized/checker-error → no field (fail-safe, never blocks or false-fails a write). **Why:** `{ success: true, bytes }` confirms only that the write landed, not that the code is valid — a capable model emitting corrupted source (e.g. a quote-heavy multi-line file mangled while encoding the JSON tool-call argument) reads it back, sees garbage, rewrites, re-mangles, and loops forever. The byte-identical loop guard ([`tool-guard.ts`](src/lib/agent/tool-guard.ts), §4) does NOT catch this — drifting rewrites never repeat the `(tool+args)` key, and the loop spans turns stitched by a human pressing "continue". The fix is an INFORMATION signal, not a block. **Cross-turn backstop:** `recordFileWrite` ([`write-rewrite-budget.ts`](src/lib/tools/write-rewrite-budget.ts)) is a chat-scoped in-memory rewrite counter (chatId → path → count, evaporates on restart like the daemon's `autoPilotIterations`) that `write_text_file` consults BEFORE writing — it WARNS at 6 rewrites of one file and at 10 REFUSES the write (`success:false` + a read/verify/ask directive), resetting into the warn band so a genuine fix keeps a runway while a true loop is interrupted again. It exists precisely because the per-turn guard's state cannot span the "continue"-stitched turns where this loop lives. **Rule:** any tool whose success the model must reason about (write/patch/build/deploy) should surface the outcome the model actually needs, with a precise, actionable directive — not just confirm the I/O. And: a within-call (per-turn) loop guard cannot bound a cross-turn loop — pathological repetition that spans turns needs state scoped to the chat, not the turn.

**MCP-specific contract (PM #27):** MCP servers are external processes whose configs are agent-writable via `upsert_mcp_server`. Therefore both PM #8 and PM #26 contracts apply to the MCP boundary, no exception:
- Every HTTP MCP transport URL goes through `assertSafeOutboundUrl` (live: [`src/lib/mcp/client.ts`](src/lib/mcp/client.ts) → `createTransport`). Cloud metadata, RFC 1918, and IPv4-in-IPv6 bypass forms are rejected. STDIO transports skip this — they have no URL.
- Every byte returned by an MCP tool is wrapped in `<UNTRUSTED_MCP_TOOL_OUTPUT server="..." tool="...">...</UNTRUSTED_MCP_TOOL_OUTPUT>` before it reaches the agent prompt, via the `wrapUntrustedMcpOutput` helper. Orchestra-authored prefixes (`[Loop guard]`, `[Preflight]`, `[Hint]`) stay OUTSIDE the marker — they are authoritative. Output > 100KB is truncated INSIDE the marker so the truncation note cannot be mis-trusted as a delimiter.
- The agent's system prompt has a global `<untrusted_content_protocol>` section ([`src/prompts/system.md`](src/prompts/system.md)) that codifies the rule for ALL `<UNTRUSTED_*>` markers (MCP, web_task, future tools). When you add a new boundary, the wrapper helper + a marker name (`<UNTRUSTED_<FAMILY>>`) is the entire integration.

**Test coverage today:**
- Tools: coverage is uneven, NOT the flat "88%" once claimed here. `web_task` is well-covered (~88%: mock unit tests + real-Playwright integration), but the large `tool.ts` registry itself sits at ~24% line coverage (most tool `execute` bodies are unexercised — a large coverage gap; raise it as part of the §10 `tool.ts` split). The loop-guard wrap is now covered directly by [`tool-guard.test.ts`](src/lib/agent/tool-guard.test.ts) against the REAL extracted function (no longer the inlined-copy-only gap). Across `src/lib` the aggregate is ~61% lines (measured v8, 2026-06): `security`/`memory`/`auth`/`cost` exceed 90% while `tools` (~40%) / `providers` (~43%) / `mcp` (~8%) trail. Per-module floors in `vitest.config.ts` gate the high-blast-radius files; the global floor tracks the measured ~46%.
- Skills: structural validation only (PM #24) — every `SKILL.md` is parsed and required frontmatter fields are checked. We deliberately do NOT exercise the underlying CLI binary in CI because that would require installing dozens of external dependencies. The skill body is operator-facing markdown; the agent reads it as system-prompt context, not executable code.

---

## 🔄 Realtime & Frontend Resilience Contract

The frontend runs a **single shared `EventSource`** per tab (`src/hooks/use-background-sync.ts`). The SSE bus is fire-and-forget — it has no replay buffer, so any event missed during a network blink is gone. The disk JSON in `data/chats/<id>.json` is the source of truth; the frontend must reconcile against it after every gap.

**Already implemented (do not regress):**
- **Single connection invariant** — never instantiate `new EventSource(...)` in components. Browsers cap at 6 HTTP/1.1 connections per origin; one runaway component takes down the bus. Always go through `useBackgroundSync`. **CI-enforced** by [`frontend-invariants.test.ts`](src/components/frontend-invariants.test.ts), which fails the build on any `new EventSource` outside `use-background-sync.ts` (tree-wide scan — no file list to drift).
- **Subscribe-time debounce** — 1-second teardown delay on the shared `EventSource` to absorb React Strict Mode unmount/mount cycles (see `use-background-sync.ts`, search for `debounce for React Strict Mode`).
- **`EventSource.onerror` recovery** — exponential backoff (1s → 15s, capped) recreates the socket once the browser gives up retrying (`readyState === CLOSED`). Implemented in `ensureSharedEventSource()` + `scheduleReconnect()`.
- **Visibility/focus resync** — `visibilitychange === "visible"` and `window.focus` call `ensureSharedEventSource()`, which is idempotent on healthy connections and forces a fresh socket if the previous one was dropped while the tab was hidden.
- **Synthetic resync broadcast** — on every `ready` event from the server (initial connect or post-reconnect), the hook fans out a synthetic `{ topic: "global", reason: "reconnect-resync" }` event to all subscribers. This bumps `syncTick`, and consumers like `chat-panel.tsx` already refetch `GET /api/chat/history?id=<chatId>` on tick changes — reconciliation against the canonical on-disk JSON is automatic. See PM #5 for the bug this prevents.

**Regression coverage for PM #5 — closed at two layers:**
- **Unit** ([`src/hooks/use-background-sync.dom.test.tsx`](src/hooks/use-background-sync.dom.test.tsx)) — 9 happy-dom tests pin every branch of the fix: single shared EventSource, server `ready` → broadcast → tick bump on ALL subscribers (regardless of topic — the Defect #1 bypass), regular sync events still respect scope, `visibilitychange === "visible"` and `window.focus` both force immediate reconnect + tick bump, CLOSED EventSource on visibility return triggers fresh connection, `onerror` doesn't crash the React tree.
- **Browser smoke** ([`tests/e2e/pm-5-visibility-resync.spec.ts`](tests/e2e/pm-5-visibility-resync.spec.ts)) — 4 Playwright tests verify the browser-level primitives the fix depends on are intact: `EventSource` constructor available, `visibilitychange` + `focus` events dispatchable without breaking the page, `/api/events` rejects anonymous requests with 401, EventSource against a rejected endpoint doesn't explode.

**Future enhancement (tracked separately):**
- **Stream watchdog** — if a chat is locally marked `running` and no SSE event arrives for ~30s, force a resync. Useful for the case where SSE *appears* alive but events are silently dropped between server emit and client receive. Not yet implemented; add when there is concrete evidence of need.
- **Full end-to-end regression for PM #5** — long generation + mid-stream visibility toggle + assert final message renders. Requires deterministic LLM mocking infrastructure (test-only API route). Deferred; the unit + browser-smoke layers above cover the actual fix logic.

---

## 🛑 AbortSignal Propagation Contract

PM #1 was a P0 outage caused by zombie streams. The contract that prevents recurrence:

```ts
// src/app/api/chat/route.ts (canonical pattern)
export async function POST(req: Request) {
  return runAgent({
    /* ...inputs */,
    abortSignal: req.signal, // MUST be req.signal, not a new AbortController
  });
}
```

- Every `generateText` call receives `abortSignal`. **Every `generateObject`, `streamText`, AND `embed`/`embedMany` call too** (PM #23 — the original contract said "generateText"; the inner Router uses `generateObject`, which silently leaked for six months. QA audit F-12/F-13 — `embedTexts` wrapping `embed`/`embedMany` for RAG, disagreement detection, and trace few-shots was a *second* blind spot: the embedding HTTP request ran to completion after an abort, and the audit grep below didn't even check for it).
- Every tool implementation receives and respects `abortSignal` (long `fetch`, child processes, sleeps).
- Every iteration of `src/lib/agent/daemon.ts` and `src/lib/cron/runtime.ts` checks `signal.aborted` between hops.
- Background tasks that outlive a single request use a **separate `AbortController`** owned by `daemon.ts`, NOT `req.signal` — the request finishes, but the daemon keeps running. This is the one exception.

**Pre-merge audit (PM #23) — now a CI gate, not a hand-run grep.** [`abort-contract.test.ts`](src/lib/agent/abort-contract.test.ts) runs the bracket-balanced scan below over EVERY non-test file under `src/` and fails the build on any generate/stream/embed callsite missing `abortSignal`. It scans the whole tree precisely because a hardcoded file list drifts: F-13 caught `blackboard.ts` outside the list, and standing the gate up caught three MORE unlisted callers (`agent-response.ts`, `tournament-aggregator.ts`, `web-task.ts`). The Node variant below is the same logic, kept for a quick local spot-check on the legacy file set:
```bash
for f in src/lib/agent/agent.ts src/lib/agent/moa.ts src/lib/agent/compressor.ts src/lib/agent/reflection.ts src/lib/agent/moa-router.ts src/lib/memory/embeddings.ts src/lib/memory/blackboard.ts; do
  node -e "
    const fs = require('fs');
    const src = fs.readFileSync('$f', 'utf8').split('\n');
    let inCall=false, depth=0, callStart=0, hasSignal=false, total=0, missing=[];
    for (let i=0; i<src.length; i++) {
      const L = src[i];
      if (!inCall && /(await\s+generateText|await\s+generateObject|streamText|await\s+embedMany|await\s+embed)\s*\(/.test(L)) {
        inCall=true; depth=0; callStart=i+1; hasSignal=false; total++;
      }
      if (inCall) {
        if (/abortSignal/.test(L)) hasSignal=true;
        for (const c of L) {
          if (c==='(') depth++;
          else if (c===')') { depth--; if (depth===0) { if (!hasSignal) missing.push(callStart); inCall=false; break; } }
        }
      }
    }
    console.log('$f: total=' + total + ', missing=' + missing.length + (missing.length ? ' at L' + missing.join(',L') : ''));
  "
done
```
These seven are the legacy spot-check list, but the **source of truth is `abort-contract.test.ts`, which scans all of `src/`** — so a new callsite in a new file is covered automatically, with nothing to keep in sync. Today's real surface is ~10 files (the seven + `agent-response.ts`, `tournament-aggregator.ts`, `web-task.ts`); all must report `missing=0`. The fixed list drifted twice (blackboard via F-13; the three extras via the F-21 gate) — which is why the gate scans the tree, not a list. Lesson: scope abort audits to the SDK primitive (`embed`/`embedMany`/`generate*`), tree-wide, not a hand-maintained file list or a single in-house wrapper.

**PM #23 closed (2026-05-28 audit):** both `runAgentText` ([agent.ts:1833](src/lib/agent/agent.ts#L1833)) and `runSubordinateAgent` ([agent.ts:1992](src/lib/agent/agent.ts#L1992)) accept `abortSignal?: AbortSignal` and plumb it into their inner `generateText` calls. Callers (`cron/service.ts`, `external/handle-external-message.ts`, `tools/call-subordinate.ts`) thread the appropriate signal — daemon's `AbortController` for cron, `req.signal` for the rest. Don't reintroduce the gap.

**QA audit F-12/F-13 closed (2026-06-14):** `embedTexts` ([embeddings.ts](src/lib/memory/embeddings.ts)) now accepts `options.abortSignal` and forwards it to `embed`/`embedMany` (+ a `throwIfAborted()` short-circuit and a raw re-throw on abort so cancellation stays distinguishable from a provider error). In-loop callers thread the signal: `detectDisagreement` (was silently dropping it as `_abortSignal`), the MoA reflection convergence check, and `runAgent`'s RAG search + history-archive insert. `searchMemory`/`insertMemory`/`insertManyMemories` gained an optional trailing `abortSignal`. A skeptical re-audit then caught a SECOND family of embed calls the first pass missed: **`blackboard.ts` calls the SDK `embed()` directly** (write_fact/search_facts tools), bypassing `embedTexts` entirely — now fixed with its own `abortSignal` param threaded from `tool.ts`. Lower-frequency callers where the param now exists but the signal isn't yet threaded (incremental follow-up, NOT a regression): the `memory_save`/`memory_load` tool wrappers, bulk knowledge import, and the fire-and-forget trace capture. The audit grep + file list above were extended to `embed`/`embedMany` so this surface can't silently regress again. Regression tests: [`embeddings.test.ts`](src/lib/memory/embeddings.test.ts) (forwarding + already-aborted short-circuit + raw re-throw), [`disagreement.test.ts`](src/lib/agent/disagreement.test.ts) (forwards to `embedTexts`).

If you cannot answer "what cancels this stream?" you MUST NOT merge the change.

---

## 🔭 Observability

There is no APM. Reconstructing what happened requires reading three things:

1. **Server stdout** — `npm run dev` writes everything to the terminal. For retroactive grep, run as `npm run dev 2>&1 | tee logs/dev-$(date +%F).log`. Logs are NOT shipped anywhere by default.
2. **`data/chats/<chatId>.json`** — the canonical chat state. If the file contains a complete assistant message but the user reports an empty response, the bug is in the frontend resync path (PM #5), not the backend.
3. **`/api/events` SSE stream** — `curl -N "http://localhost:3000/api/events?topic=chat&chatId=<id>"` to verify the bus is alive and what events the server is emitting. An immediate `event: ready` confirms the endpoint is healthy.

**Recommended postmortem checklist when a chat appears stuck:**
- **First command — one-shot diagnostic (PM #31):**
  ```bash
  curl -s --cookie "$(cat ~/.orchestra-cookie 2>/dev/null)" \
    http://localhost:3000/api/_debug/chat/<chatId> | jq
  ```
  Returns `{ diskState, recentLogs, sseBusHealthy, activeJob, uptimeSec }` in one shot — replaces the four manual steps below for ~95% of cases. (Requires a session cookie; if you don't have one, log into the dashboard once and copy `orchestra_auth` out of dev-tools.)
- **Fallback manual steps** (use when the route is unreachable — server down, no session, or to corroborate the diagnostic):
  - `ps aux | grep next-server` → is the server even alive?
  - `curl -s -o /dev/null -w "%{http_code} %{time_total}\n" http://localhost:3000/` → does it respond?
  - Inspect the latest `data/chats/*.json` — look at the last message's `parts`, `status`, `finishReason`. A clean message with no pending parts means the backend finished; the bug is on the wire (PM #5).
  - `lsof -i :3000` → are SSE connections still open?
  - `curl -N "http://localhost:3000/api/events?topic=chat&chatId=<id>"` → bus health probe; immediate `event: ready` is the all-clear.

**When a chat reportedly "disappeared from the sidebar" (PM #30):**
- `curl http://localhost:3000/api/health | jq '.subsystems[] | select(.name == "chat_index_integrity")'` → if status is `warn`, the detail string names every chat file that failed to parse during the last index rebuild.
- `grep chat_index_broken_file data/logs/*.jsonl` (or stdout of `npm run dev`) → finds every skip with filename, size, and parse error.
- The corrupt file is still on disk under `data/chats/<id>.json` — usually a partial-write artifact from a crash mid-flush. The pending writes that survived are in `data/logs/` if structured logging was enabled before the crash. Hand-repair or accept the loss; the next `rebuildChatIndex` drops repaired files from the broken registry automatically.

---

## 🛡 Security Patterns

Orchestra runs locally by default but `data/` contains user secrets, API keys (in `data/settings/`), uploaded knowledge, and integration tokens. Every API route is a security boundary even on `localhost` — assume it can be reached from an untrusted browser tab via CSRF or DNS rebinding.

### User-supplied filesystem paths — canonical guard

`path.join()` is **not** a security boundary. It normalizes traversal silently, so `path.join("/data/knowledge", "../../etc")` resolves outside the intended root. Use the shared helper [`assertPathInside`](src/lib/storage/fs-utils.ts) for ANY user input that touches the filesystem:

```ts
import { assertPathInside } from "@/lib/storage/fs-utils";

try {
  const safePath = assertPathInside(KNOWLEDGE_ROOT, userSuppliedFragment);
  // ... use safePath with fs APIs
} catch {
  return Response.json({ error: "invalid path" }, { status: 400 });
}
```

The helper does `path.resolve` + `startsWith(root + path.sep)` — the `path.sep` suffix matters: without it, `/data/proj-abc` would slip through a `/data/proj-a` check. Failure mode if you skip the helper: PM #6 (path traversal in `knowledge/route.ts`). Canonical reference implementation: [`src/app/api/knowledge/route.ts`](src/app/api/knowledge/route.ts).

**Audit every user-supplied path fragment, not just the obvious one.** The original PM #6 fix only validated `directory`, leaving the `subdir` body field to flow unchecked into `getDbPath(subdir)` → `path.join(DATA_DIR, "memory", subdir, …)` — the same class of bug under a different name. Defect #2 of the 2026-05 audit closed it. Rule: when adding a route, list ALL string body/query fields that touch the filesystem and validate each.

**Known caveat — symlinks.** `assertPathInside` is string-only; it does NOT call `fs.realpath`. A symlink placed inside the sandbox can still point outside it. Acceptable for the local-first, single-trusted-operator threat model; if you extend Orchestra beyond that, replace with an async `realpath`-based guard.

**Defense-in-depth.** Where filesystem access happens deep inside library code (e.g. [`lib/memory/memory.ts:getDbPath`](src/lib/memory/memory.ts)), call `assertPathInside` there too — even if every known caller validates at the entry point. New callers may forget; the inner guard makes the property invariant.

**No more inline `path.resolve` + `startsWith` guards (PM #16).** All known sites have been migrated to `assertPathInside`. Anyone adding a new route that touches a user-supplied filesystem path MUST use the helper, not inline the check. Reason: a bare `startsWith(root)` *without* a `path.sep` suffix is a sibling-prefix bypass — `/data/projects/foo` would accept a path that resolves to `/data/projects/foo-evil/...` because the resolved path literally starts with `/data/projects/foo`. PM #16 found this exact bug live in three places (`/api/files` DELETE, `/api/files/download` GET, `chat-files-store.deleteChatFile`); each was an exploitable arbitrary-file-read or arbitrary-file-delete primitive for any session. `assertPathInside` does the comparison correctly — `startsWith(root + path.sep)` — and is the only correct sandbox check in this codebase. If you see an inline form anywhere outside `fs-utils.ts` itself, treat it as a P0 defect and migrate before merging.

**Audited routes — checklist for new routes that touch user-supplied filenames.** When adding a new API route that derives a filesystem path from a user string, confirm both (a) a strict sanitizer (`path.basename` + explicit `/` and `\` reject + `.`/`..` reject) AND (b) `assertPathInside` at the route layer AND (c) `assertPathInside` push-down into the library code that does the actual `fs.*` call. The routes below have been audited end-to-end; if you add a new route, append it here in the same commit:

| Route | Field(s) | Status |
| --- | --- | --- |
| `POST /api/projects/[id]/knowledge` | multipart `file.name` | ✓ PM #21 (sanitize + `assertPathInside` route layer + push-down to `importKnowledgeFile`) |
| `DELETE /api/projects/[id]/knowledge` | JSON body `filename` | ✓ PM #21 |
| `POST /api/chat/files` | multipart `filename` | ✓ `chat-files-store.saveChatFile` uses `path.basename` |
| `DELETE /api/chat/files` | query `filename` | ✓ PM #16 (`chat-files-store.deleteChatFile` uses `assertPathInside`) |
| `GET /api/files/download` | query `path` | ✓ PM #16 |
| `GET /api/files` | query `path` | ✓ PM #16 (route-layer `assertPathInside` + push-down to `getProjectFiles`) |
| `DELETE /api/files` | body `path` | ✓ PM #16 |
| `POST /api/memory` | body `subdir` | ✓ PM #6 defect-#2 (`getDbPath` uses `assertPathInside`) |

### Sensitive data on the SSR boundary (PM #15)

Server components reachable WITHOUT a valid session — `src/app/layout.tsx` first and foremost, but also any `page.tsx` rendered by the `/login` segment, the `not-found` boundary, and anything else that runs before middleware enforces auth — MUST NOT call accessors that read auth-bearing files (`data/settings/settings.json`, anything under `data/settings/`, anything under `data/external-sessions/`).

Why: Next.js dev-mode RSC instrumentation captures every server-side `fs.readFile` and embeds its raw return value in the HTML stream as a React DevTools timeline event. PM #15 was caused by `RootLayout` doing `await getSettings()` purely to read `general.darkMode` — that one boolean dragged the entire `settings.json` (including `auth.passwordHash`) into the HTML of every page, including `/login`. The leak is not visible in production builds, but treating "dev-mode only" as an excuse is fragile: anyone running `next dev` behind a tunnel / shared LAN / Docker port-forward exposes the secret.

Apply UI preferences (theme, locale, density) via a pre-paint inline `<script>` reading `localStorage` or a non-secret cookie. Canonical example: [`src/app/layout.tsx`](src/app/layout.tsx)'s `THEME_BOOTSTRAP` + the `localStorage["orchestra-theme"]` write in [`src/components/theme-switcher.tsx`](src/components/theme-switcher.tsx). If you genuinely need server-rendered data on a public page, write a *narrow* accessor that reads only the specific fields, from a file that contains no secrets — and pair it with a regression test that greps the served HTML for known-sensitive substrings (`scrypt$`, `passwordHash`, etc.). Reference regression: [`tests/e2e/auth-hash-leak.spec.ts`](tests/e2e/auth-hash-leak.spec.ts) + [`src/app/layout.test.ts`](src/app/layout.test.ts).

### User-supplied URLs — SSRF guard

Any `route.ts` that performs a server-side `fetch` to a URL passed by the client is a SSRF vector by default. Use the shared helper [`assertSafeOutboundUrl`](src/lib/security/url-guard.ts):

```ts
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/security/url-guard";

let safeUrl: URL;
try {
  safeUrl = assertSafeOutboundUrl(`${userBaseUrl}/api/tags`);
} catch (err) {
  if (err instanceof UnsafeOutboundUrlError) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  throw err;
}

const res = await fetch(safeUrl, { signal: AbortSignal.timeout(5000) });
```

**Policy (deliberate):**
- Protocol must be `http:` or `https:` — rejects `javascript:`, `file:`, `data:`.
- Loopback (`127.0.0.0/8`, `localhost`, `::1`) is **intentionally allowed** — local Ollama on `http://localhost:11434` is a primary legitimate use case.
- RFC 1918 private ranges, `169.254/16` (cloud metadata!), `0.0.0.0/8`, IPv6 ULA (`fc00::/7`), IPv6 link-local (`fe80::/10`) are rejected.
- `AbortSignal.timeout(<ms>)` is non-negotiable on the `fetch` call.

**Known caveats** (carried in PM #8): DNS rebinding bypasses the guard; loopback scans of `localhost:<other-service>` are still reachable; no response-body size cap. The real defense for those is route auth + CSRF tokens, not URL filtering.

Failure mode if you skip the helper: PM #8.

**This applies to agent TOOLS too, not just routes (PM #73).** Any tool that performs a server-side `fetch` of a URL the MODEL or user supplies (e.g. [`fetch_webpage`](src/lib/tools/fetch-webpage.ts)) MUST (a) pass the URL through `assertSafeOutboundUrl` + an `AbortSignal.timeout` BEFORE fetching, and (b) wrap the fetched bytes in `<UNTRUSTED_*>` markers (PM #27) before they reach the model — a fetched page is untrusted external content that can carry prompt-injection. `search_web` is exempt only because it hits a fixed operator-configured endpoint, not a model-supplied URL. `fetch-webpage.ts` is the reference implementation.

### Privacy Mode air-gap — every LLM entry point (PM #47, PM #58)

When `settings.privacyMode.enabled` is true, NO user data may leave the box to a cloud LLM vendor. The runtime guard is `assertPrivacyModeAllowsSettings(settings)` (`agent.ts`) — it throws when `chatModel`, `utilityModel`, `embeddingsModel`, `proposerTiers`, or the tournament judge resolves to a non-local backend.

**The guard must be called at EVERY function that creates a model and calls the AI SDK — not just `runAgent`.** PM #58 was a P0 data-egress leak caused by enforcing it at the interactive `runAgent` only: `runAgentText` (cron + the unauthenticated Telegram webhook) and `runSubordinateAgent` (`call_subordinate`, incl. the recursive path) skipped it, so cron ticks and Telegram messages silently shipped prompts to OpenAI/Anthropic/Google while the UI showed Privacy Mode ON. Call `assertPrivacyModeAllowsSettings(settings)` immediately after `getSettings()`, before `createModel`. Audit with `grep -n assertPrivacyModeAllowsSettings src/lib/agent/agent.ts` — every `getSettings()` that precedes a `createModel` must have a guard line. Regression: [`agent-entrypoints-privacy.test.ts`](src/lib/agent/agent-entrypoints-privacy.test.ts). **Rule:** a security control enforced at "the" entry point is only as strong as the number of entry points; a new `runAgent`-like function inherits ZERO guards — re-apply the air-gap (and the abortSignal plumb + loop-guard wrap) explicitly.

**Embedding is egress too — non-agent API routes are also LLM entry points (QA audit F-19).** The guard checks `embeddingsModel`, because text embedded for RAG / Project Blackboard leaves the box exactly like a chat prompt. PM #58 closed the *agent* functions, but two **non-agent routes reach the embedder directly**, bypassing them: `GET?query=` / `POST` on [`/api/memory`](src/app/api/memory/route.ts) (search/insert embed the text) and `POST` on [`/api/projects/[id]/knowledge`](src/app/api/projects/[id]/knowledge/route.ts) (import embeds the file). Both now call the guard after `getSettings()` and return **403** before embedding. There is NO settings-write enforcement, so "Privacy Mode ON + a cloud `embeddingsModel`" is a reachable state — the route guard is the only thing between it and egress. Regression: the privacy `describe` blocks in [`memory/route.test.ts`](src/app/api/memory/route.test.ts) + [`knowledge/route.test.ts`](src/app/api/projects/[id]/knowledge/route.test.ts). **Audit:** `grep -rln 'searchMemory\|insertMemory\|insertManyMemories\|importKnowledgeFile\|writeFactToBlackboard\|searchBlackboardFacts' src/app/api` — every matching route NOT behind a guarded agent entry must call the guard.

### Secrets hygiene

- `.env.local` and `data/settings/*.json` contain live keys. Never log them, never echo to error responses, never embed in client-side bundles.
- `npm run scrub:secrets` exists for pre-share scrubbing — run it before any `npm pack`, `repomix`, screenshot, or attaching the tree to an issue.
- `.env` and `.env.local` MUST be gitignored (verify before commits).

### Authn/authz on API routes

Most internal routes assume a single trusted operator on `localhost`. If you add a route that mutates state or talks to external services, explicitly ask: "what happens if a malicious page in the browser POSTs to this with credentials: 'include'?" If the answer is "data loss" or "billing leak," add an auth check (see [`src/app/api/auth/login/route.ts`](src/app/api/auth/login/route.ts) for the session-cookie pattern) or a CSRF token.

### Auth escape hatches (local dev / recovery)

Two operator-facing mechanisms exist so a forgotten password or auth-broken UI does not require manual JSON-surgery on `data/settings/settings.json`. Both are deliberate and tested.

- **`ORCHESTRA_DISABLE_AUTH=true`** — env var read by [`src/middleware.ts`](src/middleware.ts) and [`/api/auth/login`](src/app/api/auth/login/route.ts). When `"true"` (strict string compare — `"1"`, `"yes"` are intentionally NOT enough, prevents accidental enablement from sloppy shell quoting), every request bypasses session checks and `/login` redirects straight to `/dashboard`. Use this in local dev or as a recovery handle. **Never enable on a deployment reachable from untrusted networks.**
- **`npm run auth:reset`** — CLI script [`scripts/auth-reset.ts`](scripts/auth-reset.ts) that backs up the current `settings.json` with a timestamped filename, then rewrites `auth.username = "admin"`, `auth.passwordHash = DEFAULT_AUTH_PASSWORD_HASH`, `auth.mustChangeCredentials = true`. Login as `admin`/`admin`, then change the password through the UI on first login. The script is atomic (`fs.rename` after a temp write) and refuses to run on a corrupt settings file.

The `mustChangeCredentials` flow gates BOTH the dashboard AND the API surface (PM #25). [`src/middleware.ts`](src/middleware.ts) returns `403` for every `/api/*` request from a session with `mustChangeCredentials: true`, with two intentional exceptions: `/api/auth/credentials` (the actual password-change PUT) and `/api/auth/logout` (so the operator can sign out). Without the API gate, a same-origin `fetch('/api/...', { credentials: 'include' })` from any other localhost project / Telegram in-app browser / stale dev-tools tab would act as admin/admin until the operator clicked through the dashboard onboarding — `SameSite=Lax` blocks navigational POSTs, NOT same-origin programmatic fetches. **Rule:** any `auth.must<X>` flag that gates the UI must also gate the API surface in the same PR.

If you add a third auth escape hatch, document it here in the same PR.

### Runtime invariant escape hatches

Auth bypass is one category; runtime-invariant bypass is another. Documented in parallel because the same operator-quoting class of mistake (`KEY=1` vs `KEY=true`) bites both.

- **`ORCHESTRA_MULTI_PROCESS_OK=true`** — env var read by [`src/lib/util/multi-process-guard.ts`](src/lib/util/multi-process-guard.ts) at boot. The guard normally fatal-exits when `node:cluster.isWorker === true`, `parseInt(NODE_APP_INSTANCE) > 0` (PM2 cluster), or `NODE_UNIQUE_ID` is set — Critical Rule §1's `withFileLock` single-process invariant. Setting `ORCHESTRA_MULTI_PROCESS_OK=true` (strict string compare, same posture as `ORCHESTRA_DISABLE_AUTH`) skips the check. **Use ONLY after migrating `withFileLock` to an advisory lockfile (e.g. `proper-lockfile`)**; otherwise you trade fatal-exit for silent lost-update corruption.

If you add another runtime-invariant escape hatch, document it here in the same PR. Cross-link from the invariant rule (e.g. Critical Rule §1 mentions this).

---

## 💾 Data Layout (`data/`)

Orchestra has no traditional database — `data/` IS the database. Every directory is a separate concern; treat them as schemas.

**Data root resolution (PM #62) — single source of truth.** The data root is **`getDataDir()` / `dataPath()` from [`src/lib/storage/data-dir.ts`](src/lib/storage/data-dir.ts)**, which honors the `ORCHESTRA_DATA_DIR` env var (absolute or cwd-relative; defaults to `<cwd>/data`). **Never write `path.join(process.cwd(), "data")` anywhere** — always go through the resolver; a fresh hardcoded literal is a defect (grep for `process.cwd(), "data"` in review — it must return only `data-dir.ts`). To isolate a test/dev/E2E run, set `ORCHESTRA_DATA_DIR` to a throwaway dir — **NEVER `mv`/`rm` the live `data/`** (PM #62 lost 34 real chats doing exactly that). Playwright is wired this way already: `playwright.config.ts` + `tests/e2e/global-setup.ts` run the whole suite against `.e2e-data`, leaving the real `data/` untouched.

| Path | Owner module | Purpose | Retention (PM #32) |
| --- | --- | --- | --- |
| `data/chat-index.json` | `chat-store.ts` | Lightweight index of chat IDs + metadata for the sidebar. | Rebuilt on demand; not swept. |
| `data/chats/<chatId>.json` | `chat-store.ts` | Full message history for one chat. Canonical source for the UI. | **Soft-deleted (PM #63)** — `deleteChat` MOVES the file to `data/.trash/chats/` instead of unlinking; never auto-swept from `data/chats/`. |
| `data/.trash/chats/<id>.<ms>.json` | `chat-store.ts` | PM #63 — soft-deleted chats. `restoreChatFromTrash(id)` / `listTrashedChats()` recover them; an accidental or in-app deletion is reversible. | **Swept** — `sweepChatTrash` (boot + 6h) purges entries older than `CHAT_TRASH_MAX_AGE_MS = 30 days`. |
| `data/projects/<projectId>/` | `project-store.ts` | Per-project workspace, including `.orchestra_blackboard.json`. | Deleted with the project. Never auto-swept. |
| `data/goals/` | `goal-store` (in `storage/`) | `GoalTree` JSON files; ghost-sweeper resurrects orphaned tasks here. | Ghost-swept once per boot (`sweepGhostTasks`). |
| `data/memory/` | `lib/memory/` | Vector embeddings for long-term memory. | **Not swept yet** (PM #32 — deferred; needs `deleteProject`-side atomic clear before any TTL is safe). |
| `data/queue/` | misc background tasks | Pending job descriptors. | Boot-time + 6h `sweepOrphanQueueEntries` removes entries whose chatId is absent from chat-index. |
| `data/settings/` | `lib/settings/` | User-level settings JSON (model preferences, toggles). | Never auto-swept — operator config. |
| `data/external-sessions/` | `api/external` | OAuth / external integration session blobs. | **Not swept yet** (PM #32 — deferred; TTL is integration-specific). |
| `data/tmp/` | various | Ephemeral scratch space. | Boot-time + 6h `sweepTempDir` removes files older than 7 days. |
| `data/logs/` | `observability/logger` | Daily JSONL log files. | Not swept yet — daily file size is bounded; revisit if dailies exceed ~50 MB. |
| `data/cache/openrouter-pricing.json` | `cost/openrouter-pricing.ts` | PM #49 — live OpenRouter `/api/v1/models` pricing snapshot. Overwritten on boot refresh AND every 6h thereafter (`ensureOpenRouterPricingRefreshScheduled`, force-fetch — keeps cache age under the 24h health-warn threshold on long-running servers; tick re-checks Privacy Mode each fire). Single file, bounded ~200 KB. The in-memory map lives on `globalThis` (PM #71), NOT a module-level `let` — see rule below. | Single overwritten file — bounded by construction, not swept. |

**Boot-warmed, route-read module state MUST live on `globalThis` (PM #71).** Next.js bundles `instrumentation-node.ts` and the API route handlers into SEPARATE module graphs, so a module-level `let` warmed at boot (e.g. `refreshOpenRouterPricingCache()` from instrumentation) is a DIFFERENT instance than the one a request handler imports — the handler's copy stays empty. PM #71 was exactly this: the OpenRouter pricing cache showed `337 models priced` in `/api/health` (warmed instance) while every chat's cost banner read an empty map (route instance) and showed "cost unknown" for a year. Fix: store such state on a `Symbol.for(...)`-keyed `globalThis` singleton (one per process, shared across instances). Symptom signature to watch for: a cache `/api/health` reports as full but every consumer sees empty. Any new boot-initialized singleton (pricing, embeddings cache, model catalogs) follows this.
| `data/traces/<id>.json` | `agent/trace-memory.ts` | PM #51 — global MoA trace pool (runs without `projectId`). Used as few-shots for the Router in global chats. | Operator-controlled — `npm run trace:clear --global` to reset. Not auto-swept. |
| `data/projects/<projectId>/.orchestra_traces/<id>.json` | `agent/trace-memory.ts` | PM #55 — per-project MoA trace pool. Captures from project-owned chats land here so traces don't cross-pollute between unrelated projects. | Operator-controlled — `npm run trace:clear -- --project <id>`. Deleted with the project. |
| `data/chat-files/<chatId>/` | `storage/chat-files-store.ts` | User uploads attached to a single chat (images, PDFs, audio for STT). Referenced by the chat as `Attachment`s with path `data/chat-files/<chatId>/<file>`. | **Sweeper added Sprint 5** — `sweepOrphanChatFiles` removes `<chatId>/` directories absent from chat-index. Atomic deletion piggybacks on `deleteChat` for the live path; the sweep handles crash-leaked dirs from before that landed. |
| `data/snapshots/<projectId>/<snapshotId>.{json,zip}` | `storage/snapshots.ts` | Pre-write snapshots taken before destructive project operations (e.g. file overwrite) so the operator can roll back. | **Self-pruning** — `pruneSnapshots()` keeps a per-project FIFO ring buffer of `MAX_SNAPSHOTS_PER_PROJECT = 200` pairs. Fires after every `snapshotBeforeWrite`. No sweeper needed. |
| `data/postmortems/<traceId>.json` | `observability/postmortem.ts` | PM #31-era operator artifact — when an agent run errors out, the postmortem dumps the request snapshot + sanitized settings + last 200 log lines scoped to the `traceId`. Operator inspects via the dashboard. | **Self-pruning** — `prunePostmortems()` keeps a FIFO ring buffer of `MAX_POSTMORTEMS = 500` files (sorted by mtime descending; oldest evicted). Fires fire-and-forget from `dumpPostmortem` after every successful write — same posture as `pruneSnapshots`. Per-file size is also capped (`MAX_CHAT_EMBED_BYTES = 250 KB`, `MAX_LOG_ENTRIES = 200`). No sweeper needed. |
| `data/npm-cache/` | (none — runtime artifact) | Created by npm/pnpm when `install-orchestrator` shells out to install packages on behalf of the agent. Contents are vanilla package-manager cache files, not Orchestra state. | **Ephemeral / operator-local.** Safe to `rm -rf` at any time; the next install repopulates. Excluded from backups; not user data. |
| `data-backups/data-<ts>/` (**sibling of `data/`, NOT under it**) | `storage/backup.ts` | Full-`data/` snapshots — boot + daily, `npm-cache`/`tmp`/`cache` excluded. Local-first data safety: `data/` has NO external redundancy, so a bad write / disk failure / `rm -rf data/` (PM #62) is otherwise unrecoverable. Lives OUTSIDE `data/` on purpose — so it can't recursively self-copy AND survives the very `data/`-wipe it protects against. Copies are plain recursive `fs.cp` (zero deps), published atomically (`.tmp-…` → `rename`). Footprint ≈ `RETENTION × |data/|` (full uncompressed copies, incl. `chat-files/` + `memory/`) — lower `ORCHESTRA_BACKUP_RETENTION` if `data/` is large. | **Self-pruning FIFO ring** (`pruneBackups`, default keep **7** = one week of dailies, `ORCHESTRA_BACKUP_RETENTION`) + `.tmp-` partial sweep. No sweeper needed. |

**Data-backup operator knobs + restore.** Auto-backup is wired at boot via `ensureDataBackupScheduled()` (`instrumentation-node.ts`): a boot snapshot + a recurring interval. **Boot-dedup (audit fix #1):** the boot snapshot is SKIPPED when a backup younger than half the interval already exists (`shouldRunBootBackup`), so frequent restarts don't thrash full-`data/` copies. **Observability (audit fix #2):** `/api/health` carries a `data_backup` subsystem (`getBackupStatus` — count + newest age; warns when STALE, i.e. backups exist but are older than 2× the interval, so a silently-stopped backup is visible instead of false safety; "no backups yet" is `ok`, not a fresh-install false alarm). Env: `ORCHESTRA_BACKUP_DISABLED=true` (strict-string opt-out), `ORCHESTRA_BACKUP_DIR` (default `<data>/../data-backups`), `ORCHESTRA_BACKUP_RETENTION` (default 7), `ORCHESTRA_BACKUP_INTERVAL_HOURS` (default 24). Skipped under `VITEST`/`NODE_ENV=test`. **Restore is deliberately MANUAL** (it overwrites live state): stop the server, then `rm -rf data && cp -r data-backups/<data-…> data`. The backup dirs are plain, timestamp-sortable copies — inspect with `ls data-backups/`, no tooling needed. Backups are LOCAL (no egress) so Privacy Mode doesn't gate them. NOT in scope by design: compression, incremental/dedup, offsite/cloud, encryption, point-in-time consistency — over-engineering for a solo local tool; per-file atomicity (every JSON written via `safeWriteFile`) makes each copied file self-consistent, which is sufficient for the loss-not-tearing threat model.

**Schema versioning — stamp + defensive load (NOT a migration engine).** [`storage/schema-version.ts`](src/lib/storage/schema-version.ts) holds `CURRENT_SCHEMA_VERSION` + `stampSchemaVersion()` / `warnIfFutureSchema()`. On WRITE the persisted JSON is tagged with the version; on READ a record written by a NEWER build (`schemaVersion > CURRENT`) triggers a LOUD warn — the dangerous direction, because the older code drops fields it doesn't understand on the next save (lossy downgrade round-trip). Recovery from a detected downgrade is `data-backups/`, NOT an auto-migration (deliberate — over-engineering for a solo local tool). The stamp is a persistence-ENVELOPE field, never a domain-type field: chat-store's Zod `ChatSchema` strips it on read; settings-store strips it explicitly. **Wired today on the two highest-value stores:** chats (`chat-store.ts` — stamp in `flushNow`, warn in `getChat`) and settings (`settings-store.ts` — stamp in `saveSettings`, warn+strip in `getSettings`). **To add a new store:** `stampSchemaVersion(record)` at its single serialize chokepoint + `warnIfFutureSchema(parsed, label)` at its parse chokepoint — two one-liners. **Bump `CURRENT_SCHEMA_VERSION` ONLY on a backward-incompatible change** (field renamed/removed/re-typed); additive optional fields are forward-compatible and need no bump. Regression: [`schema-version.test.ts`](src/lib/storage/schema-version.test.ts) (unit + a real chat-store round-trip proving the stamp lands on disk and a future-stamped file loads clean while warning).

**Why this is NOT speculative gold-plating (audit fix #5 — resolved as keep-and-cap).** A skeptic rightly asks "`CURRENT_SCHEMA_VERSION` is 1 and stays 1 until the first breaking change — is the stamp YAGNI?" No: it is the cheap DETECTION half of the data-safety pair whose RECOVERY half is `data-backups/`. The detection has value the moment it ships — the day you `git checkout` an older build (or run two machines on different versions) against newer data, the loud `console.warn` (which the local operator sees in their own `npm run dev` terminal — adequate visibility for a solo tool, no APM/health-subsystem needed) tells you to restore from a backup BEFORE the older code's next save silently drops fields. The cost is two one-liners per store + a stamp on write. **Deliberately CAPPED — do NOT expand into:** an auto-migration engine, a `/api/health` schema subsystem, or per-store proliferation beyond the two highest-value stores. If a future change is genuinely backward-incompatible, the response is "bump the version + (if needed) a one-off transform at that store's read chokepoint," not a framework.

When you add a new persistent surface, add a row here in the same commit (Critical Rule §7) AND state the retention strategy — one of (a) sweeper in `cron/sweepers.ts`, (b) "never auto-swept — user data" with reasoning, (c) atomic cleanup tied to a higher-level deletion, or (d) self-pruning ring buffer like `snapshots.ts`. Don't ship an unbounded directory.

---

## ⚠️ Critical Rules & Gotchas

### 1. Data Persistence & File I/O
- **No Traditional Database:** Orchestra relies entirely on a local JSON filesystem stored in the `data/` directory.
- **Race Conditions:** NEVER use raw `fs.writeFile` for critical state (`chat-store.ts`, `project-store.ts`). You MUST use `safeWriteFile` from `src/lib/storage/fs-utils.ts` to ensure atomic writes and prevent JSON corruption during concurrent operations.
- **Error Handling:** Always wrap `fs.readFile` and `JSON.parse` in `try/catch` blocks. The local filesystem is volatile. Handle `ENOENT` gracefully.
- **Single-process invariant.** [`withFileLock`](src/lib/storage/fs-utils.ts) is an **in-process** Map-keyed promise chain — it serializes reads/writes within the same Node process only. The cron service (`withCronStoreLock`), chat store, and project store all rely on it. **Do NOT deploy Orchestra in cluster mode (PM2 `instances: > 1`, multi-worker container, separate cron worker process behind shared `data/` volume).** Cross-process concurrent writes to the same JSON file will lost-update each other. If a multi-process deployment becomes a requirement, the path forward is replacing `withFileLock` with an advisory lockfile primitive (e.g., `proper-lockfile`) with retry — every callsite that today says `withFileLock(...)` would inherit the new semantics for free.
- **Graceful-shutdown flush (PM #29).** Any module that buffers writes (debounce, write-coalesce, batch-flush) MUST install its own `SIGTERM` / `SIGINT` handler at module load to drain the buffer on graceful shutdown. Chat-store is the reference: it debounces writes by 80 ms; a `kill -TERM` mid-streaming used to lose that window. The handler is fire-and-forget — Node keeps the event loop alive while file I/O is pending, so writes drain naturally before exit. Idempotent via a `globalThis` flag so dev-mode HMR doesn't stack listeners; skipped under `VITEST=true` / `NODE_ENV=test` to avoid interfering with the test runner's signal lifecycle. Test pattern: `process.emit("SIGTERM")` then assert the disk file matches. New buffered surfaces (queue stores, log batchers, etc.) follow the same shape — see [`installChatStoreShutdownFlush`](src/lib/storage/chat-store.ts).

### 2. Real-Time Telemetry & UI Sync
- **No Polling:** Do NOT implement `setInterval`-based polling on the frontend to fetch backend state. SSE plus the visibility/focus resync (see § "🔄 Realtime & Frontend Resilience Contract") covers every use case currently in the product. If you think you need polling, you're missing a `publishUiSyncEvent` call on the backend.
- **SSE Driven:** The UI is synchronized via Server-Sent Events. If you modify backend state (e.g., in a background job or tool), you MUST call `publishUiSyncEvent({ topic: "chat", chatId: "..." })` from `src/lib/realtime/event-bus.ts`.
- **Shared Connection:** The frontend uses `useBackgroundSync` to maintain a single `EventSource` connection. Avoid instantiating new `EventSource` objects in components to prevent hitting the browser's 6-connection limit.

### 3. Agent Lifecycle & Loop Guards
- **AbortSignals are MANDATORY** — see "🛑 AbortSignal Propagation Contract" above. PM #1 was a P0 outage caused by ignoring this.
- **Loop Guard middleware** — see "Core Subsystems §4 Loop Guard". Every `ToolSet` must be wrapped by `applyGlobalToolLoopGuard` before reaching `generateText`.
- **Per-turn step budget + honest pause (`MAX_TOOL_STEPS_PER_TURN = 50`, subordinate `25`, `agent.ts`).** One `streamText`/`generateText` tool loop is bounded by `stopWhen: [stepCountIs(MAX_TOOL_STEPS_PER_TURN), hasToolCall("response")]`. This is a SAFETY/cost bound, NOT a task-sizing target — a heavy task spans several user "Continue"s. Raised 30→50 once runaway protection got stronger (PM #76 loop guard + the per-file rewrite budget + token governor interrupt churn independently of the cap). **When a turn EXHAUSTS the budget WITHOUT delivering an answer, `resolveTurnContinuation` ([`agent-response.ts`](src/lib/agent/agent-response.ts)) returns a DETERMINISTIC, system-authored "reached the step limit — press Continue" pause notice — NOT a forced tool-less final answer.** Rationale: the PM #69 forced answer reliably masquerades as completion ("Sprint 3 Complete ✅"), so the operator cannot distinguish a paused turn from a finished one. The cap-hit is detected from `event.steps.length >= MAX_TOOL_STEPS_PER_TURN` in the streamText `onFinish` and threaded as `stepLimitReached`; the PM #69 forced answer is preserved for the OTHER no-delivery cases (flaky `finishReason`, sub-cap stop). **Rule:** a turn that stops at a SYSTEM limit must be signalled by the SYSTEM (deterministically, from the stop reason) — never rely on the model to self-report "I hit a limit", it will dress it up as success. Regression: the step-cap-pause cases in [`final-answer-guard.test.ts`](src/lib/agent/final-answer-guard.test.ts).
- **Daemon Limits (`daemon.ts`):** Background auto-pilot is hard-capped via `MAX_AUTO_PILOT_ITERATIONS = 50` (`daemon.ts:24`) to prevent infinite billing loops. Iteration counters live in the in-memory `autoPilotIterations` Map keyed by `chatId` — they evaporate on restart, which is intentional; a new run starts fresh.
- **Counter-reset semantics (PM #59):** the iteration counter MUST survive the Auto-Pilot self-dispatch that increments it. `dispatchAgentJob` calls `abortJob` first on every entry; `abortJob` resets `autoPilotIterations` BY DEFAULT (a user abort should start the next run from a clean budget), but the Auto-Pilot continuation passes `abortJob(chatId, { preserveAutoPilotCounter: true })` so the count accumulates toward the cap. PM #59 was a P0 infinite-billing loop caused by an unconditional reset here: the count cycled 0→1→0→1 and `>= 50` never tripped. When you touch `abortJob`/`dispatchAgentJob`, keep "user-initiated → reset, system continuation → preserve" intact.

### 4. Background Daemons & "Ghost Tasks"
- **Memory Transience:** Background tasks (`daemon.ts`) are tracked in Node's memory (`activeJobs`). 
- **Ghost Sweeper:** Because Orchestra does not use external Redis/Queues, restarting the server clears `activeJobs`. `ghost-sweeper.ts` runs exactly once on server boot to find orphaned tasks in `GoalTree` JSON files and mark them as `"failed"`.
- **Rule:** If you add new persistent asynchronous state, you MUST ensure it has a recovery or cleanup mechanism in `ghost-sweeper.ts` or `cron/runtime.ts`.
- **Sweepers must FAIL-SAFE (PM #60):** any sweep that calls `fs.unlink`/`fs.rm` against an "orphan" set (entries NOT in a live keep-set) must skip the delete when the keep-set can't be resolved. `runAllSweepers` derives the live-chat set from `getAllChats()`; on a throw it sets `chatIds = null` ("unknown") and SKIPS the orphan-keyed sweeps for that cycle (chat-independent sweeps still run). Never substitute an empty `Set()` on error — empty means "everything is an orphan", so fail-open on a destructive op mass-deletes queue entries + `data/chat-files/`. A legitimate empty result (zero chats) is distinct from "unknown" and still cleans orphans.

### 5. UI & Styling Standards (Cyber-Premium)
- **Aesthetics First:** Orchestra is designed to look premium. Use glassmorphism (`backdrop-blur`), subtle gradients, and semantic colors. Avoid harsh default browser styles.
- **Tailwind v4:** Note that Tailwind v4 is in use. Be aware of any breaking changes from v3 if writing custom CSS.
- **Frontend Expert Skill:** Always refer to and adhere to the standards defined in `bundled-skills/SKILL.md`. This includes GPU-accelerated animations, zero-lag navigation, and the "Cyberpunk" aesthetic.
- **Component Design:** Use `class-variance-authority` (cva) for building reusable component variants.
- **List rendering at scale (PM #33):** Any list that can grow past ~50 items AND is re-rendered on a polling/SSE tick MUST be either: (a) virtualised (`@tanstack/react-virtual`), (b) paginated with a default cap, or (c) memoised per-item so reference-stable children skip re-render. Default to (c) for chat-like lists where each item is heavy (markdown + syntax highlighting) — see [`MessageBubble`](src/components/chat/message-bubble.tsx) wrapped in `React.memo`. Default to (b) for sidebar-like lists where the operator can search — see [`SidebarChatList`](src/components/app-sidebar.tsx) with pagination + filter. (a) is for lists past several thousand items only — don't pull `@tanstack/react-virtual` for sub-1500-item surfaces; the dep cost outweighs the win.
- **Zustand store subscriptions MUST be narrow.** Never call `useAppStore()` with no selector — that subscribes to the WHOLE store, so the component re-renders on EVERY `set()` (e.g. a `chats`-list update from an SSE tick) even for fields it doesn't read. The heaviest offender was `chat-panel` re-rendering on every chat-list change while not reading `chats` at all. Select exactly what you use via `useAppStore(useShallow((s) => ({ … })))` (`zustand/react/shallow`); actions are stable refs so they're free to include. **CI-enforced** by [`frontend-invariants.test.ts`](src/components/frontend-invariants.test.ts) — a build failure on any no-arg `useAppStore()`, tree-wide (the old "pre-merge grep" is gone; a human-run grep is the control that gets skipped).

### 6. Security (Code Execution Tool)
- The `code-execution` tool runs via `child_process.spawn`.
- **Docker Privilege:** In the official Docker environment, the `node` user has passwordless `sudo` (`NOPASSWD: ALL`) to allow the agent to install `apt` dependencies on the fly. 
- **Environment scrubbing (PM #28, PM #70):** ALL agent-spawned processes (Python, Node.js, terminal, login-shell PATH probes, the `install_packages` orchestrator — npm/brew/pip post-install hooks run arbitrary code — **and the codex/gemini subprocess CLIs** via `cliProviderEnv(provider)`, which keeps only that CLI's own auth vars) construct their env via the scrubbers in [`src/lib/security/scrub-env.ts`](src/lib/security/scrub-env.ts) (a leaf security util — both `tools/` and `providers/` depend on it; `scrubProcessEnv` re-exported from `code-execution.ts` for back-compat), NOT by spreading `process.env`. The scrubber drops underscore-bounded `KEY/SECRET/TOKEN/PASSWORD/PASSWD/CREDENTIAL(S)/PRIVATE` names and a small explicit always-scrub list (`ORCHESTRA_AUTH_SECRET`, `ORCHESTRA_SESSION_SECRET`, `AUTH`, `AUTHORIZATION`), and keeps base vars (PATH, HOME, npm_config_*, HOMEBREW_*). LOCAL-mode installs no longer leak the operator's `.env`. Docker installs were already isolated; the helper is now the same posture everywhere by construction. **Both forms are now a CI gate, not a manual grep** — [`no-raw-process-env.test.ts`](src/lib/security/no-raw-process-env.test.ts) fails the build if `...process.env` OR `env: process.env` (the latter slipped PM #70) appears in `src/lib/tools` / `src/lib/providers` outside the scrubber. A human-run "pre-merge grep" is the exact control that gets skipped under deadline pressure — automate it.
- **Adding a new child-process tool:** call `scrubProcessEnv({ EXPLICIT_VAR: "value" })` for any var that legitimately needs to be exposed (e.g. `VIRTUAL_ENV`); never write `env: process.env`. The [`no-raw-process-env.test.ts`](src/lib/security/no-raw-process-env.test.ts) gate enforces zero whole-object `process.env` spread/assign in `src/lib/tools` / `src/lib/providers` outside the scrubber (a single-var read like `process.env.FOO` is still fine).
- **Rule:** Never expose the `code-execution` tool to unauthenticated users or untrusted networks without explicit containerization limits.

### 7. Documentation Freshness Contract
- This file is **doc-as-code**. Any PR that renames, moves, or significantly refactors a file referenced in `CLAUDE.md` (any path mentioned in code-fences, backticks, or section headers) MUST update the corresponding section in the same commit. A drifted CLAUDE.md is a P1 bug — it actively misleads every future LLM-assisted change.
- When fixing a production bug whose root cause is architectural, you MUST also: (a) add a `POST_MORTEMS.md` entry following the template, (b) update the relevant `CLAUDE.md` section to encode the lesson as a rule, (c) add or extend a regression test.
- **Rule:** If you can't point to which sections of `CLAUDE.md` and which `POST_MORTEMS.md` entry your change touches, your refactor of core orchestration logic is incomplete.

### 8. File-Size Discipline
- Five core modules cross the 1500-line hard line — line counts kept in §10 below, refreshed alongside any substantive touch (don't cite numbers in two places to avoid the drift §7 forbids). These are not to be celebrated — they are technical debt that hurts every LLM-assisted change (the file no longer fits in a single read).
- **Soft cap: 800 lines per `.ts`/`.tsx` file.** Crossing it is a code smell, not a hard error. Crossing 1500 means the file MUST be decomposed in the next PR that touches it substantively (don't leave it worse than you found it).
- Decomposition guidance: split by concern (one file per tool family, one file per provider, one file per resource), not by line count. Co-locate tests next to the slice they cover. **See §10 for the seam plan per file.**
- **Rule:** Don't add a new function to a 1500+ line file unless you also extract something equivalent. Net file growth in already-bloated modules is forbidden.

### 9. Pre-Push Hygiene
- Run `npm run lint` before pushing. Lint failures in CI are wasted minutes for everyone.
- Run `npm run scrub:secrets` before sharing the tree externally (issue attachments, demos, repomix bundles, screenshots of editor panes).
- Before deleting or overwriting files in `data/`, copy the affected file aside — `data/` IS the database, and there is no undo.
- For changes to SSE / agent / MoA / file-storage paths, run the relevant Vitest suite (`npm test -- <pattern>`) AND boot the dev server to manually verify a real chat completes end-to-end. Unit tests do not catch PM #4/#5-class bugs.
- **Audit gate (Sprint 1 audit follow-up).** `npm run audit:gate` = `npm audit --audit-level=critical --omit=dev` is wired into `verify:strict`. Today's bar is **zero critical advisories on prod dependencies**. We deliberately do NOT block on `high` yet because 15 known transitive highs remain (their parents need coordinated bumps tracked as ongoing tech debt — see `npm audit` output for the list). Raising the bar to `high` is a one-character change here once those transitives are cleared; do it then. Reasoning: a permanently-red `high` gate trains everyone to ignore the gate, defeating the point.

### 10. Sprint 3 — File-size decomposition follow-ups

Five files cross the §8 1500-line "MUST decompose next substantive PR" line. None can be split in a single PR without a comprehensive integration test scaffold — each touches a critical contract (PM #1 abortSignal, PM #5 SSE, PM #17 tool-capability detection, PM #29 flush, PM #50 code-execution). The seam analysis below is the contract to honor when the next focused PR lands.

**`src/lib/agent/agent.ts` (~1475 LOC after Phase 3, 9 hot edits in 90d — the hottest god-file, decompose-by-churn priority #1)** — orchestration core, every chat turn flows through it.
- **Phase 1 DONE:** message/response helpers (`stripThinkingTags`, `unwrapSerializedResponseCall` PM #61, `getLast*`/`extract*` text helpers, `shouldAutoContinueAssistant`, `turnHasDeliverableAnswer` + `resolveTurnContinuation` PM #36/#69) → [`agent-response.ts`](src/lib/agent/agent-response.ts).
- **Phase 2 DONE:** `ChatMessage`↔`ModelMessage` conversion + the per-turn LLM request logger → [`agent-messages.ts`](src/lib/agent/agent-messages.ts).
- **Phase 3 / PR-1 DONE:** the model auto-fallback seam — `attemptModelFallback` (agent-side orchestration: classify → pick → persist → notify; PM #17) → [`agent-fallback.ts`](src/lib/agent/agent-fallback.ts). It was ~87 LOC, not the ~400 the seam list guessed — the heavy fallback primitives (`classifyModelError`/`pickFallbackModel`/`describeFallback`) already lived in [`providers/model-fallback.ts`](src/lib/providers/model-fallback.ts); only the agent-side wiring was in `agent.ts`. Single private caller (runAgent streamText `onError`), leaf-deps only → behavior-preserving move, and the function gained a focused unit test ([`agent-fallback.test.ts`](src/lib/agent/agent-fallback.test.ts), 6 cases) where it previously had only indirect integration coverage.
- All three extractions are behavior-preserving (full suite green) and re-imported so callers are unaffected. The remaining seams below are higher-risk — they restructure `runAgent`'s control flow, not pure helpers.
- **Phase 4 / agent-stream (error-reporting seam) DONE:** [`agent-stream.ts`](src/lib/agent/agent-stream.ts) → `reportTurnError(error, ctx, { logEvent, awaitPostmortem })`. The streamText `onError` callback and the outer fatal `catch` shared ~50 LOC of near-identical "classify → structured log → publish chat-error event → forensic postmortem" plumbing (PM #17 + Sprint 5); they now both call the one helper and differ only in their tails (onError: background fallback + DAG finalize, fire-and-forget postmortem; fatal: awaited postmortem + mcpCleanup + swarm error node + rethrow). Drift between these two was exactly the PM #17 failure mode (one path surfaces the error, the other goes silent) — now structurally impossible. Gained a focused test ([`agent-stream.test.ts`](src/lib/agent/agent-stream.test.ts), 5 cases) on a path that previously had only indirect coverage. agent.ts 1473 → 1416 LOC.
- Natural seams (remaining):
  - `agent-stream.ts` (the rest, ~400): relocating the `streamText({...})` CALL itself + `onFinish`/`onStepFinish` callbacks out of `runAgent` is the bigger, higher-risk piece (a ~12-local closure surface — model/systemPrompt/messages/providerOptions/effectiveTools/tokenGovernor/settings/options/resolvedModelConfig/mcpCleanup/turnExtraUsage). The streamText integration harness (`agent.integration.test.ts`, streamText variant) now covers the happy-path persist, but the onStepFinish billing + tool-loop branches are still only indirectly tested — expand the harness before that cut.
  - `agent-tools.ts` (~300): `ToolSet` *assembly*. NOTE: the `applyGlobalToolLoopGuard` wrap itself is ALREADY extracted to [`tool-guard.ts`](src/lib/agent/tool-guard.ts) (2026-06, to break the agent↔moa cycle so MoA proposers can share it); this remaining seam is the tool-*assembly* glue. Every callsite that builds tools for `generateText` MUST still route through `applyGlobalToolLoopGuard` (CLAUDE.md §4).
  - `agent-core.ts` (~500): the `runAgent` orchestrator that composes the above.
  - `agent.ts` itself shrinks to a re-export facade ≤200 LOC.
- Pre-extraction guard: run `grep -rn applyGlobalToolLoopGuard src/lib/agent/` BEFORE and AFTER — same callsite count across `agent.ts` + `moa.ts`, all still routed through the guard (now in `tool-guard.ts`).
- Pre-extraction guard 2: PM #23 audit grep must report `missing=0` across every new file (see "AbortSignal Propagation Contract" above).
- Test scaffolding: [`agent.integration.test.ts`](src/lib/agent/agent.integration.test.ts) **covers BOTH paths** against one mock `createModel` → `MockLanguageModelV3` (isolated `ORCHESTRA_DATA_DIR`). (a) **generateText** — drives `runAgentText` end-to-end, asserting settings → tools+loop-guard → generateText → agent-response unwrap returns the answer. (b) **streamText (DONE)** — drives the interactive `runAgent`, drains `result.textStream`, then asserts `onFinish` PERSISTED the assistant message to the on-disk chat JSON (via `getChat` poll + `flushAllPendingChats`). The mock exposes both `doGenerate` and `doStream` (the latter via `simulateReadableStream` with provider-level `text-delta`/`finish` parts). **This was the named prerequisite for the `agent-stream` cut — it is now in place, so that seam can be extracted with a regression net.** A regression in agent-messages/agent-tools/agent-response/createModel/stream-persistence blows it up. NOTE: `runAgent`'s `onFinish → updateChat` is a silent no-op if the chat doesn't exist on disk, so the streamText test (like the real route) `createChat`s first.

**`src/lib/tools/tool.ts` (1919 LOC, 4 hot edits in 90d)** — every tool registration.
- Natural seams: one file per tool family.
  - `tools/web.ts` (web_search, web_task)
  - `tools/memory.ts` (insert_memory, search_memory, …)
  - `tools/project.ts` (project file ops, knowledge query)
  - `tools/mcp.ts` (call_mcp_tool + the PM #27 `wrapUntrustedMcpOutput` boundary)
  - `tools/cron.ts` (cron_create/list/delete)
  - `tools/subordinate.ts` (call_subordinate — already has Sprint 4 tests)
  - `tools/skills.ts` (load_skill, install_skill_from_github, …)
- `tool.ts` keeps `createAgentTools` as the facade.
- Pre-extraction guard: every tool MUST stay wrapped by `applyGlobalToolLoopGuard` after the split (one of the most regression-prone surfaces).

**`src/lib/providers/llm-provider.ts` (1833 LOC, 3 hot edits in 90d)** — one branch per provider.
- Natural seams: `providers/{openai,anthropic,google,openrouter,ollama,sglang,vllm,custom,mock}.ts`, each ~200-300 LOC.
- `llm-provider.ts` becomes a registry: `createModel(config, opts)` dispatches by `config.provider`. Keep the `modelSupportsTools` helper here OR move to `providers/tool-support.ts` (currently lives separately — PM #17 single source of truth).
- Pre-extraction guard: `tool-support.test.ts`'s universal cross-provider regression test (PM #17) must stay green; add positive cases for any provider whose extraction you didn't touch so the test surface widens at the same time.

**`src/lib/storage/project-store.ts` (1555 LOC, no hot edits)** — multiple resources in one file.
- Natural seams:
  - `project-meta.ts` (~300): `getProject`, `getAllProjects`, `saveProject`, `deleteProject`, project-id validation, getWorkDir.
  - `project-blackboard.ts` (~250): `.orchestra_blackboard.json` read/write.
  - `project-knowledge.ts` (~300): `getProjectFiles`, `importKnowledgeFile`, the audited-route filename push-down.
  - `project-mcp.ts` (~400): `loadProjectMcpServers`, `upsertProjectMcpServer`, `deleteProjectMcpServer`, `saveProjectMcpServersContent`.
  - `project-files.ts` (~200): direct file CRUD inside the project workspace.
- This is the LOWEST-RISK of the five — most callsites use one resource at a time, so the cross-file edge is thin.
- Pre-extraction guard: the audited-routes table in §"Security Patterns" still references `importKnowledgeFile` and `loadProjectMcpServers`; the new module paths must keep the `assertPathInside` push-down in place.

**`src/lib/tools/code-execution.ts` (1207 LOC, 3 hot edits in 90d)** — security-critical surface.
- Natural seams:
  - `scrubProcessEnv` + the PM #28 always-scrub list already extracted to [`src/lib/security/scrub-env.ts`](src/lib/security/scrub-env.ts) (DONE, PM #70). It's a zero-import leaf placed under `security/` for cohesion (sibling to `url-guard`) — NOT a cycle fix; there was no real import cycle (a leaf can't be in one). THIS IS THE FILE TO TEST HARDEST.
  - `code-execution/runners/{python,node,shell}.ts` (~200 each): per-runtime spawn logic + arg normalization.
  - `code-execution/sandbox.ts` (~200): the Docker vs local branch.
  - `code-execution/index.ts` (~250): the public `code_execution` tool entry, composes the above.
- Pre-extraction guard: PM #28 `grep -rn "\.\.\.process\.env" src/lib/tools/code-execution/` MUST return zero hits except inside `env.ts` `scrubProcessEnv` itself.

**General rule for any of the five:** do the extraction in two PRs. PR 1 introduces the new files as re-exporters that wrap the existing implementation, with the test suite expanded to cover both shapes. PR 2 cuts the implementation across the seams. Reviewers can audit boundary changes without the noise of every callsite changing simultaneously.

### 11. Non-npm dependency: `xlsx` from SheetJS CDN
- `xlsx` in `package.json` resolves to `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, NOT the npm registry. SheetJS stopped publishing to npm in 2023; the last npm-published version (0.18.5) carries two high-severity CVEs (prototype pollution GHSA-4r6h-8v6p-xvw6 and ReDoS GHSA-5pgg-2g8v-p4x9). The CDN tarball is the maintainer's recommended install path and ships the patched 0.20.3.
- The lockfile pins the resolved URL + a SHA-512 integrity hash. CI installs and clean `npm install` work exactly the same as registry packages, with one caveat: **the build host must be able to reach `cdn.sheetjs.com` outbound**. Air-gapped / proxy-restricted environments need either a local mirror of the tarball or a pre-populated `npm cache`. Document this requirement in any deployment runbook.
- **API surface used (verify still present before next bump):** `XLSX.read(buffer, { type: "buffer" })`, `workbook.SheetNames`, `workbook.Sheets[name]`, `XLSX.utils.sheet_to_csv(sheet, { FS, RS })` in [`src/lib/memory/loaders/xlsx-loader.ts`](src/lib/memory/loaders/xlsx-loader.ts). Tests also use `XLSX.utils.book_new`, `XLSX.utils.aoa_to_sheet`, `XLSX.utils.book_append_sheet`, `XLSX.write`.
- **If you ever need to bump:** check `https://docs.sheetjs.com/docs/getting-started/installation/nodejs` for the latest CDN URL, install via `npm install <url>`, run the xlsx-loader test suite, run a non-ASCII round-trip (PM #18 Cyrillic/CJK/emoji) as the loader's regression guard.

---

## 🧵 Context-Management Track (Sprints A1–A4) — Status & Handoff

A 2026-06 track that fixed **silent context-window overflow** (especially local/Ollama models) and the brittle model-name-regex window guess. New modules: [`context-window.ts`](src/lib/providers/context-window.ts), [`token-governor.ts`](src/lib/agent/token-governor.ts), [`tool-guard.ts`](src/lib/agent/tool-guard.ts). Commits: `e4b30f0` (A1–A3), `8a20839` (MoA loop-guard extraction).

### ✅ Contracts now in force (DONE — do not regress)

- **A1 — token estimation.** `estimateTokenCount` ([compressor.ts](src/lib/agent/compressor.ts)) MUST traverse the parts INSIDE array `content` (tool-call/tool-result/multimodal) and tokenize each part's text/serialized payload, NOT call `.length` on the array (that returns part-count → a 50 KB tool result estimated at ~0 tokens, the root of mid-loop overflow). Estimation now uses a real BPE tokenizer, not `/3.5` — see the "real tokenizer" contract below. The `runAgent` compaction gates on token pressure ONLY (no message-count guard); the partition + empty-evicted guard (now `partitionForCompaction` — see A4 below) is what prevents the old negative-slice footgun from emitting bogus "Deep-archiving" events + empty RAG inserts on a short history.
- **A2 — real context window.** The compaction limit comes from `resolveContextWindow(modelConfig)` ([context-window.ts](src/lib/providers/context-window.ts)), NEVER a substring-on-model-name regex (PM #17-style single source of truth). Ollama is probed live: `/api/ps` runtime `context_length` → Modelfile `parameters.num_ctx` → `OLLAMA_CONTEXT_LENGTH` env → 4096 default. **EMPIRICAL FACT (Ollama 0.30.10, this operator's box):** the trained ceiling from `/api/show` (`<arch>.context_length` = 32768 for qwen2.5) is NOT the runtime window (4096) — read `/api/ps`, not the ceiling. Cloud uses a conservative per-family map; unknown → 8000 (under-estimate is safe). Compaction fires at `compactionThresholdFor()` = 75% of the resolved window.
- **A3 — in-flight token governor.** Every tool-loop `generateText`/`streamText` MUST attach `prepareStep: createTokenGovernor({ contextWindow, reservedOutputTokens })` ([token-governor.ts](src/lib/agent/token-governor.ts)) so the payload is pruned (pair-safe `pruneMessages` → recency window) BETWEEN steps — pre-flight compaction runs once and cannot catch in-loop growth. The per-tool output cap (`capToolResultSize`, applied inside `applyGlobalToolLoopGuard`) truncates a single oversized result head+tail. The 4 `agent.ts` callsites are wired; the MoA proposer `generateText` AND the synthesis aggregator are ALSO governed (Follow-up A3b — window via `resolveContextWindow(proposerConfig)` / `resolveContextWindow(brainConfig)`, reserve = the proposer's PM #66 output ceiling / `resolveMaxOutputTokens(brainConfig)`). **Audit:** `grep -n createTokenGovernor src/lib/agent/{agent,moa}.ts` — every tool-loop/LLM callsite that can accrete a payload must attach the governor.
- **MoA loop-guard.** `applyGlobalToolLoopGuard` lives in [tool-guard.ts](src/lib/agent/tool-guard.ts) (§4); both `agent.ts` and `moa.ts` wrap their ToolSets through it. Audit: `grep -rn applyGlobalToolLoopGuard src/lib/agent/`.

- **A4 — non-destructive compaction + role hardening.** Pre-flight compaction is **sliding-window + anchors**, NOT LLM-summarize-and-discard: `partitionForCompaction(messages, KEEP_RECENT_MESSAGES=8)` ([compressor.ts](src/lib/agent/compressor.ts)) splits history into `{ anchors (leading system msgs), evicted (middle tail), recent (last K) }`. Anchors + recent stay in the live context VERBATIM; the evicted tail is archived to RAG **TWICE** — once VERBATIM via `formatVerbatimArchive` (exact artifacts — stack traces, file contents, API keys — stay byte-for-byte retrievable, the core fix) AND once as a dense LLM summary (`compressChatHistory`, narrative continuity only). The `evicted.length > 0` guard kills the old negative-slice footgun. **Rule:** LLM-summarization is for continuity, NEVER the sole record of exact text — always pair it with a verbatim copy. On the in-flight side, [token-governor.ts](src/lib/agent/token-governor.ts) `slideToRecentWindow` preserves the same **concise-anchor** idea (PM #76 follow-up): it keeps the leading system run + first user turn (the task) VERBATIM — capped at `ANCHOR_BUDGET_RATIO` (25%) of the budget so a huge first-message paste is NOT re-pinned — then slides only the middle, and ends with `mergeConsecutiveSameRole` (from [history.ts](src/lib/agent/history.ts)) so the anchor-join can't emit consecutive same-role turns that strict models (Gemma/Anthropic — §1 MoA "no consecutive user messages") reject. Tests: `partitionForCompaction` + `formatVerbatimArchive` in [compressor.test.ts](src/lib/agent/compressor.test.ts), consecutive-role merge + PM #76 anchor preservation in [token-governor.test.ts](src/lib/agent/token-governor.test.ts).

- **Real tokenizer.** `estimateTokenCount` ([compressor.ts](src/lib/agent/compressor.ts)) uses a real BPE tokenizer — `encode` from `gpt-tokenizer/encoding/cl100k_base` (pure JS, zero transitive deps, edge-safe, server-bundled only — does NOT inflate client First Load JS). It tokenizes the text/serialized payload of every message part (A1 traversal KEPT), multiplies by `SAFETY_MARGIN = 1.15`, and memoizes per-message counts in a `WeakMap` keyed on the message object (the governor re-estimates overlapping suffixes of the SAME objects while sliding — naive re-encode is O(n²)). **Two caveats, by design:** (1) `cl100k_base` is exact for OpenAI ONLY; Llama/Gemini/Qwen tokenize denser, so the margin guarantees the pre-flight estimate never UNDER-counts (under-count = late compaction = overflow; over-count only compacts slightly early). (2) For GROUND TRUTH prefer the provider `usage` from `onStepFinish`; this estimate is only for the pre-flight + in-flight-governor path where no usage exists yet. `COMPACTION_THRESHOLD_RATIO` (0.75) and the governor budget did NOT need re-tuning — `BPE × 1.15` for English ≈ `chars / 3.48`, within a rounding error of the old `chars / 3.5`. **Perf bound:** strings longer than `EXACT_BPE_CHAR_CAP` (20 K chars) skip exact BPE and use the `chars/3.5` heuristic — exact count is moot past that size (the payload is already far over any window and will be pruned/`capToolResultSize`-truncated), and a full encode of a 40 KB+ dump under v8 coverage instrumentation can blow a 15 s per-test timeout. The heuristic OVER-counts vs BPE (safe direction). **Rule:** keep the `SAFETY_MARGIN` ≥ 1, the cap, and the array traversal; if you swap the encoding (e.g. `o200k_base` for GPT-4o-family accuracy), re-measure the round-trip fixtures. Tests: realistic-prose array-traversal + Russian/code round-trips (estimate ≥ exact BPE, ≤ exact × 1.3) in [compressor.test.ts](src/lib/agent/compressor.test.ts).

- **OpenRouter exact windows.** For the `openrouter` provider, `resolveContextWindow` reads each model's EXACT `context_length` from the live OpenRouter `/models` cache ([openrouter-pricing.ts](src/lib/cost/openrouter-pricing.ts) → `getOpenRouterContextWindow`) BEFORE falling back to the static family map — the map is a coarse per-family guess, the cache is authoritative per-model. The window rides on the SAME PM #71 `globalThis` singleton + disk cache (`data/cache/openrouter-pricing.json`, `contextLength` field) as pricing/maxOutput, so it survives a warm-cache boot and the dual-module-graph trap. `fetchOpenRouterPricing` captures top-level `context_length` (fallback `top_provider.context_length`), including for FREE models (no pricing). Empty cache (pre-fetch / Privacy Mode) → falls through to the family map, which already matches OpenRouter-prefixed ids. Tests: capture + warm-cache round-trip in [openrouter-pricing.test.ts](src/lib/cost/openrouter-pricing.test.ts); exact-window-beats-map + non-openrouter-provider-ignores-cache in [context-window.test.ts](src/lib/providers/context-window.test.ts). **🎉 Context-Management track COMPLETE — A1–A4 + A3b + real tokenizer + OpenRouter windows all shipped. No remaining sprints.**

### How to verify any context-track change
- `npm run typecheck` + `npx vitest run` (full suite must stay green; targeted: `compressor`, `context-window`, `token-governor`, `tool-guard`, `loop-guard`).
- **Live Ollama (if changing A2):** the operator runs Ollama 0.30.10 locally with `qwen2.5:latest` (runtime 4096) and `qwen2.5-large:latest` (Modelfile `num_ctx` 48000). `curl -s http://localhost:11434/api/ps` after a generation shows the real runtime `context_length`. A throwaway live test against the REAL module is the decisive check (delete it after — it hits the network).
- Boot `npm run dev` and run a real chat that exceeds the window — unit tests do NOT catch PM #4/#5-class wire bugs.

### ⚠️ Working-tree note for the next session
There is uncommitted **model-wizards WIP** (`budget-banner.tsx`, `chat-panel.tsx`, `message-bubble.tsx`, `theme-switcher.tsx`, `store/app-store.ts`) on branch `qa/sprint3-model-wizards` — it is NOT part of the context-management track and was intentionally left unstaged. Commit it separately; do not bundle it with context-track commits.

---

## 💻 Commands
- **Install (Local):** `npm run setup:local`
- **Development Server:** `npm run dev`
- **Production Build:** `npm run build` (runs lint via `prebuild` hook — fails the build on lint *errors*; warnings are allowed)
- **Start Production:** `npm run start`
- **Run Unit Tests:** `npm run test`
- **Linting:** `npm run lint` (allows warnings — this is what CI runs) / `npm run lint:strict` (`--max-warnings 0`; a **local** tidiness target, NOT wired into CI — see the "What CI actually enforces" note below).
- **TypeScript Check:** `npm run typecheck` (standalone `tsc --noEmit`)
- **Pre-Deploy Gate:** `npm run verify` (lint + typecheck + tests + build; one-stop check before shipping)
- **Scrub Secrets:** `npm run scrub:secrets` (before sharing the tree externally)
- **Reset Auth:** `npm run auth:reset` (recovery from forgotten password — see "Auth escape hatches" in Security Patterns)
- **Sync test badge:** `npm run badge:sync` (derives the README "tests" badge count from vitest's own total; `-- --check` exits non-zero if stale). The count lives ONLY in the badge — prose is number-free — so this is the single update site (QA audit F-04). Don't hand-edit the badge number. **Run it in any PR that changes the test count** — it is a *manual* hygiene step, NOT a CI gate (so it CAN drift; it had to be re-synced 2644→2701 during the 2026-06 context-management track because nothing enforced it).

### What CI actually enforces (`.github/workflows/ci.yml`)
Don't trust prose that calls something "the CI gate" — read `ci.yml`. Today it runs exactly: `npm run lint` (warnings **allowed**), `npm run test:coverage` (vitest + the per-module/global coverage floors in `vitest.config.ts`), `npm run build`, and the Playwright `e2e` job. That's it. **`lint:strict` and `badge:sync --check` are deliberately NOT in CI:** `eslint.config.mjs` keeps `no-explicit-any` / `prefer-const` / `ban-ts-comment` / `react/no-unescaped-entities` at `warn` for vendor-SDK legacy debt, and wiring `--max-warnings 0` would make CI permanently red on ~26 known warnings — the same "a permanently-red gate trains everyone to ignore it" reasoning the `audit:gate` uses for `high` advisories. Clean the warnings incrementally (the 11 dead `eslint-disable` directives were swept 2026-06; the lint config is the single rule-severity source of truth — there is no longer a vestigial `.eslintrc.json`). If you tighten `lint` toward zero warnings, wire `lint:strict` into `ci.yml` IN THE SAME PR, not before.

---
*Note for AI Assistants: Read this file entirely before making architectural changes to Orchestra. When in doubt, read the source code of `agent.ts` or `moa.ts` before writing new logic.*
