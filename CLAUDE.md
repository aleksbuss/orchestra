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
- **Aggregator Constraint:** The Aggregator must NOT be fed consecutive user messages (crashes strict models like Gemma).

### 2. Project Blackboard (`src/lib/memory/blackboard.ts`)
- **Shared Fact Storage:** Agents write to `.orchestra_blackboard.json` using vector embeddings. This allows independent agents to share and retrieve canonical truths across the entire project lifecycle without relying on linear chat history.

### 3. Fact-Checking Mandate (`src/prompts/system.md`)
- The Orchestrator operates under a strict mandate: *Never guess library versions or syntax*. If the `search_web` tool is available, the agent MUST use it to verify documentation before streaming code.

### 4. Loop Guard Middleware (`src/lib/agent/agent.ts` — `applyGlobalToolLoopGuard`)
- There is NO standalone `loop-guard.ts` source file — the middleware lives inside `agent.ts` as `applyGlobalToolLoopGuard()` and wraps every `ToolSet` before it reaches `generateText`. The `loop-guard.test.ts` file inlines a copy of the conversion logic to test it without pulling in the full agent module.
- **Contract:** tools wrapped by the guard must return `{ success: false, error: "..." }` on failure rather than throwing. Throwing kills the run; returning lets the agent self-heal in the next iteration.
- **When refactoring:** every code path that builds a `ToolSet` for an agent invocation MUST pipe it through `applyGlobalToolLoopGuard` before passing to `generateText`. To audit, run `grep -n applyGlobalToolLoopGuard src/lib/agent/agent.ts` — every callsite that constructs tools should appear. Adding a new `runAgent`-like flow without the wrap silently re-introduces fatal-throw behavior.
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

**MCP-specific contract (PM #27):** MCP servers are external processes whose configs are agent-writable via `upsert_mcp_server`. Therefore both PM #8 and PM #26 contracts apply to the MCP boundary, no exception:
- Every HTTP MCP transport URL goes through `assertSafeOutboundUrl` (live: [`src/lib/mcp/client.ts`](src/lib/mcp/client.ts) → `createTransport`). Cloud metadata, RFC 1918, and IPv4-in-IPv6 bypass forms are rejected. STDIO transports skip this — they have no URL.
- Every byte returned by an MCP tool is wrapped in `<UNTRUSTED_MCP_TOOL_OUTPUT server="..." tool="...">...</UNTRUSTED_MCP_TOOL_OUTPUT>` before it reaches the agent prompt, via the `wrapUntrustedMcpOutput` helper. Orchestra-authored prefixes (`[Loop guard]`, `[Preflight]`, `[Hint]`) stay OUTSIDE the marker — they are authoritative. Output > 100KB is truncated INSIDE the marker so the truncation note cannot be mis-trusted as a delimiter.
- The agent's system prompt has a global `<untrusted_content_protocol>` section ([`src/prompts/system.md`](src/prompts/system.md)) that codifies the rule for ALL `<UNTRUSTED_*>` markers (MCP, web_task, future tools). When you add a new boundary, the wrapper helper + a marker name (`<UNTRUSTED_<FAMILY>>`) is the entire integration.

**Test coverage today:**
- Tools: most are unit-tested (88% lib coverage). Tools that touch network or browsers (`web_task`) have both mock-based unit tests AND real-Playwright integration tests.
- Skills: structural validation only (PM #24) — every `SKILL.md` is parsed and required frontmatter fields are checked. We deliberately do NOT exercise the underlying CLI binary in CI because that would require installing dozens of external dependencies. The skill body is operator-facing markdown; the agent reads it as system-prompt context, not executable code.

---

## 🔄 Realtime & Frontend Resilience Contract

The frontend runs a **single shared `EventSource`** per tab (`src/hooks/use-background-sync.ts`). The SSE bus is fire-and-forget — it has no replay buffer, so any event missed during a network blink is gone. The disk JSON in `data/chats/<id>.json` is the source of truth; the frontend must reconcile against it after every gap.

**Already implemented (do not regress):**
- **Single connection invariant** — never instantiate `new EventSource(...)` in components. Browsers cap at 6 HTTP/1.1 connections per origin; one runaway component takes down the bus. Always go through `useBackgroundSync`.
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

- Every `generateText` call receives `abortSignal`. **Every `generateObject` and `streamText` call too** (PM #23 — the original contract said "generateText"; the inner Router uses `generateObject`, which silently leaked for six months).
- Every tool implementation receives and respects `abortSignal` (long `fetch`, child processes, sleeps).
- Every iteration of `src/lib/agent/daemon.ts` and `src/lib/cron/runtime.ts` checks `signal.aborted` between hops.
- Background tasks that outlive a single request use a **separate `AbortController`** owned by `daemon.ts`, NOT `req.signal` — the request finishes, but the daemon keeps running. This is the one exception.

**Pre-merge audit (PM #23).** Run on every PR that touches `src/lib/agent/` or `src/lib/tools/`. The brittle awk-based grep that used to live here gave false positives on multi-line argument blocks; use this Node bracket-balanced variant instead:
```bash
for f in src/lib/agent/agent.ts src/lib/agent/moa.ts src/lib/agent/compressor.ts src/lib/agent/reflection.ts src/lib/agent/moa-router.ts; do
  node -e "
    const fs = require('fs');
    const src = fs.readFileSync('$f', 'utf8').split('\n');
    let inCall=false, depth=0, callStart=0, hasSignal=false, total=0, missing=[];
    for (let i=0; i<src.length; i++) {
      const L = src[i];
      if (!inCall && /(await\s+generateText|await\s+generateObject|streamText)\s*\(/.test(L)) {
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
All five orchestration files should report `missing=0`. If not, that's the leak.

**PM #23 closed (2026-05-28 audit):** both `runAgentText` ([agent.ts:1833](src/lib/agent/agent.ts#L1833)) and `runSubordinateAgent` ([agent.ts:1992](src/lib/agent/agent.ts#L1992)) accept `abortSignal?: AbortSignal` and plumb it into their inner `generateText` calls. Callers (`cron/service.ts`, `external/handle-external-message.ts`, `tools/call-subordinate.ts`) thread the appropriate signal — daemon's `AbortController` for cron, `req.signal` for the rest. Don't reintroduce the gap.

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
| `data/cache/openrouter-pricing.json` | `cost/openrouter-pricing.ts` | PM #49 — live OpenRouter `/api/v1/models` pricing snapshot. Overwritten on each boot refresh (single file, bounded ~200 KB). The in-memory map lives on `globalThis` (PM #71), NOT a module-level `let` — see rule below. | Single overwritten file — bounded by construction, not swept. |

**Boot-warmed, route-read module state MUST live on `globalThis` (PM #71).** Next.js bundles `instrumentation-node.ts` and the API route handlers into SEPARATE module graphs, so a module-level `let` warmed at boot (e.g. `refreshOpenRouterPricingCache()` from instrumentation) is a DIFFERENT instance than the one a request handler imports — the handler's copy stays empty. PM #71 was exactly this: the OpenRouter pricing cache showed `337 models priced` in `/api/health` (warmed instance) while every chat's cost banner read an empty map (route instance) and showed "cost unknown" for a year. Fix: store such state on a `Symbol.for(...)`-keyed `globalThis` singleton (one per process, shared across instances). Symptom signature to watch for: a cache `/api/health` reports as full but every consumer sees empty. Any new boot-initialized singleton (pricing, embeddings cache, model catalogs) follows this.
| `data/traces/<id>.json` | `agent/trace-memory.ts` | PM #51 — global MoA trace pool (runs without `projectId`). Used as few-shots for the Router in global chats. | Operator-controlled — `npm run trace:clear --global` to reset. Not auto-swept. |
| `data/projects/<projectId>/.orchestra_traces/<id>.json` | `agent/trace-memory.ts` | PM #55 — per-project MoA trace pool. Captures from project-owned chats land here so traces don't cross-pollute between unrelated projects. | Operator-controlled — `npm run trace:clear -- --project <id>`. Deleted with the project. |
| `data/chat-files/<chatId>/` | `storage/chat-files-store.ts` | User uploads attached to a single chat (images, PDFs, audio for STT). Referenced by the chat as `Attachment`s with path `data/chat-files/<chatId>/<file>`. | **Sweeper added Sprint 5** — `sweepOrphanChatFiles` removes `<chatId>/` directories absent from chat-index. Atomic deletion piggybacks on `deleteChat` for the live path; the sweep handles crash-leaked dirs from before that landed. |
| `data/snapshots/<projectId>/<snapshotId>.{json,zip}` | `storage/snapshots.ts` | Pre-write snapshots taken before destructive project operations (e.g. file overwrite) so the operator can roll back. | **Self-pruning** — `pruneSnapshots()` keeps a per-project FIFO ring buffer of `MAX_SNAPSHOTS_PER_PROJECT = 200` pairs. Fires after every `snapshotBeforeWrite`. No sweeper needed. |
| `data/postmortems/<traceId>.json` | `observability/postmortem.ts` | PM #31-era operator artifact — when an agent run errors out, the postmortem dumps the request snapshot + sanitized settings + last 200 log lines scoped to the `traceId`. Operator inspects via the dashboard. | **Self-pruning** — `prunePostmortems()` keeps a FIFO ring buffer of `MAX_POSTMORTEMS = 500` files (sorted by mtime descending; oldest evicted). Fires fire-and-forget from `dumpPostmortem` after every successful write — same posture as `pruneSnapshots`. Per-file size is also capped (`MAX_CHAT_EMBED_BYTES = 250 KB`, `MAX_LOG_ENTRIES = 200`). No sweeper needed. |
| `data/npm-cache/` | (none — runtime artifact) | Created by npm/pnpm when `install-orchestrator` shells out to install packages on behalf of the agent. Contents are vanilla package-manager cache files, not Orchestra state. | **Ephemeral / operator-local.** Safe to `rm -rf` at any time; the next install repopulates. Excluded from backups; not user data. |

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
- **Zustand store subscriptions MUST be narrow.** Never call `useAppStore()` with no selector — that subscribes to the WHOLE store, so the component re-renders on EVERY `set()` (e.g. a `chats`-list update from an SSE tick) even for fields it doesn't read. The heaviest offender was `chat-panel` re-rendering on every chat-list change while not reading `chats` at all. Select exactly what you use via `useAppStore(useShallow((s) => ({ … })))` (`zustand/react/shallow`); actions are stable refs so they're free to include. Pre-merge grep: `grep -rn "useAppStore()" src/` must return zero hits.

### 6. Security (Code Execution Tool)
- The `code-execution` tool runs via `child_process.spawn`.
- **Docker Privilege:** In the official Docker environment, the `node` user has passwordless `sudo` (`NOPASSWD: ALL`) to allow the agent to install `apt` dependencies on the fly. 
- **Environment scrubbing (PM #28, PM #70):** ALL agent-spawned processes (Python, Node.js, terminal, login-shell PATH probes, the `install_packages` orchestrator — npm/brew/pip post-install hooks run arbitrary code — **and the codex/gemini subprocess CLIs** via `cliProviderEnv(provider)`, which keeps only that CLI's own auth vars) construct their env via the scrubbers in [`src/lib/security/scrub-env.ts`](src/lib/security/scrub-env.ts) (a leaf security util — both `tools/` and `providers/` depend on it; `scrubProcessEnv` re-exported from `code-execution.ts` for back-compat), NOT by spreading `process.env`. The scrubber drops underscore-bounded `KEY/SECRET/TOKEN/PASSWORD/PASSWD/CREDENTIAL(S)/PRIVATE` names and a small explicit always-scrub list (`ORCHESTRA_AUTH_SECRET`, `ORCHESTRA_SESSION_SECRET`, `AUTH`, `AUTHORIZATION`), and keeps base vars (PATH, HOME, npm_config_*, HOMEBREW_*). LOCAL-mode installs no longer leak the operator's `.env`. Docker installs were already isolated; the helper is now the same posture everywhere by construction. **Pre-merge grep BOTH forms** — `...process.env` AND `env: process.env` (the latter slipped PM #70).
- **Adding a new child-process tool:** call `scrubProcessEnv({ EXPLICIT_VAR: "value" })` for any var that legitimately needs to be exposed (e.g. `VIRTUAL_ENV`); never write `env: process.env`. Pre-merge grep: `grep -rn "\.\.\.process\.env" src/lib/tools/` should return zero hits outside the scrubber callsites listed in PM #28.
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

**`src/lib/agent/agent.ts` (~1860 LOC, 9 hot edits in 90d)** — orchestration core, every chat turn flows through it.
- **Phase 1 DONE:** message/response helpers (`stripThinkingTags`, `unwrapSerializedResponseCall` PM #61, `getLast*`/`extract*` text helpers, `shouldAutoContinueAssistant`, `turnHasDeliverableAnswer` + `resolveTurnContinuation` PM #36/#69) → [`agent-response.ts`](src/lib/agent/agent-response.ts).
- **Phase 2 DONE:** `ChatMessage`↔`ModelMessage` conversion + the per-turn LLM request logger → [`agent-messages.ts`](src/lib/agent/agent-messages.ts).
- Both extractions are behavior-preserving (full suite green) and re-exported / re-imported so callers are unaffected. The remaining seams below are higher-risk — they restructure `runAgent`'s control flow, not pure helpers.
- Natural seams:
  - `agent-stream.ts` (~500): the `streamText` + SSE plumbing block at L1540, including the `pendingChatErrorClassification` writeback path.
  - `agent-fallback.ts` (~400): the model-fallback retry chain. Touches PM #17 (`modelSupportsTools`) — keep both branches honest.
  - `agent-tools.ts` (~300): `ToolSet` assembly + the `applyGlobalToolLoopGuard` wrap. Every callsite that builds tools for `generateText` MUST go through here (CLAUDE.md §4).
  - `agent-core.ts` (~500): the `runAgent` orchestrator that composes the above.
  - `agent.ts` itself shrinks to a re-export facade ≤200 LOC.
- Pre-extraction guard: run `grep -n applyGlobalToolLoopGuard src/lib/agent/agent.ts` BEFORE and AFTER — same callsite count, all routed through `agent-tools.ts`.
- Pre-extraction guard 2: PM #23 audit grep must report `missing=0` across every new file (see "AbortSignal Propagation Contract" above).
- Test scaffolding: [`agent.integration.test.ts`](src/lib/agent/agent.integration.test.ts) **EXISTS (generateText path)** — it mocks `createModel` → `MockLanguageModelV3` and drives `runAgentText` end-to-end against an isolated `ORCHESTRA_DATA_DIR`, asserting settings → tools+loop-guard → generateText → agent-response unwrap returns the answer. A regression in agent-messages/agent-tools/agent-response/createModel blows it up. **Still TODO before the agent-stream cut:** a streamText variant (interactive `runAgent` → `onFinish` → message persisted) — build it alongside the agent-stream extraction.

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

## 💻 Commands
- **Install (Local):** `npm run setup:local`
- **Development Server:** `npm run dev`
- **Production Build:** `npm run build` (runs lint via `prebuild` hook — fails the build on lint *errors*; warnings are allowed and counted in CI)
- **Start Production:** `npm run start`
- **Run Unit Tests:** `npm run test`
- **Linting:** `npm run lint` (allows warnings) / `npm run lint:strict` (zero warnings — CI gate)
- **TypeScript Check:** `npm run typecheck` (standalone `tsc --noEmit`)
- **Pre-Deploy Gate:** `npm run verify` (lint + typecheck + tests + build; one-stop check before shipping)
- **Scrub Secrets:** `npm run scrub:secrets` (before sharing the tree externally)
- **Reset Auth:** `npm run auth:reset` (recovery from forgotten password — see "Auth escape hatches" in Security Patterns)

---
*Note for AI Assistants: Read this file entirely before making architectural changes to Orchestra. When in doubt, read the source code of `agent.ts` or `moa.ts` before writing new logic.*
