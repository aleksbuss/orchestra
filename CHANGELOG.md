# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.9.0] - 2026-06-12

### Added
- **Live OpenRouter pricing cache** — 24h-cached `/api/v1/models` snapshot so the cost banner prices 300+ models without hardcoding (PM #49).
- **Tournament aggregator** — Borda-count ranking as an alternative MoA aggregation mode (PM #52).
- **Persistent trace memory** — successful MoA runs stored as DSPy-style few-shots for the Router, with per-project scoping + cache invalidation (PM #51, #55).
- Coder proposers receive `code_execution` + an execution mandate (PM #50).
- Per-chat hard USD cap (`costGuard.maxUsdPerChat`) + budget guard (Sprint 2).
- Lifecycle hardening — multi-process guard, boot-probe timeouts, cron heartbeat, recurring ghost-sweeper (Sprint 2).
- `data/` retention sweepers (orphan queue + chat-files, tmp), 11-subsystem health probes, JSONL logger redaction, postmortem auto-dump cap, data-layout docs (Sprint 5–7).
- **SSRF-safe `fetch_webpage` tool** — the Skeptic verifies raw sources; model-supplied URLs go through the outbound-URL guard + untrusted-content markers (PM #73).
- Soft-delete for chats — `deleteChat` moves to `data/.trash/` with a 30-day sweep; accidental deletions are recoverable (PM #63).
- `brew` kind for `install_packages` (macOS system CLIs).
- `E2E_PORT` env for the Playwright suite; `npm run test:e2e`.

### Changed
- Modernized ~20 dependencies — Vitest 1→3, React 19.1→19.2, AI SDK family bumps (Sprint 6).
- Decomposed `moa.ts` into `moa-personas` / `moa-proposer-tools` / `moa-router` (PM #57).

### Fixed
- **Final answer now reaches the chat even when the model emits the `response` call as text** (JSON blob or `<call:…>`); non-tool models get a tool-free prompt instead of the tool-mode prompt (PM #61).
- **Cost banner showed "cost unknown" for OpenRouter** — the pricing cache lived in per-bundle module state; moved to a `globalThis` singleton shared across Next.js module graphs (PM #71), with a 6h forced refresh (PM #75).
- Direct-key pricing table covers gpt-4.1 / o3 / o4 / gemini-2.5-flash; expensive o3-pro/o1-pro no longer shadowed by the cheap bare o3/o1 prefixes.
- Cron `every`-tick performance: day-skip lookahead + O(1) impossible-expression reject (PM #74).
- "Download project" was an opacity-0 hover-only button — now discoverable (PM #72).
- Frontend re-render storm fixed by narrowing Zustand subscriptions to `useShallow` selectors.
- `/api/health` reports the version from `package.json` (was hardcoded), and the disk-space health test no longer depends on the host machine's real disk usage.
- Recursive-subordinate billing leak — spend bubbles up to the real parent chat through every level (PM #54, Sprint 8–9).
- Fail-safe sweepers — a transient FS error no longer mass-deletes queue + chat-files (PM #60).
- Privacy Mode air-gap now enforced on cron + Telegram + subordinate entry points, not just `runAgent` (PM #58).
- Auto-pilot iteration cap is no longer a silent no-op (PM #59).
- Auto-continuation token usage folded into per-chat cumulative cost (ultrareview bug_005).

### Security
- 11 hardening sprints: Next.js RCE patch + SSRF guards on diagnostics/health (Sprint 1); `pdfjs-dist` 2.x→4.x (ESM), `happy-dom` VM-context-escape patch, `xlsx` 0.18.5→0.20.3 via SheetJS CDN; `npm audit` gate wired into `verify:strict`.
- Closed 3 CRITICAL cap-bypasses + 3 HIGH from an independent security review, plus a path-traversal gap on `GET /api/files` (PM #16 follow-up).
- Secrets scrubbed from ALL agent-spawned subprocess envs — `install_packages` and the codex/gemini CLI providers included (PM #70); scrub-env moved to `src/lib/security/`.
- lodash prod-deps high (prototype pollution) closed via npm override; internal launch artifacts purged from the repository and its full git history.

## [0.3.0] - 2026-05-28

### Added
- **Privacy Mode** — air-gapped MoA with runtime enforcement: refuses any non-local backend across chat / utility / embeddings / proposer-tiers / tournament judge when enabled (PM #47).
- **Per-role tier model routing** — heterogeneous proposers across fast / balanced / frontier tiers (PM #48).
- Multi-round reflection with cosine-convergence detection + a hard round cap (PM #46).

## [0.2.0] - 2026-05-28

### Added
- **Mixture-of-Agents pipeline** — Dynamic Persona Generation, parallel proposers, force-injected Skeptic auditor (PM #37), generator–critic–revisor reflection (PM #38), embedding-based disagreement detection (PM #39), validated aggregator adopted from the togethercomputer/MoA reference (PM #40).
- **Soft per-chat budget banner** — live token + USD estimate (PM #36).
- **`web_task`** — autonomous browser automation (Playwright) with SSRF guard, untrusted-content markers, and abort/timeout (PM #26).
- Role-based proposer tools + Fact-Check Mandate (PM #42).
- SGLang + vLLM as first-class providers, with local-backend auto-detect (PM #43).
- Hardware fingerprint → per-host MoA config suggestions (PM #44).
- Assertion-based MoA regression eval suite (PM #41).
- Auth escape hatches (`ORCHESTRA_DISABLE_AUTH`, `npm run auth:reset`), Force Swarm override, and full abortSignal propagation.
- Project ZIP export; auto-fallback on model failure (deprecated / no-tool-support).

### Changed
- `verify` split into pragmatic and `verify:strict` variants.
- Renamed to Orchestra; Node 22 baseline; CLAUDE.md brought under version control.

### Fixed
- PM #5 SSE visibility-resync (two-layer coverage); PM #22–#35 audit batch (9 fixes); `mustChangeCredentials` now gates the API surface, not just the UI (PM #25); `forceSwarm` forwarded through background / Auto-Pilot dispatch (PM #22).

### Security
- SSRF guards on diagnostics / health / `web_task`; path-traversal guards via `assertPathInside`; the `<UNTRUSTED_*>` content-boundary protocol for MCP + browser output (PM #26, #27).

## [0.1.2] - 2026-03-06

### Added
- Dark mode toggle in `Dashboard -> Settings -> Appearance`.
- Saved theme is applied on app layout load (`<html class="dark">`) for consistent rendering.

### Changed
- Python code execution now prefers project-local virtualenv interpreters (`.venv`/`venv`) when present.
- Python dependency recovery now includes project-local venv fallback for environments where system pip is blocked.
- Prompt guidance updated to use `install_packages(kind=python)` and virtualenv fallback when needed.

### Fixed
- Project file tree now hides `.venv` and `venv` directories alongside `.meta`.

## [0.1.1] - 2026-03-03

### Added
- `PUT /api/projects/[id]/mcp` endpoint for saving raw MCP config content.
- Inline MCP JSON editor with save/reset in `Dashboard -> MCP`.
- Inline MCP JSON editor with save/reset in project details context panel.
- Editable project instructions with save/reset in project details.
- Release documentation set in `docs/releases/`.

### Changed
- MCP content validation and normalization before writing `.meta/mcp/servers.json`.
- Package/app health version updated to `0.1.1`.
