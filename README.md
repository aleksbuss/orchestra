# Orchestra

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-1430%20passing-brightgreen)](#tests)
[![Status](https://img.shields.io/badge/status-alpha-orange)]()

> Local-first AI agent workspace with Mixture-of-Agents orchestration.

Orchestra is a self-hosted AI workspace for building and running a team of focused agents. It runs entirely on your machine — no cloud dependency, no external database — and supports any OpenAI-compatible provider (OpenRouter, Ollama, Anthropic, Google, and more).

## Why I built this

Solo pet project, exploring two questions: **(1)** how far can a Mixture-of-Agents architecture be pushed if you treat the router as a dynamic persona generator (DPG) instead of a static role allocator, and **(2)** what does "local-first" look like when the entire database is JSON-on-disk and the only realtime layer is SSE? Built in TypeScript strict mode, ~1400 tests, and a [`POST_MORTEMS.md`](./POST_MORTEMS.md) registry that documents every architectural bug found along the way. Alpha quality — not production-grade — but coherent end-to-end.

## Demo

<!-- TODO: Add a 30-60s screencast or animated GIF showing the MoA-swarm
     visualization here. The Swarm Activity panel running a real query is
     the most distinctive view of the project. Place under docs/assets/. -->

<!-- Screenshots placeholder — drop 3-4 images under docs/assets/ and embed them:
     - The chat with a swarm response
     - The Swarm Activity panel (vertical DAG, Router → proposers → aggregator)
     - The Projects dashboard
     - The Skills installer pulling from GitHub
-->

> _Screenshots and demo GIF coming soon — see [issue #1](#)._

## Features

- **Mixture-of-Agents (MoA)** — Parallel expert consultation with dynamic persona generation
- **Swarm Delegation** — Orchestrator routes tasks to specialized sub-agents (researcher, coder, reviewer)
- **Project Workspaces** — Isolated environments with per-project memory, skills, and file trees
- **Tool Execution** — Code execution, web search, file operations, and custom MCP servers
- **Goal Trees** — Autonomous multi-step task decomposition and execution
- **Deep Memory** — RAG-based vector memory with automatic context compaction
- **Background Mode** — Auto-pilot daemon for long-running tasks
- **Cron Scheduler** — Recurring agent tasks with RRULE support
- **Skills System** — Installable capability modules (GitHub, Slack, Telegram, etc.)
- **Telegram Integration** — Full bot gateway with webhook support

## Quick Start

```bash
# Clone the repository
git clone <repo-url>
cd orchestra

# Install dependencies
npm install

# Copy environment template
cp .env.example .env.local

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and complete the onboarding wizard.

## Configuration

### Required

Set at least one AI provider API key in `.env.local`:

```env
OPENROUTER_API_KEY=sk-or-...
# or
OPENAI_API_KEY=sk-...
# or configure Ollama for fully local inference
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | One of | OpenAI API key |
| `OPENROUTER_API_KEY` | One of | OpenRouter API key (recommended — access to 200+ models) |
| `ANTHROPIC_API_KEY` | One of | Anthropic API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | One of | Google AI API key |
| `ORCHESTRA_AUTH_SECRET` | Production | Session signing secret (`openssl rand -base64 48`) |
| `TAVILY_API_KEY` | No | Tavily API key for enhanced web search |

## Tech Stack

- **Runtime:** Next.js 15 (App Router, Turbopack)
- **Language:** TypeScript 5 (strict mode)
- **AI SDK:** Vercel AI SDK 5
- **State:** Zustand v5
- **Storage:** Local JSON filesystem with `withFileLock` + `safeWriteFile` (no database required)
- **Realtime:** Single shared `EventSource` per tab, SSE bus with reconnection backoff
- **Styling:** Tailwind CSS v4 + shadcn/ui + Radix primitives
- **Testing:** Vitest (1430 tests across 113 files)

## Tests

```bash
npm test                  # full suite
npm run test:coverage     # with v8 coverage
```

Coverage is highest in security-critical paths (`lib/security`, `lib/auth`, `lib/memory/loaders`, `lib/storage`) and lowest in the agent integration surface (`agent.ts`, `tool.ts`) — by design, those are exercised end-to-end manually for now.

## Documentation

- [`SECURITY.md`](./SECURITY.md) — security model and reporting process
- [`POST_MORTEMS.md`](./POST_MORTEMS.md) — registry of architectural bugs found in development, with root causes and regression-test pointers
- [`docs/request-flow.md`](./docs/request-flow.md) — end-to-end lifecycle of a user message from API entry through MoA to response stream
- [`docs/observability.md`](./docs/observability.md) — logging, tracing, and on-disk audit trail

## Security Model

Orchestra is **designed for a single trusted operator** — your own machine, or a small VPS only you and people you trust have credentials for. See [`SECURITY.md`](./SECURITY.md) for the full policy.

## Status

Alpha. The architecture is end-to-end functional but not battle-tested under load. Known gaps tracked in [`POST_MORTEMS.md`](./POST_MORTEMS.md). Built as a single-developer exploration; PRs welcome but I won't promise rapid review.

## License

[MIT](./LICENSE) — do whatever you want, just keep the notice.
