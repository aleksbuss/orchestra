<div align="center">

# Orchestra

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-2585%20passing-brightgreen)](#tests)
[![Post-Mortems](https://img.shields.io/badge/post--mortems-70%20documented-purple)](./POST_MORTEMS.md)
[![Status](https://img.shields.io/badge/status-alpha-orange)]()

**Local-first AI workspace with a real Mixture-of-Agents pipeline.**

A team of specialized agents, not just one model. Self-hosted, BYOK, MIT-licensed.

![Orchestra answering a systems-design question — a panel of experts ran in parallel, then synthesized this answer; the token counter is live](docs/assets/orchestra-hero.png)

<sub>A real Swarm run: the prompt fans out to a Router-generated panel of experts (with a code-guaranteed Skeptic), an aggregator synthesizes the drafts, and every chat shows live token usage.</sub>
<!-- TODO(visual): swap the static hero for a short demo GIF of a live run when you record one. -->

Built on [Eggent](https://github.com/eggent-ai/eggent) (MIT) — a hard fork, substantially extended. See [`NOTICE.md`](./NOTICE.md).

[Quick Start](#-quick-start) · [Architecture](#-the-moa-pipeline) · [Features](#-features) · [Docs](#-documentation)

</div>

---

## What makes Orchestra different

Most "self-hosted ChatGPT" projects wrap a single LLM. Orchestra runs **5 specialized expert agents in parallel** on every substantive turn, with a critic that's *guaranteed by code* (not by prompt) to be present in the swarm. The aggregator then synthesizes — and if the experts diverge significantly (measured by embedding distance), the synthesizer is explicitly told to surface the conflict instead of smoothing it away. An optional reflection loop runs a critic over the aggregator's output and applies a revisor pass when issues are flagged.

If that sounds like a paper instead of a feature list — that's intentional. Orchestra is engineering-led: every architectural failure mode is documented in [`POST_MORTEMS.md`](./POST_MORTEMS.md) (70 entries and counting). The aggregator prompt is adapted from the [Together AI MoA reference](https://github.com/togethercomputer/MoA) (validated at 65.1% AlpacaEval, beating GPT-4o on OSS models). The infrastructure layer follows the published research — RadixAttention prefix-cache compatibility, Generator-Critic-Revisor (Reflexion pattern), embedding-based disagreement detection.

You bring your own keys (or run fully local with Ollama). Every chat shows token + USD cost in real time so friends sharing the instance always know what they're spending.

**Who it's for:** developers who want a self-hosted assistant that thinks harder than a single model — debugging gnarly systems problems, research that needs fact-checking before it's trusted, or private work on local models where nothing leaves your machine.

---

## 🎯 The MoA Pipeline

Every Swarm-mode turn flows through this pipeline:

```mermaid
flowchart LR
    U[User message] --> R[Router DPG<br/>utility-model]
    R -->|requiresSwarm=false| D[Direct answer<br/>brain-model]
    R -->|requiresSwarm=true<br/>+ force-injected Skeptic| P1[Proposer 1]
    R --> P2[Proposer 2]
    R --> P3[Proposer N]
    R --> PS[Skeptic<br/>guaranteed]
    P1 --> DD{Disagreement<br/>detector}
    P2 --> DD
    P3 --> DD
    PS --> DD
    DD -->|max distance &gt; 0.35| AGG_M[Aggregator + marker:<br/>'surface the conflict']
    DD -->|consensus| AGG[Aggregator<br/>brain-model]
    AGG_M --> REF{Reflection<br/>enabled?}
    AGG --> REF
    REF -->|critic flags issue| REV[Revisor<br/>brain-model]
    REF -->|clean| OUT[Final response]
    REV --> OUT
    D --> OUT
    OUT --> CB[Cost banner<br/>tokens + USD]
```

![The Swarm Activity panel, live — for a locking question the Router spun up a Database Architect, Concurrency Engineer, Performance Optimizer, and a code-guaranteed QA Auditor / Skeptic, then synthesized their drafts](docs/assets/orchestra-swarm-activity.png)

<sub>Open the **Swarm Activity** panel (top-right of any chat) to watch the run: the Router auto-generates a panel of experts tuned to the prompt, the Skeptic is always there, and the orchestrator synthesizes the drafts.</sub>

Each stage maps to a [`POST_MORTEMS.md`](./POST_MORTEMS.md) entry that documents *why* it works that way:

| Stage | What | Why it exists |
|---|---|---|
| **Router (DPG)** | Generates 3-5 hyper-specialized personas based on prompt | Static role lists miss domain-specific expertise; dynamic generation tunes per-prompt |
| **Force-injected Skeptic** | Post-validates DPG output, injects Adversarial Critic if missing | PM #37 — prompt-as-contract is unreliable; weak utility-models drop the "MUST include skeptic" instruction silently |
| **Parallel proposers** | 3-5 LLM calls fanned out via `Promise.all` with stagger + per-proposer timeout | Latency cost is parallel, not serial; 1 slow proposer doesn't block the others |
| **Disagreement detector** | Pairwise cosine distance over draft embeddings | PM #39 — academic frameworks call silent smoothing "sycophantic consensus"; threshold 0.35 catches divergent recommendations |
| **Aggregator** | Validated synthesis prompt from togethercomputer/MoA reference | PM #40 — academic literature has a benchmarked prompt; homemade prompts are slope-of-evidence |
| **Reflection critic + revisor** | Generator-Critic-Revisor (Reflexion pattern), opt-in | PM #38 — was dead code before; now wired through with cost attribution |
| **Cost banner** | Per-chat tokens + USD shown in chat header | PM #36 — operator awareness without hard caps; friends sharing the instance see spend |

---

## ⚡ Quick Start

### Local install (recommended for development)

```bash
git clone https://github.com/aleksbuss/orchestra.git && cd orchestra
npm install
cp .env.example .env.local       # add at least one provider key
npm run dev
```

> Prefer a guided setup? `npm run setup:local` (runs `scripts/install-local.sh`) installs dependencies, creates `data/`, and sets up your `.env` (provider keys + session secret). Next.js reads both `.env` and `.env.local`, so either file works.

Open [http://localhost:3000](http://localhost:3000) → complete onboarding (default credentials are `admin`/`admin`, you'll be required to change them on first login).

### Bring Your Own Key (the only setup step that matters)

```env
# Pick one or more — Orchestra works with the first key it finds:
OPENROUTER_API_KEY=sk-or-...          # recommended: 200+ models via one key
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
# Or skip cloud entirely:
# Just install Ollama (https://ollama.com) — Orchestra auto-detects localhost:11434

# Production: set a strong session secret
ORCHESTRA_AUTH_SECRET=$(openssl rand -base64 48)
```

### Full env reference

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | One of | Recommended provider (cost-flexible) |
| `OPENAI_API_KEY` | One of | OpenAI direct |
| `ANTHROPIC_API_KEY` | One of | Anthropic direct |
| `GOOGLE_API_KEY` | One of | Gemini |
| `ORCHESTRA_AUTH_SECRET` | Production | Session HMAC (`openssl rand -base64 48`) |
| `TAVILY_API_KEY` | No | Tavily web search (optional) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot gateway |
| `ORCHESTRA_AUTH_COOKIE_SECURE` | No | Force `Secure` cookie (auto-detect HTTPS otherwise) |
| `ORCHESTRA_LOG_TO_FILE` | No | Write structured JSONL logs to `data/logs/` |
| `ORCHESTRA_DATA_DIR` | No | Override the data root (default `<cwd>/data`). Point at a throwaway dir to isolate tests/dev runs without touching real data. |
| `ORCHESTRA_DISABLE_AUTH` | Local dev only | Skip auth entirely (`true`) — never enable on a reachable deployment |

---

## ✨ Features

### Core agent runtime
- **Mixture-of-Agents** with dynamic persona generation (3-5 experts per substantive turn)
- **Force-injected Skeptic** — every swarm includes a fact-checker, enforced in code
- **Disagreement detection** — cosine-distance over embeddings; aggregator surfaces conflicts explicitly
- **Reflection loop** (opt-in) — generator-critic-revisor for one extra pass when needed
- **Aggregator prompt** adapted from validated Together MoA reference
- **Swarm Delegation** — orchestrator routes tasks to specialized sub-agents
- **Loop guard** — per-tool fatal-error wrapping so bad tool calls self-heal
- **AbortSignal propagation** through every `generateText` / `generateObject` / `streamText` call

### Cost & transparency
- **Live per-chat cost banner** — tokens + USD estimate, pricing for 7 model families
- **Honest unknown-pricing labels** — when no pricing data, banner says "cost unknown", never fabricates `$0.00`
- **Auto-pilot iteration cap** at 50 — prevents runaway loops

### Workspaces & state
- **Project Workspaces** — isolated per-project memory, skills, MCP servers, file tree
- **Project ZIP Export** — one-click download of entire project as portable archive
- **Memory (RAG)** — vector embeddings over PDF/DOCX/XLSX/Markdown/images
- **Project Blackboard** — cross-agent fact-sharing storage (used by tools)

### Automation
- **Background Auto-Pilot** — daemon iterates on goal trees without UI
- **Cron Scheduler** — RRULE-based recurring agent tasks
- **Skills System** — ~30 bundled, installable from GitHub
- **Telegram Gateway** — full bot mode, group chats, voice notes
- **MCP support** — per-project MCP server config with SSRF guard

### Observability
- **`/api/_debug/chat/<id>`** — single-shot diagnostic endpoint
- **`POST_MORTEMS.md`** — 70 architectural failure modes documented with regression-test pointers
- **Structured JSONL logs** with `traceId` propagation

### Local-first design
- **No external database** — `data/` directory IS the database (atomic writes, file locks)
- **No external cache / queue / broker** — in-process state + SSE bus
- **Ollama out of the box** — auto-detect on `localhost:11434`
- **Single-process invariant** — single Node process, no cluster mode required
- **SIGTERM-flush** — graceful shutdown drains every pending write

---

## 🧪 Tests

```bash
npm test                  # full suite — currently 2,585 tests across 168 files
npm run test:coverage     # with v8 coverage
npm run typecheck         # standalone tsc --noEmit
npm run verify            # lint + typecheck + tests + build (pre-deploy gate)
```

Coverage focus:
- **High coverage:** `lib/security/`, `lib/auth/`, `lib/memory/loaders/`, `lib/storage/`, `lib/cost/`, `lib/agent/` (88% lib coverage overall)
- **Lower coverage:** end-to-end agent integration (`agent.ts`, `tool.ts`) — exercised via the live debug endpoint and the cross-concern smoke tests rather than full unit coverage

---

## 🛡 Security model

Orchestra is **designed for a single trusted operator** — your own machine, or a small VPS only you and people you trust have credentials for. The full policy is in [`SECURITY.md`](./SECURITY.md).

Key contracts (all enforced by code, with regression tests):
- **SSRF guard** — `assertSafeOutboundUrl` on every server-side `fetch` from user/model-derived URLs (PM #8, #11, #27)
- **Path traversal guard** — `assertPathInside` on every user-supplied filesystem path (PM #6, #16, #21)
- **`<UNTRUSTED_*>` markers** — every byte from external sources (MCP, web_task) is wrapped before reaching the LLM prompt (PM #26, #27)
- **Process env scrub** — every agent-spawned child process (code-execution, `install_packages`, the codex/gemini CLIs) builds its env via `scrubProcessEnv` / `cliProviderEnv`, dropping `*_KEY`/`*_SECRET`/`*_TOKEN` + the app auth secret before `spawn` (PM #28, #70)
- **Login rate-limiter** — sliding-window per-IP, with reverse-proxy configuration documented (PM #13)
- **Session-secret production guard** — refuses to boot with default secret in `NODE_ENV=production` (PM #12)

---

## 📚 Documentation

Start with **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — guided tour of the system in ~15 minutes.

| Doc | When to read |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | First time visitor; want to understand what Orchestra is and how it works |
| [`docs/request-flow.md`](./docs/request-flow.md) | Implementing or debugging a new feature; need to know the request lifecycle |
| [`docs/observability.md`](./docs/observability.md) | Operator / SRE; logging, tracing, on-disk audit trail |
| [`POST_MORTEMS.md`](./POST_MORTEMS.md) | Before refactoring core orchestration logic; every architectural bug we've hit |
| [`CLAUDE.md`](./CLAUDE.md) | Working on the codebase with AI assistance (Claude Code, Cursor, etc.); the rules a code-changing agent should follow |
| [`SECURITY.md`](./SECURITY.md) | Reporting a security issue or deploying beyond `localhost` |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Opening an issue or PR |
| [`NOTICE.md`](./NOTICE.md) | Per-directory licensing for the `bundled-skills/` collection |

---

## 🧰 Configuration recipes

The v3 and v4 features in this README are all opt-in via `data/settings/settings.json`. The UI for them lives in v3.1; until then, the recipes below are the canonical way to turn them on.

### Cost-optimized MoA (heterogeneous tiers — PM #48)

Skeptic personas run on a cheap fast tier, coder personas on a frontier tier. On reference workloads this is ~60% cheaper than uniform-frontier with no measured quality loss.

```json
{
  "proposerTiers": {
    "fast": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "apiKey": ""
    },
    "balanced": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "apiKey": ""
    },
    "frontier": {
      "provider": "anthropic",
      "model": "claude-opus-4-7",
      "apiKey": ""
    }
  }
}
```

Empty `apiKey` inherits the key from `chatModel` (same provider). Mix providers freely — fast on Anthropic, frontier on a local Qwen — Orchestra honors heterogeneous tiers.

### Air-gapped mode (PM #47)

```json
{
  "privacyMode": { "enabled": true },
  "chatModel": {
    "provider": "ollama",
    "model": "qwen2.5:7b",
    "baseUrl": "http://localhost:11434"
  },
  "utilityModel": {
    "provider": "ollama",
    "model": "qwen2.5:3b",
    "baseUrl": "http://localhost:11434"
  },
  "embeddingsModel": {
    "provider": "ollama",
    "model": "nomic-embed-text"
  }
}
```

`runAgent` refuses the run if ANY of chatModel / utilityModel / embeddingsModel / proposerTiers resolves to a non-local backend. The chat UI surfaces a 🔒 badge whenever Privacy Mode is active.

### Tournament aggregator for code/math/factual chats (PM #52)

The synthesis aggregator (default) is great for open-ended writing. For chats focused on getting **one correct answer** (bug-fixing, API design, factual lookup), tournament mode picks the best proposer draft verbatim via Borda count over K judges.

```json
{
  "aggregator": {
    "mode": "tournament",
    "tournamentJudgeCount": 3,
    "tournamentJudgeModel": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

K=1 is the cheapest (single judge picks best draft, no consensus). K=3 gives true Borda consensus and smooths individual-judge bias. Set `tournamentJudgeModel` to a fast-tier model to keep K=3 affordable.

> **Privacy Mode note (PM #54).** `tournamentJudgeModel` is now subject to the same air-gap check as `chatModel`/`utilityModel`/`embeddingsModel`/`proposerTiers` — if you have `privacyMode.enabled = true`, the judge model MUST resolve to a local backend (ollama/sglang/vllm/loopback-custom). `runAgent` refuses the call with a clear error otherwise.

### Self-verifying coder proposers (PM #50)

Lets coder-tagged proposers run Python/Node snippets to validate library APIs, output shape, and regex behavior before drafting. Default off because each proposer × child process is a heavier failure surface than `search_web`.

```json
{
  "codeExecution": {
    "enabled": true,
    "timeout": 600,
    "maxOutputLength": 120000,
    "proposerAccess": true
  }
}
```

The orchestrator already had `code_execution`; this extends it to MoA proposers. Concurrency naturally capped by the agent semaphore (2 permits across proposer turns; each proposer can still make multiple sequential `code_execution` calls within its own turn).

> **Risky combo with tournament mode (PM #54).** If you also set `aggregator.mode = "tournament"`, ALL coder proposers run code in the same project cwd but only the WINNING draft's text is shown. Losing proposers' side effects (files written, packages installed) PERSIST in the project. Per-proposer sandboxing is tracked as future work. For now, prefer synthesis mode when `proposerAccess` is on, or accept the trade-off and audit the cwd after big chats.

### Trace memory — DSPy-style fewshots from your own runs (PM #51)

Captures successful MoA runs and injects the top-K most similar past traces as Router few-shots. Quality-gated by signals from the run itself (proposer consensus, clean critic, no reflection cap).

```json
{
  "traceMemory": {
    "enabled": true,
    "qualityThreshold": 0.7,
    "retrievalK": 3
  }
}
```

Inspect / curate the pool from the command line:

```bash
npm run trace:list                          # global pool (default)
npm run trace:list -- --all                 # global + every project's pool
npm run trace:list -- --project <id>        # one project's pool
npm run trace:show -- <id>                  # full trace (across scopes if needed)
npm run trace:stats -- --project <id>       # pool size, score distribution
npm run trace:delete -- <id> --project <id> # remove one trace from a project's pool
npm run trace:clear -- --project <id>       # wipe one pool (typed confirmation)
```

Trace pools are scoped (PM #55) — captures from project-owned chats land under `data/projects/<id>/.orchestra_traces/` and retrieval for that project ONLY reads from its own pool, so unrelated projects don't poison each other's Router prompt. Global chats (no projectId) use `data/traces/`. Operator-controlled retention.

### Multi-round reflection (PM #46)

Loop the critic-reviser until the answer converges or hits a hard cap. Default cap is 1 (single pass — PM #38). Set higher when running local models where the per-iteration cost is electricity.

```json
{
  "reflection": {
    "enabled": true,
    "maxRounds": 5,
    "convergenceThreshold": 0.97
  }
}
```

The code-level hard cap (`ABSOLUTE_MAX_REFLECTION_ROUNDS = 50`) overrides any operator value — protects against config typos.

### Diagnostics

```bash
curl http://localhost:3000/api/health | jq    # subsystem report incl. tier/trace/aggregator state
npm run trace:stats                            # trace pool health
npm run evals -- --case "<name>"               # behavioral regression sanity
```

The `/api/health` endpoint now surfaces aggregator mode, trace-memory pool size, and OpenRouter pricing-cache age (PM #53) — useful for operator-driven checks without grepping `data/`.

---

## 🛣 Roadmap

**v2.0 — Wire what's built** (shipped — PM #36–#40)
- [x] Soft per-chat cost banner with multi-provider pricing
- [x] Force-injected Skeptic in DPG output
- [x] Reflection loop wired (generator-critic-revisor)
- [x] Embedding-based disagreement detection
- [x] Validated togethercomputer/MoA aggregator prompt

**v2.1 — Measurement & quality** (shipped)
- [x] Eval harness — assertion-based regression suite (PM #41, 10 cases + 31 test pinning)
- [x] Tools inside proposers — `search_web` for reviewer + researcher with Fact-Check Mandate (PM #42); `code_execution` for coder with Code-Exec Mandate, opt-in via `proposerAccess` (PM #50)
- [x] **Live-pricing fetch from OpenRouter** `/api/v1/models` (PM #49 — 24h cache, disk-warm, Privacy-Mode-aware)

**v3.0 — Local-first power mode**
- [x] SGLang / vLLM backend (PM #43, v0.2.0 — prefix-cache reuse for free 3-6× throughput on consumer GPUs)
- [x] Hardware auto-detect at startup (PM #44 — "I see your RTX 4090, here are 3 recommended MoA configs")
- [x] **Unlimited refinement toggle** (PM #46 — multi-round reflection with cosine-convergence + hard cap)
- [x] **Privacy mode** (PM #47 — runAgent refuses non-local providers when `privacyMode.enabled`; UI badge)
- [x] **Per-role tier model routing** (PM #48 — Skeptic → fast, Coder → frontier; Anthropic's Opus/Sonnet pattern; cost-shape win)

**v4.0 — Strategic bets**
- [ ] LoRA-swap personas (one base model + persona adapters)
- [x] **Persistent successful-trace memory** (PM #51 — DSPy-style bootstrap fewshot; quality-gated capture + cosine retrieval; Privacy-Mode-safe)
- [ ] Staircase streaming (NeurIPS 2025 — aggregator starts before proposers finish)
- [x] **Tournament aggregator** (PM #52 — Borda count over K judges; K=1 cheap "judge picks best", K=3 consensus; falls back to synthesis on failure; trace-memory & Privacy-Mode compatible)

---

## Status

**Alpha quality.** Architecture is end-to-end functional and exercised across 2,585 tests. **Not production-grade** for multi-tenant or untrusted-network deployment — see [`POST_MORTEMS.md`](./POST_MORTEMS.md) for known gaps and the trust model in [`SECURITY.md`](./SECURITY.md).

Solo developer project. PRs welcome; review on a best-effort basis.

---

## License

[MIT](./LICENSE) — do whatever you want, just keep the notice.

**Important:** [`bundled-skills/`](./bundled-skills/) contains components under their own licenses (some proprietary, some MIT, some unlicensed). See [`NOTICE.md`](./NOTICE.md) for a per-directory breakdown. The MIT grant on Orchestra does NOT extend to those skills.
