# Orchestra Swarm Engine

## 🤖 System Prompt for AI Assistants
**You are an expert AI Full-Stack Software Engineer with deep expertise in Next.js 15 (App Router), TypeScript, Zustand, and Vercel AI SDK.**
When working on this repository, you must strictly follow these rules:
- Write robust, self-healing, and defensive code.
- Avoid introducing technical debt. If a pattern exists in the codebase (e.g., `safeWriteFile`), you MUST use it rather than reinventing standard Node.js libraries.
- Prefer explicit TypeScript typing over `any` or implicit inference.
- Do not remove existing comments unless explicitly refactoring the commented logic.
- **Consult `POST_MORTEMS.md`** before refactoring core logic (especially SSE streams, MoA, or file storage) to avoid repeating known historical bugs.

---

## 📐 How this document is organized (read before adding to it)

This file is **Level 1**: it loads into every single session, so every line spends context budget that the task itself needs. Detailed contracts live in **Level 2** (`docs/references/*.md`) and are loaded on demand via the trigger tables below.

### Level 1 (this file) holds only

| Type | Example |
| --- | --- |
| Core commands | `npm run verify:strict` |
| Non-negotiable rules | every user-supplied path goes through `assertPathInside` |
| Copy-paste code patterns | the SSRF-guard call shape |
| Directory map | feature → file |
| Trigger indexes | pointers into Level 2 |

### Level 2 (`docs/references/`) holds

Full contract text, per-PM rationale, historical decisions, shipped-track narrative, edge cases, seam plans.

### When you are asked to record something here

1. **Is it a rule that applies to most sessions?** → Level 1, as one imperative line.
2. **Is it rationale, history, an edge case, or a shipped-track narrative?** → Level 2 file, plus a trigger-table row here if a new trigger appears.
3. **Is it already enforced by a CI gate?** → do not restate the rule in prose; the test is the rule. Add it to the CI-gate table below.
4. **Is the canonical source another document** (`POST_MORTEMS.md`, `docs/*.md`, git history)? → link it; do not copy it.

**Forbidden in Level 1:** shipped/merged track narratives, per-PM rationale essays, "why this is not gold-plating" arguments, status handoffs, done-work checklists. Those belong in `docs/references/session-handoff-archive.md`, `POST_MORTEMS.md`, or git history.

> Enforced by a size budget in [`src/claude-md-drift.test.ts`](src/claude-md-drift.test.ts) — the build fails when this file exceeds the budget. A prior hand-trim regrew past the limit within 15 commits because nothing enforced it.

---

## 📇 Reference index — hit a problem, start here

| Trigger | Read | Core content |
| --- | --- | --- |
| Changing `moa.ts`, proposers, Router/DPG, aggregator, Skeptic, deep-memory recall, free-tier failover | [`docs/references/moa-swarm-contracts.md`](docs/references/moa-swarm-contracts.md) | Every MoA contract: DPG, `forceSwarm`, inline-synthesis collapse, proposer grounding/pacing/breaker, degradation policy, PM #77/#85/#90/#91/#94 |
| Tool loop guard, a model that 404s on tools, a RAG loader, `computeNextRunAtMs` | [`docs/references/agent-runtime-contracts.md`](docs/references/agent-runtime-contracts.md) | Loop-guard contract, `NO_TOOL_PATTERNS`, UTF-8 loader invariant, cron `every` tick semantics |
| Adding a capability, touching a write tool, MCP, completion-honesty or hallucinated-tool-call recovery | [`docs/references/tools-and-skills.md`](docs/references/tools-and-skills.md) | Tool-vs-Skill decision tree, write-grounding (PM #80/#83), completion honesty (PM #84), printed-markup recovery (PM #81), MCP untrusted boundary (PM #27) |
| SSE, `useBackgroundSync`, any `generate*`/`stream*`/`embed*` callsite | [`docs/references/realtime-and-abort-contracts.md`](docs/references/realtime-and-abort-contracts.md) | Frontend resilience contract (PM #5), full AbortSignal propagation contract (PM #1/#23) |
| A chat is stuck, a chat vanished from the sidebar, reconstructing a run | [`docs/references/observability-runbook.md`](docs/references/observability-runbook.md) | `/api/_debug/chat/<id>` one-shot, manual fallback steps, chat-index integrity |
| New API route, user-supplied path or URL, Privacy Mode, auth, escape hatches | [`docs/references/security-patterns.md`](docs/references/security-patterns.md) | Path guard, SSRF policy, SSR leak (PM #15), Privacy-Mode air-gap (PM #47/#58), audited-route checklist, every env escape hatch |
| Adding a persistent surface under `data/`, retention, backups, schema versioning | [`docs/references/data-layout.md`](docs/references/data-layout.md) | Full `data/` table with per-directory retention, backup knobs + restore, schema-version contract, PM #71 `globalThis` rule |
| You need the full rationale behind a critical rule | [`docs/references/critical-rules.md`](docs/references/critical-rules.md) | Persistence/IO, UI sync, agent lifecycle + step budget, daemons/sweepers, UI standards, code-execution security, doc freshness, file-size discipline, pre-push hygiene |
| Touching `agent.ts`, `llm-provider.ts`, `project-store.ts`, `code-execution.ts`, `tool.ts` | [`docs/references/file-size-decomposition.md`](docs/references/file-size-decomposition.md) | Per-file seam plan, what is already extracted, pre-extraction guards |
| Compaction, token governor, context-window resolution, tokenizer | [`docs/references/context-management-track.md`](docs/references/context-management-track.md) | A1–A4 contracts in force, reliable-window clamp (PM #82/#95), OpenRouter exact windows |
| Bumping `xlsx`, or a build fails reaching `cdn.sheetjs.com` | [`docs/references/xlsx-dependency.md`](docs/references/xlsx-dependency.md) | Why it is a CDN tarball, the exact API surface in use, bump procedure |
| "Was this already decided / already built / already rejected?" | [`docs/references/session-handoff-archive.md`](docs/references/session-handoff-archive.md) | Shipped tracks, durable REJECT verdicts, open carried-over items, operator config notes |

---

### 🧭 Before you grep or open a raw file: query the graph

This repo has a knowledge-graph index at `graphify-out/graph.json` (4698 nodes, 10131 edges, built from this exact codebase — code nodes come from deterministic AST parsing of the current working tree, not a cached summary). Before running `grep`/`rg`/`find` or opening a source file to explore ("where is X defined", "how does Y work", "what calls Z"), run:

```
graphify query "<question>"       # broad: scoped subgraph for a question
graphify explain "<concept>"      # focused: one node + its neighbors
graphify path "<A>" "<B>"         # how two things connect
```

It's usually cheaper and more precise than grep output, and it's current — not something to double-check against raw source before trusting. Fall back to raw `grep`/`Read` only when the graph doesn't surface what you need, or when you're modifying/debugging specific lines and need the literal text. This applies to subagents too — include it in any subagent prompt that explores code.

Extra references: `graphify-out/wiki/index.md` for broad navigation, `graphify-out/GRAPH_REPORT.md` for a full architecture writeup. After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

### 📚 Mandatory reading order (before any non-trivial change)

1. This file (`CLAUDE.md`) — rules, commands, and the trigger indexes.
2. The Level 2 reference(s) whose trigger matches your change (tables above and at the bottom).
3. [`docs/request-flow.md`](./docs/request-flow.md) — end-to-end lifecycle of a user message: API entry → agent context → tools → prompts → MoA → response stream. The single best document for understanding how a request flows; everything else assumes you know this.
4. [`POST_MORTEMS.md`](./POST_MORTEMS.md) — every entry whose subsystem you are about to touch.
5. The actual source of the symbol you are changing (`agent.ts`, `moa.ts` are large — search for the function, do not skim).

If you cannot answer "what does the request flow look like for the change I am about to make?" — go read `request-flow.md` before writing code.

---

## 💻 Commands
- **Install (Local):** `npm run setup:local`
- **Development Server:** `npm run dev`
- **Production Build:** `npm run build` (runs lint via `prebuild` hook — fails the build on lint *errors*; warnings are allowed)
- **Start Production:** `npm run start`
- **Run Unit Tests:** `npm run test`
- **Linting:** `npm run lint` (allows warnings — this is what CI runs) / `npm run lint:strict` (`--max-warnings 0`; a **local** tidiness target, NOT wired into CI — see the "What CI actually enforces" note below).
- **TypeScript Check:** `npm run typecheck` — TWO passes: `tsc --noEmit` (the app) **and** `tsc --noEmit -p tsconfig.node.json` (which is what covers `scripts/`).
- **Pre-Deploy Gate:** `npm run verify` = **lint + tests + build**. ⚠️ It does **NOT** run typecheck — that lives only in **`npm run verify:strict`** (= lint + **typecheck** + tests + **audit:gate** + build). A `scripts/` type error (TS2352 on a `ChatMessage[]` cast) shipped through `verify` clean in 2026-07 and was caught only by running the steps by hand. **Run `verify:strict` before opening a PR; `verify` is the fast loop, not the gate.**
- **Scrub Secrets:** `npm run scrub:secrets` (before sharing the tree externally)
- **Reset Auth:** `npm run auth:reset` (recovery from forgotten password — see "Auth escape hatches" in [`docs/references/security-patterns.md`](docs/references/security-patterns.md))
- **Sync test badge:** `npm run badge:sync` (derives the README "tests" badge count from vitest's own total; `-- --check` exits non-zero if stale). The count lives ONLY in the badge — prose is number-free — so this is the single update site (QA audit F-04). Don't hand-edit the badge number. **Run it in any PR that changes the test count** — it is a *manual* hygiene step, NOT a CI gate (so it CAN drift; it had to be re-synced 2644→2701 during the 2026-06 context-management track because nothing enforced it).
- **Update the graph:** `graphify update .` after modifying code (AST-only, no API cost).

### What CI actually enforces (`.github/workflows/ci.yml`)
Don't trust prose that calls something "the CI gate" — read `ci.yml`. Today it runs exactly: `npm run lint` (warnings **allowed**), `npm run typecheck`, `npm run test:coverage` (vitest + the coverage floors in `vitest.config.ts`), `npm run build`, and the Playwright `e2e` job. **`lint:strict` and `badge:sync --check` are deliberately NOT in CI:** `eslint.config.mjs` keeps `no-explicit-any` / `prefer-const` / `ban-ts-comment` / `react/no-unescaped-entities` at `warn` for vendor-SDK legacy debt, and wiring `--max-warnings 0` would make CI permanently red on ~26 known warnings — the same "a permanently-red gate trains everyone to ignore it" reasoning the `audit:gate` uses for `high` advisories. Clean the warnings incrementally (the 11 dead `eslint-disable` directives were swept 2026-06; the lint config is the single rule-severity source of truth — there is no longer a vestigial `.eslintrc.json`). If you tighten `lint` toward zero warnings, wire `lint:strict` into `ci.yml` IN THE SAME PR, not before.

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

`data/` IS the database — there is no external DB. Its per-directory layout and retention rules are in [`docs/references/data-layout.md`](docs/references/data-layout.md).

---

## 🚨 Non-negotiables

Violating any of these causes data loss, data egress, RCE, or a silent production failure. The full rationale for each lives in the Level 2 file named on the row; **the rule itself is binding without reading it.**

### Data & filesystem
1. **`safeWriteFile`** (`src/lib/storage/fs-utils.ts`) for all critical state. NEVER raw `fs.writeFile` — concurrent writes corrupt the JSON.
2. **`assertPathInside(root, userFragment)`** for ANY user-supplied path fragment — at the route layer AND pushed down into the library that does the `fs.*` call. NEVER inline `path.resolve` + `startsWith`: without the `path.sep` suffix it is a sibling-prefix bypass (arbitrary read/delete).
   ```ts
   import { assertPathInside } from "@/lib/storage/fs-utils";
   try { const safePath = assertPathInside(KNOWLEDGE_ROOT, userSuppliedFragment); }
   catch { return Response.json({ error: "invalid path" }, { status: 400 }); }
   ```
3. **`getDataDir()` / `dataPath()`** (`src/lib/storage/data-dir.ts`) for the data root. NEVER `path.join(process.cwd(), "data")` — a fresh literal is a defect. To isolate a run set `ORCHESTRA_DATA_DIR`; **NEVER `mv`/`rm` the live `data/`** (PM #62 lost 34 real chats).
4. **Sweepers fail SAFE.** If the live keep-set can't be resolved, SKIP the destructive sweep. Never substitute an empty `Set()` — empty means "everything is an orphan".
5. **Single-process invariant.** `withFileLock` is in-process only. Do NOT deploy in cluster mode.
6. **Buffered writers install a `SIGTERM`/`SIGINT` flush** at module load (reference: `installChatStoreShutdownFlush`).

### Egress & execution
7. **`assertSafeOutboundUrl` + `AbortSignal.timeout`** on every server-side fetch of a client- or model-supplied URL — routes AND tools.
   ```ts
   import { assertSafeOutboundUrl, UnsafeOutboundUrlError } from "@/lib/security/url-guard";
   const safeUrl = assertSafeOutboundUrl(`${userBaseUrl}/api/tags`);
   const res = await fetch(safeUrl, { signal: AbortSignal.timeout(5000) });
   ```
8. **`resolveGuardedAgentSettings()`** (`src/lib/agent/agent-privacy.ts`) in the agent layer — NEVER bare `getSettings()`. Privacy Mode is an air-gap; the guard is folded into settings acquisition so it cannot be skipped. Non-agent routes that embed (`/api/memory`, project knowledge import) call the guard explicitly and 403 before embedding. **Free Mode's model overlay is applied at this same chokepoint** and **yields to Privacy Mode** — the air-gap always wins, and the guard runs on the FINAL (post-overlay) settings so a regression there still cannot ship data out.
9. **`scrubProcessEnv({ EXPLICIT_VAR })`** (`src/lib/security/scrub-env.ts`) for every child process. NEVER `env: process.env` or `...process.env`. ⚠️ The CI gate scans only `src/lib/tools` and `src/lib/providers` — a spawn added anywhere else (`src/app/api/`, `src/lib/agent/`) is **unguarded**, so apply this by hand there and widen `ROOTS` in the gate.
10. **RCE-class tools and MCP are denied to untrusted triggers by default.** Thread `context.untrustedTrigger` through EVERY delegated run — one `call_subordinate` hop must not launder the bypass. Route MCP acquisition through `getProjectMcpToolsForContext`.
11. **Wrap every untrusted external byte** — MCP tool output, tool metadata, server-authored descriptions/schemas, fetched web pages — in `<UNTRUSTED_*>` markers before it reaches the prompt.
12. **Never log, echo, or bundle** `.env.local` / `data/settings/*.json` contents.

### Agent runtime
13. **`abortSignal` on every `generateText`, `generateObject`, `streamText`, `embed`, `embedMany`.** Background tasks own a separate `AbortController` (daemon), everything else threads `req.signal`. *If you cannot answer "what cancels this stream?" you MUST NOT merge the change.*
14. **Every agent-path `ToolSet` is built by `assembleAgentToolSet`** (`src/lib/agent/agent-tools.ts`), which applies `applyGlobalToolLoopGuard` last. MoA's proposer path wraps directly. Never hand-roll an unguarded ToolSet.
15. **Tools return `{ success: false, error }` on failure — never throw.** Throwing kills the run; returning lets the agent self-heal.
16. **`stopWhen: stepCountIs(n)` — never `maxSteps`** (removed in AI SDK v5; omitting it stops after step 1 and returns empty text).
17. **`modelSupportsTools(provider, modelId)`** (`src/lib/providers/tool-support.ts`) is the ONLY tool-capability check. Never write `if (provider === "X") { supportsTools = ... }` inline. New non-tool model → add the *narrowest* substring to `NO_TOOL_PATTERNS` plus a positive case in the test.
18. **A system-limit stop is signalled by the SYSTEM, deterministically** — never rely on the model to self-report hitting a limit; it will dress it up as success.
19. **Loaders return UTF-8.** New loader tests must include a non-ASCII round-trip and assert no NULL byte / UTF-16 BOM.

### Frontend
20. **One shared `EventSource` via `useBackgroundSync`.** Never `new EventSource` in a component.
21. **Narrow Zustand selectors** — never no-arg `useAppStore()`.
22. **No polling.** Backend state change → `publishUiSyncEvent({ topic, chatId })`. If you think you need `setInterval`, you're missing that call.
23. **Lists past ~50 items** that re-render on an SSE tick must be memoised per item, paginated, or virtualised.

### Process
24. **Doc-as-code.** A PR that renames/moves/refactors anything referenced here updates the reference in the same commit. Fixing an architectural production bug requires all three: a `POST_MORTEMS.md` entry, the rule encoded in the right Level 1 or Level 2 file, and a regression test.
25. **File-size discipline.** Soft cap 800 lines per `.ts`/`.tsx`; past 1500 the file MUST be decomposed by the next substantive PR. Net growth in an already-bloated module is forbidden — extract something equivalent.
26. **Before deleting or overwriting anything in `data/`, copy it aside.** There is no undo.

---

## 🔒 Rules already enforced by CI — do not restate them in prose

These are tree-wide scans, not file lists, so new files are covered automatically. If you are tempted to write a paragraph explaining one of these rules, add a case to its test instead.

| Gate | Enforces |
| --- | --- |
| [`abort-contract.test.ts`](src/lib/agent/abort-contract.test.ts) | `abortSignal` present at every generate/stream/embed callsite under `src/` |
| [`agent-preflight-gate.test.ts`](src/lib/agent/agent-preflight-gate.test.ts) | No `src/lib/agent` module imports `getSettings` directly (Privacy-Mode chokepoint) |
| [`no-raw-process-env.test.ts`](src/lib/security/no-raw-process-env.test.ts) | No `...process.env` / `env: process.env` — **only under `src/lib/tools` and `src/lib/providers`**; spawns elsewhere are unguarded |
| [`frontend-invariants.test.ts`](src/components/frontend-invariants.test.ts) | No `new EventSource` outside `use-background-sync.ts`; no no-arg `useAppStore()` |
| [`tool-support.test.ts`](src/lib/providers/tool-support.test.ts) | Cross-provider tool-capability detection stays consistent |
| [`tool.test.ts`](src/lib/tools/tool.test.ts) | Full tool inventory + each availability gate's exact delta |
| [`claude-md-drift.test.ts`](src/claude-md-drift.test.ts) | This file's size budget + the LOC claims in the decomposition reference |
| [`untrusted-trigger-contract.test.ts`](src/lib/agent/untrusted-trigger-contract.test.ts) | `untrustedTrigger` forwarded at every delegation callsite, set at the untrusted entry, and read by both capability gates (rule 10) |

---

## 🔧 Before you change X, read Y

| You are changing | Read first | Trap that bites |
| --- | --- | --- |
| `moa.ts`, proposers, Router, aggregator, Skeptic | [`moa-swarm-contracts.md`](docs/references/moa-swarm-contracts.md) | `swarmEnabled` is per-REQUEST, never on disk — you cannot infer swarm state from the chat JSON |
| `agent.ts` turn flow, step budget, final answer | [`critical-rules.md`](docs/references/critical-rules.md) + [`realtime-and-abort-contracts.md`](docs/references/realtime-and-abort-contracts.md) | A narrating model satisfies "did we deliver an answer?" — system-limit checks must not sit behind that heuristic |
| A tool's `execute`, or adding a tool | [`tools-and-skills.md`](docs/references/tools-and-skills.md) | A write tool must report the outcome the MODEL needs, not just that the I/O landed |
| An API route touching paths, URLs, or embeddings | [`security-patterns.md`](docs/references/security-patterns.md) | List EVERY body/query field that reaches the filesystem — the second field is the one that gets missed |
| Anything persisted under `data/` | [`data-layout.md`](docs/references/data-layout.md) | Boot-warmed state read by a route must live on a `globalThis` singleton (separate module graphs) |
| Compaction, token governor, windows | [`context-management-track.md`](docs/references/context-management-track.md) | Advertised context window ≠ usable; the clamp is the safe default |
| A 1500+ LOC file | [`file-size-decomposition.md`](docs/references/file-size-decomposition.md) | Extract in two PRs: re-exporting shims first, implementation cut second |
| MCP servers or transports | [`tools-and-skills.md`](docs/references/tools-and-skills.md) | Server-authored *names, descriptions and schemas* are untrusted too, not just tool output |

---

## 📇 Reference trigger index (repeat — for long sessions)

| Trigger | File |
| --- | --- |
| MoA / swarm / proposers / Skeptic / failover | `docs/references/moa-swarm-contracts.md` |
| Loop guard / tool capability / loaders / cron | `docs/references/agent-runtime-contracts.md` |
| Tools vs Skills / write grounding / MCP | `docs/references/tools-and-skills.md` |
| SSE / AbortSignal | `docs/references/realtime-and-abort-contracts.md` |
| Stuck chat / missing chat / forensics | `docs/references/observability-runbook.md` |
| Paths / SSRF / Privacy Mode / auth / env hatches | `docs/references/security-patterns.md` |
| `data/` layout / retention / backups / schema | `docs/references/data-layout.md` |
| Full rationale for a critical rule | `docs/references/critical-rules.md` |
| God-file seam plans | `docs/references/file-size-decomposition.md` |
| Compaction / token governor / windows | `docs/references/context-management-track.md` |
| `xlsx` / SheetJS CDN | `docs/references/xlsx-dependency.md` |
| "Already decided / built / rejected?" | `docs/references/session-handoff-archive.md` |

---
*Note for AI Assistants: read this file plus the Level 2 reference whose trigger matches your change — not the whole `docs/references/` tree. When in doubt about where code lives, run `graphify query` / `graphify explain` before grepping.*
