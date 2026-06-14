# Orchestra Swarm Engine — QA Audit (Google-Standard)

**Date:** 2026-06-14
**Auditor role:** Senior QA Engineer (Google Testing Standards, OWASP Top 10)
**Scope:** Full repository — backend orchestration, storage, providers, API routes, frontend, security, test infrastructure.
**Method:** Evidence-based. Every finding cites a reproducible command or `file:line`. No claim is taken from docs without verification against ground truth (per `references/ground_truth_principle.md`).

> **Re-verification pass (2026-06-14, second pass).** A deeper second pass read `ci.yml`, `vitest.config.ts`, and probed source directly. It **corrected three of this audit's own first-pass findings** (F-02, F-07 downgraded/reframed; F-01 escalated). Corrections are logged in §0. Treat §0 as the authoritative delta over the first-pass text below — where they conflict, §0 wins.

---

## 0. Re-Verification Corrections (authoritative)

**Scope honesty first.** This audit *measured* broadly — ran all 2,609 tests across 3 configurations, computed LOC (src+tests = **85,227**, the "84k"), parsed all 75 post-mortems, grep-verified security invariants across the tree, computed coverage. It *read in depth* only ~8 files. High-confidence claims below are the **measured** ones; anything about un-read modules is labeled as inferred. I have not read 84k lines and a line-by-line read is not the right tool — gates + measured signals + targeted source verification is. But the distinction is stated honestly.

| # | First-pass claim | Verified reality | Correction |
|---|---|---|---|
| C-1 | "CI gate `lint:strict` is RED → bypassed" (P1) | `ci.yml` runs `npm run lint` (warnings allowed) — **CI lint is GREEN**. `lint:strict` is named the gate only in `CLAUDE.md §9`, but no workflow runs it. | **F-02 downgraded P1→P3**, reframed as doc/workflow drift + 40-warning debt. Not a blocker. |
| C-2 | "Coverage asserted but unverified" (P3) | Coverage **is** gated in CI: `ci.yml` runs `test:coverage` with per-module + global floors in `vitest.config.ts`. Config's own comment states real global ≈ **lines 9.8% / functions 23.4% / branches 64%**. | **F-07 reframed**: the gap is `CLAUDE.md:130` + `README:198` claiming **"88% lib coverage"** vs ~10% global reality. |
| C-3 | "1 flaky test" (F-01, P1) | At least **TWO independent flake sources**, and CI runs the higher-overhead `test:coverage` which makes it worse. Observed across 3 runs: `test`→1 fail, `test:coverage`→**3 fails**, `coverage --testTimeout=30000`→**1 different fail**. | **F-01 escalated**: see F-01a/F-01b below. Suite is non-deterministic. |

**F-01a — real-scrypt auth tests time out under load.** `auth/login/route.test.ts:248`, `auth/credentials/route.test.ts:146`, `auth/password.test.ts:82` each run real scrypt KDF in loops at the default 5000 ms timeout. Plain `test` flaked 1; `test:coverage` (v8 instrumentation overhead) flaked **3**. **CI runs `test:coverage`** → CI flake risk is higher than the local suite suggests.

**F-01b — `app-store.test.ts:73` assertion flake (NEW, root cause pinned).** `setChats replaces the list wholesale` does `expect(getState().chats).toEqual([chat("c")])`. The `chat()` factory (`app-store.test.ts:36-37`) stamps `createdAt/updatedAt: new Date().toISOString()`. `toEqual([chat("c")])` **re-invokes the factory**, producing a fresh timestamp; when the stored object (line 72) and the comparison object (line 73) straddle a millisecond boundary the deep-equal fails. Pure timing flake, independent of scrypt. **Fix:** capture once — `const c = chat("c"); setChats([c]); expect(...).toEqual([c])`. Audit the whole file for the same `toEqual(freshFactory())` pattern.

**F-11 — any test failure suppresses the coverage artifact (NEW, P2).** With v8 coverage, a failing test makes vitest **not** emit `coverage/lcov.info` (verified: report absent after both failing coverage runs). Consequence in CI: a single timing flake costs you BOTH the test gate AND the coverage gate + the uploaded artifact. This couples F-01's flakiness to the coverage gate — they are not independent risks.

**Security invariants — VERIFIED in source (upgraded from "docs say so").** Spot-checked rather than trusted: `assertPrivacyModeAllowsSettings` 4 call-sites vs 3 `getSettings` in `agent.ts`; `applyGlobalToolLoopGuard` 5 wrap-sites; `assertSafeOutboundUrl` wired in `fetch-webpage.ts:116` **with redirect re-validation at :147** (closes the classic SSRF redirect bypass) and `mcp/client.ts:367`; `...process.env` leak grep → 0 hits in product code (2 hits, both test-only env restore). The "STRONG" security rating now stands on read code, not documentation.

---

## 0.1 Deep Re-Verification — Max-Effort Pass (2026-06-14, third pass)

This pass read source directly (`embeddings.ts`, `disagreement.ts`, `moa.ts` callsite, auth tests, `eslint.config.mjs`, `vitest.config.ts`), ran the production build, the AbortSignal audit, `npm audit`, and a forced-report coverage run. It produced **2 genuinely new substantive defects** and several precise corrections. Scope honesty: still ~14 files read in depth out of 219 — but the new findings were reached by *following evidence chains* (a lint warning → a source file → a systemic gap), which is how real bugs surface, not by reading everything.

### NEW defects (found by chasing evidence, not visible to first two passes)

**F-12 · P2 · `embedTexts` drops `abortSignal` across ALL 7 call sites (abort-contract gap).**
- `src/lib/memory/embeddings.ts:7` — `embedTexts(texts, config)` has **no `abortSignal`** in its `config` type (lines 9-15). Internally it calls the AI SDK `embed()` (`:33`) and `embedMany()` (`:40`), **both of which accept `abortSignal`** — but none is passed.
- All 7 callers run uncancellable embedding network calls: RAG search on the request path (`memory.ts:139`, `:187`), MoA disagreement detection (`disagreement.ts:112`), MoA self-consistency (`moa.ts:979`), trace-memory few-shots (`trace-memory.ts:336`, `:443`).
- Smoking gun: `detectDisagreement` (`disagreement.ts:88`) declares `_abortSignal?: AbortSignal` — someone **started** plumbing cancellation — but it dead-ends because `embedTexts` can't accept it. The `_`-prefix is the lint trail (`no-unused-vars`) that led here.
- **Impact:** an aborted chat turn under Swarm leaves embedding requests running to completion. Short-lived (~1-2s each), so a resource leak, not a PM #1-class outage — but on the in-request RAG/disagreement path it directly violates the CLAUDE.md AbortSignal contract ("Every tool implementation receives and respects `abortSignal` (long `fetch`...)"). Bounded per turn; accumulates under rapid abort/retry.
- **Fix:** add `abortSignal?: AbortSignal` to `embedTexts`' config, forward to `embed`/`embedMany`, thread `req.signal`/daemon signal from the request-path callers (trace-memory capture is fire-and-forget and may legitimately pass none).

**F-13 · P2 · The documented PM #23 abort-audit is blind to embeddings (false `missing=0`).**
- The audit grep in CLAUDE.md ("AbortSignal Propagation Contract") matches only `generateText|generateObject|streamText`. I ran it: all 5 files report `missing=0` — **green**. But `embed`/`embedMany` are the same family of abortable AI-SDK network calls and are **not** in the regex, nor is `disagreement.ts` in the audited file list, nor is `embeddings.ts`.
- **Impact:** the contract's own verification tool gives false confidence. `missing=0` is true *for the calls it checks* and silent about an entire abortable surface (F-12). This is the meta-bug: a P0-contract's audit that doesn't cover the contract's stated spirit ("every long fetch").
- **Fix:** extend the grep regex to `generateText|generateObject|streamText|embedMany|\bembed\(` and add `embeddings.ts`, `disagreement.ts`, `trace-memory.ts` to the file list; add the embeddings axis to the CLAUDE.md contract enumeration. Pair with F-12.

**F-11 · P2 · `coverage.reportOnFailure` defaults `false` → a flaky failure destroys the coverage gate.** (promoted from §0)
- **Proven:** after both failing coverage runs `coverage/lcov.info` was **absent**; re-running with `--coverage.reportOnFailure=true` produced it (467 KB). vitest skips coverage emission when any test fails.
- **Impact in CI:** `ci.yml` runs `test:coverage`. A single F-01 flake → tests fail → no coverage report → thresholds unevaluable → the upload-artifact step ships nothing. One timing flake costs the test gate, the coverage gate, AND the artifact simultaneously. F-01 and coverage are coupled risks.
- **Fix:** `coverage.reportOnFailure: true` in `vitest.config.ts` (lets thresholds + artifact survive a flake) — and fix the flakes (F-01).

### Precise corrections to coverage claims (hard numbers now in hand)

Real coverage (fresh `lcov.info`, all source files instrumented):

| Scope | Lines | Funcs | Branches | Doc claim | Verdict |
|---|---|---|---|---|---|
| **GLOBAL** | **45.7%** (15854/34656) | 71.1% | 83.4% | config comment "≈9.8%" | comment **stale** (real 45.7%) |
| **src/lib aggregate** | **61.4%** (12399/20182) | — | — | "**88% lib coverage**" (CLAUDE.md:130, README:198) | **overstated by ~27 pts** |

Per-dir spread refutes a single "lib" number: `security 99.3%`, `memory 97.5%`, `cost 97.0%`, `auth 90.9%` are genuinely high — but `storage 77.5%`, `cron 68.5%`, `agent 62.9%`, `providers 43.3%`, `tools 40.5%`, **`mcp 7.9%`** drag the aggregate to 61.4%.

**F-14 · P3 · Global coverage floors are stale → near-zero global regression protection.** `vitest.config.ts` global floors are `lines:9, functions:22, branches:50`; actual is `45.7/71.1/83.4`. A regression could delete **36 points** of line coverage and still pass the global gate. (Per-module floors for auth/security/storage DO still protect the critical files — those are fine.) The config's own "≈9.8%" comment is the stale artifact. **Fix:** ratchet global floors to ~3 pts under actual (e.g. `lines:42, functions:68, branches:80`).

**F-15 · P2 · `tool.ts` is the single biggest coverage risk: 23.87% lines.** 1930 LOC, 4 hot edits/90d (CLAUDE.md §10), yet only ~24% line / 4% function coverage. The loop-guard wrap, MCP untrusted-output wrapping (PM #27), and most tool `execute` bodies are unexercised. `search-engine.ts` (10%) is similar. Contrast `web-task.ts` 88% (well tested). **Fix:** prioritize `tool.ts` in the Sprint 2 §10 split — extract per-family files *with* tests (the split and the coverage win are the same work).

**F-16 · P3 · 5 `react-hooks/exhaustive-deps` warnings = real stale-closure risk** (not style): `dashboard/settings/page.tsx:40` (missing `settings`), `quick-model-selector.tsx:224` (`setActivePreset`), `knowledge-section.tsx:56` (`loadFiles`,`loadMemories`), `model-wizards.tsx:458` (`effectiveApiKey`), `:478` (`configKey`). The `model-wizards` pair touches **API-key/config state** — a stale closure there can submit an outdated key. Not auto-fixable (adding deps changes behavior) — each needs a human decision.

**F-17 · P4 · `eslint.config.mjs` ignores block omits `coverage/`.** Verified: ignores list (`.next`, `node_modules`, `data`, `playwright-report`, `test-results`, `bundled-skills`, `scripts`, `src/lib/vendor`) has no `coverage/**`. After a local `test:coverage`, `npm run lint` lints generated `coverage/lcov-report/*.js` → spurious warnings, non-deterministic local warning count (irrelevant in CI, which lints before coverage). **Fix:** add `"coverage/**"` to ignores.

**F-18 · P3 · Dependency-audit doc is stale in the GOOD direction → the gate can be raised.** `npm audit --omit=dev`: prod = **2 moderate, 0 high, 0 critical** (postcss←next, breaking to fix). CLAUDE.md §9 says "15 known transitive highs remain" — no longer true for prod (the 6 highs `npm audit` shows are **dev-only**). Per §9's own plan ("raising the bar to high is a one-character change once those transitives are cleared"), `audit:gate` can move `--audit-level=critical` → `high` now without breaking, tightening the gate.

### Corrections to my OWN earlier suspicions (verified benign)

- The 3 "swallowed `catch(error)`" (`goals/active:18`, `knowledge:64`, `goal-tree:74`) are **not** silent failures — each returns a graceful `500` JSON; the `error` is merely **unlogged**. Downgraded to a P4 observability nit (CLAUDE.md asks for `console.error(JSON.stringify(...))`), not a swallowed exception.

### Re-confirmed POSITIVES (now read in source, not trusted from docs)

- **Production build succeeds** (`npm run build` → full route table, middleware 42.8 kB, no errors).
- **AbortSignal contract for generate\*** holds: `missing=0` in all 5 orchestration files (the gap is the embeddings axis the audit doesn't check — F-13, not these).
- **Security primitives wired in source:** privacy-guard 4 sites / 3 `getSettings`; loop-guard 5 wraps; SSRF guard + redirect re-validation (`fetch-webpage.ts:147`) + MCP transport (`mcp/client.ts:367`); zero `process.env` spread in product code.
- **F-01a real scrypt confirmed:** `login/route.test.ts:105` calls real `hashPassword(...)`; settings-store + rate-limit are mocked but the KDF is not — root cause of the timeout flake is verified, not inferred.

---

## 0.2 Sprint 0 — Execution Log (DONE, 2026-06-14)

Stabilization sprint executed and verified. **Footprint: tests + config + docs only — zero production source touched** (`git diff --stat`: `CLAUDE.md`, `README.md`, `eslint.config.mjs`, `src/store/app-store.test.ts`, `vitest.config.ts`).

| Finding | Fix shipped | Verification |
|---|---|---|
| **F-01b** flaky `app-store.test.ts:73` | Capture `chat("c")` once instead of re-invoking the timestamp factory inside `toEqual` | root-cause eliminated (no second `new Date()`) |
| **F-01a / F-05** scrypt timeout flakes | `testTimeout: 15000` in `vitest.config.ts` (≈3× observed worst case) + comment forbidding KDF-mocking where the KDF is the unit | 3 consecutive green `test:coverage` runs, `2609 passed (2609)` |
| **F-11** coverage suppressed on failure | `coverage.reportOnFailure: true` | `lcov.info` (467 KB) now emitted regardless of pass/fail |
| **F-14** stale global floors (9/22/50) | Ratcheted to `lines:43, functions:68, branches:80, statements:43` (~3 pts under measured 45.7/71.1/83.4/45.7) + replaced the stale "≈9.8%" comment | `npm run test:coverage` → **REAL_EXIT=0** (thresholds pass) |
| **F-04** doc drift | README "2606"→"2609" (badge + 3 prose sites); README + CLAUDE.md "88% lib coverage" → real per-module numbers (`src/lib` ≈61%, global ≈46%) | exact count confirmed `Tests 2609 passed (2609)` |
| **F-17** eslint lint-ing `coverage/` | Added `"coverage/**"` to `eslint.config.mjs` ignores | local warning count 40→38 (the 2 were generated coverage JS) |

**Gate status after Sprint 0:** `npm run lint` 0 errors ✅ · `npm run typecheck` clean ✅ · `npm run test:coverage` REAL_EXIT=0 (2609 pass + thresholds met) ✅ · build ✅ (verified earlier). The two RED gates from the first pass (determinism, coverage-artifact fragility) are **closed**. Remaining work is Sprints 1–4 (security pinning, backend depth incl. **F-12/F-13 embeddings abort gap**, frontend coverage, non-functional).

**NOT done in Sprint 0 (deferred by design):** F-12/F-13 (abort plumb through `embedTexts` + audit-grep extension — Sprint 2, touches production code), F-15 (`tool.ts` coverage — couples to the §10 split), F-16 (5 exhaustive-deps — each needs a human behavior decision), F-18 (raise `audit:gate` to `high` — governance call). F-02 lint-debt (`lint:strict` 38 warnings) left as-is: it is NOT a CI gate (CI runs `npm run lint`), so it's debt not a blocker; `eslint --fix` clears 12 when someone chooses to.

---

## 0.3 F-12 + F-13 — Execution Log (DONE, 2026-06-14)

The embeddings abort-propagation gap and the audit blind spot — the first **production-code** fix from this audit.

**F-12 — `embedTexts` now forwards `abortSignal`:**
- `embeddings.ts`: added `options?: { abortSignal }`, forwarded to `embed()` and `embedMany()`, plus a `throwIfAborted()` short-circuit and a raw re-throw on abort (cancellation stays distinguishable from a provider error, not flattened into the "Failed to generate embeddings" wrapper).
- Threaded the signal at the **in-loop** callers where it was available: `detectDisagreement` (un-dropped the `_abortSignal` → `abortSignal`, forwarded), MoA reflection convergence (`moa.ts:979`), and `runAgent`'s RAG search + history-archive (`agent.ts`).
- `searchMemory`/`insertMemory`/`insertManyMemories` gained an optional trailing `abortSignal` (backward-compatible — all existing callers compile untouched).
- Deferred (param exists, threading is incremental, lower frequency): `memory_save`/`memory_load` tool wrappers, bulk knowledge import, fire-and-forget trace capture. Documented in CLAUDE.md so it's a known follow-up, not a silent gap.

**F-13 — the audit can no longer be blind to embeddings:**
- Extended the CLAUDE.md PM #23 audit grep regex to `…|await\s+embedMany|await\s+embed` and added `src/lib/memory/embeddings.ts` to its file list.
- Updated the contract enumeration ("Every `generateObject`, `streamText`, AND `embed`/`embedMany` call too") + a closure note.

**Verification:**
| Check | Result |
|---|---|
| Extended abort grep (6 files) | all `missing=0`, incl. `embeddings.ts: total=2, missing=0` |
| `tsc --noEmit` | clean |
| `eslint` | 0 errors, 37 warnings (down 1 — the `_abortSignal` unused-var is gone) |
| `npm run test:coverage` | **REAL_EXIT=0**, `Tests 2614 passed (2614)` (+5 new regression tests) |
| Coverage | 45.76/83.44/71.08 — floors still pass |

**New regression tests:** `embeddings.test.ts` (4: forward→embed, forward→embedMany, already-aborted short-circuit, raw abort re-throw) + `disagreement.test.ts` (1: forwards to embedTexts).

**Doc-drift note (F-04 reinforced):** this change bumped the suite 2609→2614, forcing a 3rd manual README count edit in one session. That is strong evidence for F-04's recommendation — **derive the badge from CI output, stop hardcoding it in 4 places.** Recommend doing that before the next test-count-changing PR.

---

## 0.4 Skeptical Re-Audit of the Work (2026-06-14)

Adversarial review of my own Sprint 0 + F-12/F-13 changes — "what did I break, miss, or claim without proof?" It found **one real gap (now fixed)** and several honest caveats.

### REAL GAP — FOUND & FIXED: F-12/F-13 missed `blackboard.ts`

- A grep for `embed(`/`embedMany(` **outside** `embeddings.ts` surfaced `src/lib/memory/blackboard.ts:72` (`writeFactToBlackboard`) and `:119` (`searchBlackboardFacts`) — two **direct AI-SDK `embed()` calls that bypass `embedTexts` entirely**, neither forwarding `abortSignal`, neither in the F-13 audit file list.
- **Root cause of my miss:** I scoped F-12 around "the 7 `embedTexts` call sites" instead of "every `embed`/`embedMany` SDK call." Blackboard reinvents the embed call, so it fell outside my search. This is *exactly* the partial-fix anti-pattern this codebase warns about (CLAUDE.md PM #22/#58): fix the wrapper, miss the bypass.
- Both are **in-request abortable** paths: the `write_fact` / `search_blackboard` tools (`tool.ts:1665/1685`) have `abortSignal` available in their `execute` 2nd arg (verified the loop guard forwards it; other tools like `search_web` already use it).
- **Fixed:** added `abortSignal?` to both blackboard functions + forwarded to `embed()`; threaded from the two tool `execute` callbacks; added `blackboard.ts` to the audit file list (+ a lesson: "scope abort audits to the SDK primitive, not an in-house wrapper"); 2 new regression tests in `blackboard.test.ts`.
- **Proof:** extended grep on all **7** files → every one `missing=0` (blackboard went 2→0). `Tests 2616 passed`, coverage holds, typecheck + lint clean.

### Honest caveats (not fixed — flagged)

- **F-01a global `testTimeout: 15000` is a band-aid, but the margin is adequate.** `password.test.ts` is 13.6 s *file-total* (alarming at first glance), but the worst *single* test is **2192 ms** — under full-suite + 2× CI slowdown the worst real-scrypt test lands ~8–10 s, comfortably under 15 s. The cleaner fix (mock the KDF in the *route* tests — login/credentials test routing, not crypto; only `password.test.ts` genuinely needs real scrypt) was NOT done. Stylistic debt, not a correctness risk.
- **The `tool.ts` → blackboard threading is typecheck-verified only, not unit-tested.** `tool.ts` has no test file (that *is* F-15 — 24% coverage). The signal wiring in the two `execute` callbacks is a trivial passthrough confirmed by `tsc`, but no test pins it.
- **Latent (pre-existing, not mine): blackboard can't run in mock-provider mode.** It calls `createEmbeddingModel` directly, which has no `"mock"` branch (unlike `embedTexts`). Recommended follow-up: route blackboard *through* `embedTexts` — that would have given the abort fix, mock-mode support, and DRY in one move. I chose the minimal inline fix to keep the diff low-risk.
- **No end-to-end abort proof.** The tests prove the signal *reaches* the SDK; they trust (documented) that `embed`/`embedMany` actually cancel the HTTP request. No mock-server integration test verifies the socket closes.

### Claims that HELD under scrutiny

- No RAG retry-classifier breaks from the abort re-throw — the only `"Failed to generate embeddings"` match is a separate `throw` in `memory.ts:144`, not a classifier.
- `typecheck` clean ⇒ none of the optional-param additions broke any caller (the compiler is the proof, not my reading).
- The new tests genuinely fail on broken code (`objectContaining({ abortSignal })` fails if the prop is absent; `not.toHaveBeenCalled()` fails if the short-circuit is removed).
- `moa.ts:979` `abortSignal` is the real `runMoAEnsemble` param, not a shadow.

### Doc-drift treadmill (F-04, now 4× proven)

This skeptical pass added 2 tests → suite 2614→**2616** → a **4th** manual README count bump in one session. That is overwhelming evidence for F-04: **stop hardcoding the count in 4 places; derive the badge from `vitest` JSON in CI.** Recommend doing this as the very next chore.

---

## 0.5 Sprint 1 (Security) — F-19: Privacy Mode air-gap bypassed by embedding routes (2026-06-14)

**F-19 · P1 · data egress under Privacy Mode via non-agent routes.** Measuring (not assuming) the security-test landscape surfaced a live PM #58-class hole:

- `assertPrivacyModeAllowsSettings` explicitly treats `embeddingsModel` as a leak vector (agent.ts comment: "embeddingsModel … text leaves the box"), but it's only called at the **agent** entry points. Two **non-agent API routes embed text directly**, bypassing the guard:
  - `GET /api/memory?query=` + `POST /api/memory` — search/insert embed the query/text.
  - `POST /api/projects/[id]/knowledge` — import embeds the uploaded file's content.
- **Reachable, not theoretical:** there is **no settings-write enforcement** of Privacy Mode (verified — `grep privacyMode src/lib/storage/settings-store.ts` is empty), so "Privacy Mode ON + a cloud `embeddingsModel`" is a config the operator can hold. Under it, these routes shipped memory text / knowledge files to the cloud embedder while the UI showed Privacy Mode ON — the exact promise ("NO user data may leave the box") broken.
- `/api/health` matched the symbol grep but was **excluded** (verified: the match was a comment, it does not embed).

**Fix:** both routes call `assertPrivacyModeAllowsSettings(settings)` after `getSettings()` and return **403 before any embedding** (memory via a file-local `privacyModeBlocked` helper; knowledge inline). Imports from `@/lib/agent/agent` — the established route pattern (`/api/chat` already does it).

**Tests (5 new):** `memory/route.test.ts` — GET+POST blocked under Privacy+cloud (embed never called), NOT over-blocked with local embeddings, NOT blocked when Privacy off. `knowledge/route.test.ts` — POST blocked + import never called.

**Verification:** typecheck clean; both route suites green (16 + 33); completeness grep confirms memory+knowledge are the ONLY non-agent embed routes (blackboard is agent-tool-only, already guarded by the entry point). CLAUDE.md Privacy Mode section + audit grep extended.

**Lesson (same family as PM #58):** the air-gap is only as strong as the number of entry points that call it — and **embedding is egress**, so every route that reaches `searchMemory`/`insertMemory`/`importKnowledgeFile`/blackboard counts, not just the chat path.

---

## 0.6 Sprint 1 (Security) — process.env gate + SSRF/auth sweep (2026-06-14)

Continuation of Sprint 1 after F-19. One fix + two **negative results** (controls verified working, not assumed — a clean sweep is a real audit deliverable).

**F-20 · DONE · automate the `...process.env` grep-gate (PM #28/#70).** The "never spread the operator's `process.env` into a child process" invariant was enforced only by a manual pre-merge grep CLAUDE.md asks reviewers to run — the exact control that gets skipped (and `env: process.env` already slipped once, PM #70). Added [`no-raw-process-env.test.ts`](src/lib/security/no-raw-process-env.test.ts): a structural Vitest gate scanning `src/lib/tools` + `src/lib/providers` for the whole-object spread/assign forms (single-var reads like `process.env.FOO` are fine), with a >10-file floor against a vacuous pass. **Meta-tested** — injecting a spread turns it red at file:line. CLAUDE.md updated to point at the gate.

**SSRF sweep — NO new hole (verified).** Cross-referenced every server-side `fetch()` in `src/app/api` + `src/lib` against `assertSafeOutboundUrl`. Every dynamic-URL fetch is either (a) already guarded (`fetch_webpage`, `web_task`, MCP transport, `/api/health`/`/api/models`/`/api/diagnostics` custom-backend cases, `local-backend-detect`, `model-fallback`) or (b) a fixed, trusted host not under client/model control (`api.telegram.org`, `api.github.com`/`githubusercontent.com` for skill install, `openrouter.ai`, `generativelanguage.googleapis.com`). `project-store`/`cron-service` fetch fixed hosts → no guard needed. LLM-provider fetches target the operator's own configured `baseUrl` (loopback is the intended Ollama case). Conclusion: the SSRF control is applied where it matters.

**Auth-gate sweep — well-covered (verified).** PM #25 `mustChangeCredentials` **API 403** gate is fully pinned in [`middleware.test.ts`](src/middleware.test.ts) (`/api/chat|projects|files|settings|events` → 403; `/api/auth/credentials|logout` exceptions allowed). `ORCHESTRA_DISABLE_AUTH` strict-`"true"` is covered (the F-01a flaky test, now de-flaked). No gap.

**Sprint 1 status:** the high-value items are closed — one real egress hole fixed (F-19), one fragile manual control automated (F-20), and the SSRF + auth + secrets-scrub controls verified intact. Remaining lower-drama items (exhaustive path-traversal route matrix) are incremental test-hardening of already-working guards.

---

## 0.7 Sprint 2 (backend depth) — F-21: tree-wide AbortSignal CI gate (2026-06-14)

**F-21 · DONE · the documented abort-audit file list was incomplete (again) — replace it with a tree scan.** Measuring before building (the F-13 lesson) showed the AI-SDK call surface is **10 files, not the 7** in CLAUDE.md's hardcoded audit list. Three callers were outside the list — `agent-response.ts`, `tournament-aggregator.ts`, `web-task.ts` — all currently `missing=0` (no live leak), but a future abort-drop in any of them would sail past the documented manual audit. Same class as F-13 (blackboard): a hand-maintained file list drifts.

**Fix:** [`abort-contract.test.ts`](src/lib/agent/abort-contract.test.ts) ports CLAUDE.md's bracket-balanced scanner but runs it over **every non-test file under `src/`** — no list to keep in sync, so a new SDK callsite in a new file is covered automatically. Asserts `missing=0` tree-wide, with a `totalCalls > 8` floor against a vacuous pass. **Meta-tested**: a temp file with `await embed({model})` and no signal turns it red at `file:line`. CLAUDE.md's PM #23 section now points at the gate as the source of truth (the manual grep stays as a quick local spot-check).

This is the same "fragile manual control → CI gate" move as F-20, applied to the P0-class abort contract. The remaining Sprint 2 items (race/atomicity stress for `withFileLock`, daemon billing-loop PM #59, fail-safe sweepers PM #60) are larger and deferred to a focused session.

---

## 1. Executive Summary

Orchestra is an unusually disciplined alpha codebase: 75 documented post-mortems, 2,608 passing tests, a clean `tsc --noEmit`, codified security helpers (`assertPathInside`, `assertSafeOutboundUrl`, `scrubProcessEnv`, `assertPrivacyModeAllowsSettings`), and a doc-as-code `CLAUDE.md` contract. The architecture is healthy; the gaps are in **test-suite determinism, the lint quality gate, frontend coverage, and documentation freshness** — not in core correctness.

**Verdict:** Ship-blocking issues are limited to the CI gate (`lint:strict` red) and one flaky test. Everything else is incremental hardening. No P0 product defect was found in this pass.

### Health Scorecard

| Dimension | Status | Evidence |
|---|---|---|
| Type safety | ✅ PASS | `npm run typecheck` → exit 0 |
| Unit tests (determinism) | ❌ FLAKY | **≥2 independent flake sources** (F-01a scrypt timeouts, F-01b timestamp deep-equal); different tests fail per run |
| CI lint gate (`npm run lint`) | ✅ PASS | `ci.yml` runs non-strict lint; warnings allowed (corrected — see §0/C-1) |
| `lint:strict` (doc'd gate, unused) | ⚠️ DEBT | 40 warnings, 14 auto-fixable; named gate in CLAUDE.md but no workflow runs it |
| Coverage gate | ⚠️ GATED-BUT-LOW | CI gates via `test:coverage` thresholds; real global ≈ **10% lines / 23% functions** (config's own comment), not the "88%" docs claim |
| Frontend coverage | ❌ WEAK | `src/components`: 45 src, **5 test files**; heavy components untested (verified) |
| Security helpers | ✅ STRONG | path/SSRF/env/privacy guards **verified wired in source** (§0), not just documented |
| Doc freshness | ⚠️ DRIFT | README "2,606 tests" (actual 2,609); "88% lib coverage" (actual ~10% global) |
| Tech-debt hygiene | ✅ STRONG | 3 TODO, 1 ts-ignore, 7 casts across 219 non-test files |

---

## 2. Ground-Truth Metrics (verified this audit)

| Metric | Value | Source command |
|---|---|---|
| Source files (`.ts/.tsx`, non-test) | 219 | `find src -type f … \| grep -v .test.` |
| Test files | 173 | `find … -name '*.test.*' -o -name '*.spec.ts'` |
| Total tests | 2,609 (2,608 ✅ / 1 ❌ flaky) | `npm run test` |
| Test-file count in suite | 170 | vitest summary |
| Suite wall-clock | ~47 s | vitest `Duration` |
| Post-mortems | 75 (74 RESOLVED, 1 MITIGATED #20, 1 OBSOLETE) | parsed `POST_MORTEMS.md` |
| API routes | 42 `route.ts` | `find src/app/api -name route.ts` |
| Files > 1500 LOC | 5 (tool.ts 1930, agent.ts 1862, llm-provider.ts 1841, project-store.ts 1564, code-execution.ts 1177¹) | `wc -l` |
| Lint warnings | 40 (14 auto-fixable) | `npm run lint:strict` |

¹ `code-execution.ts` is now 1177, just under the 1500 line; the §10 list still names it — minor doc drift (see F-09).

---

## 3. Findings (P0–P4)

Severity per skill rubric: **P0** blocker/data-loss/security · **P1** critical w/ workaround · **P2** high/edge · **P3** cosmetic · **P4** trivial.

### F-01 · P1 · Flaky test: auth-login times out under parallel load
- **Where:** `src/app/api/auth/login/route.test.ts:248` — *"only activates when value is exactly 'true' — falsy strings remain protected"*.
- **Symptom:** Full-suite run → `Error: Test timed out in 5000ms`. **1 of 2,609 fails non-deterministically.**
- **Root cause (verified):** Isolated the test → passes but consumes **3,066 ms**; sibling login tests each cost 530–1,133 ms because they run **real scrypt key derivation**. The failing test loops `["1","yes","TRUE","","false"]` → 5 sequential real verifications. Vitest default `testTimeout` is **5000 ms** (no override in `vitest.config.*`). Under full-suite CPU contention the 3 s baseline crosses 5 s → timeout. This is timing-coupled flakiness, **not a product defect** — the escape-hatch logic is correct.
- **Impact:** Red CI on a clean tree erodes trust in the signal; "re-run until green" normalizes ignoring failures.
- **Fix options (pick one):** (a) mock `verifyPassword`/scrypt in this file — the test asserts *branching*, not crypto; (b) raise this test's timeout to 15000 ms; (c) reduce the loop to 1–2 representative falsy values. Recommend (a) — removes the real-crypto cost and makes it deterministic.

### F-02 · P1 · CI quality gate `lint:strict` is RED (40 warnings)
- **Where:** `npm run lint:strict` (`eslint --max-warnings 0`) — declared the CI gate in `CLAUDE.md §9`.
- **Evidence:** `✖ 40 problems (0 errors, 40 warnings)` → "ESLint found too many warnings (maximum: 0)".
- **Breakdown:** Majority are **stale `Unused eslint-disable directive`** suppressions (e.g. `postmortem.test.ts:291`, `telegram-update-store.test.ts:116`, `swarm/tools.test.ts:69`, `knowledge-query.test.ts:46`, `memory-tools.test.ts:64`) — 14 auto-fixable via `eslint --fix`. The rest are real `no-explicit-any` (`settings-store.ts:73`, `mcp-mgmt.ts:26/36`, `tool.ts:1674/1694`).
- **Impact:** The gate that's supposed to keep the tree clean cannot currently pass → it is being bypassed in practice, defeating its purpose (the exact failure mode `CLAUDE.md §9` warns about for the audit gate).
- **Fix:** `npx eslint --fix` clears the 14 stale directives; type the ~6 real `any` sites or scope a justified `eslint-disable-next-line` with a reason comment. Then `lint:strict` is green and can be re-enforced.

### F-03 · P2 · Frontend component coverage gap (45 src → 5 tests)
- **Where:** `src/components` — 45 non-test `.tsx`, only **5** test files (`app-sidebar`, `chat-error-banner`, `swarm-config`, `theme-switcher`, `use-background-sync` is in hooks).
- **Untested heavy components:** `chat-panel.tsx` (728 LOC — the central chat surface, Zustand wiring, SSE consumption), `quick-model-selector.tsx` (524), `model-wizards.tsx` (988), `cron-section.tsx` (713), `telegram-integration-manager.tsx` (569), `projects/page.tsx` (1011).
- **Impact:** PM #5 / PM #33 / Zustand-narrow-selector rules (`CLAUDE.md §2, §5`) are frontend invariants enforced **only by code review**, not tests. A regression in `chat-panel`'s history-refetch-on-`syncTick` or a wide `useAppStore()` re-render would pass CI.
- **Fix:** happy-dom render tests for the top-5 components asserting the documented invariants (narrow store subscription, history refetch on tick bump, no `new EventSource` in components).

### F-04 · P2 · Documentation freshness drift — test count
- **Where:** `README.md:9` badge `tests-2606`, `:28`, `:191` ("currently 2,606 tests"), `:417`. Actual total is **2,609** (2,608 stable). Commit `107bb5e` "sync body test count to 2,606" already re-drifted.
- **Impact:** Violates the `CLAUDE.md §7` doc-as-code contract (a drifted doc "actively misleads every future LLM-assisted change"). Low user impact, but it's the canary for the contract the repo prides itself on.
- **Fix:** Derive the badge from `vitest` output in CI rather than hand-syncing (a `vitest --reporter=json | jq` step), or stop quoting an exact count in 4 places. Pick a single source of truth.
- **DONE (2026-06-14):** both halves shipped. The 3 prose mentions are now number-free, so they never drift; the count lives ONLY in the badge, updated by [`scripts/sync-test-badge.mjs`](../../scripts/sync-test-badge.mjs) (`npm run badge:sync`) which reads vitest's own `numTotalTests` instead of a human counting `it(` blocks. `-- --check` is a CI-friendly stale-detector. Meta-tested: a deliberately-wrong badge (`1`) was auto-corrected to `2623`. This ended the treadmill that bumped the count manually 6× during this audit.

### F-05 · P2 · No `testTimeout` policy → latent flakiness class
- **Where:** absent in `vitest.config.*`. Any test doing real crypto/fs/network inherits 5000 ms.
- **Impact:** F-01 is the first instance; any future real-scrypt/real-embedding test is one CI-runner slowdown away from the same flake.
- **Fix:** set a deliberate `testTimeout` (e.g. 15000) for the suite **and** a lint/convention that real-crypto tests mock the KDF. Codify in `CLAUDE.md §9`.

### F-06 · P3 · Telegram route family under-tested
- **Where:** 6 routes under `src/app/api/integrations/telegram/**` have no colocated `*.test.ts`; the main `telegram/route.ts` is 742 LOC and is an **unauthenticated webhook entry point** (per PM #58 it's a privacy-mode-sensitive LLM entry).
- **Impact:** Webhook signature verification, privacy-mode air-gap, and abort plumbing on this path rest on review only.
- **Fix:** route-level tests for webhook auth rejection + `assertPrivacyModeAllowsSettings` enforcement on the Telegram → `runAgentText` path.

### F-07 · P3 · Coverage % is asserted but unverified
- **Where:** `CLAUDE.md` claims "88% lib coverage"; quality gate target is ≥80%. `npm run test:coverage` was **not** run in CI evidence and not reproduced here (instrumented run is slow).
- **Fix:** wire `test:coverage` into `verify:strict` (or a nightly), publish the lcov number, and let the 80% gate be machine-checked instead of asserted.

### F-08 · P3 · Five files breach the 1500-LOC hard line
- **Where:** `tool.ts`, `agent.ts`, `llm-provider.ts`, `project-store.ts` (+ `code-execution.ts` near the line). `CLAUDE.md §10` already plans the seams.
- **Impact:** Not a defect, but each file "no longer fits in a single read" → every LLM-assisted change to them is higher-risk. The §10 two-PR extraction plan exists; it just hasn't been executed.
- **Fix:** schedule the §10 Phase extractions (lowest-risk first: `project-store.ts`).

### F-09 · P4 · `CLAUDE.md §10` lists `code-execution.ts` as 1500+ but it is 1177
- **Where:** §10 "Five files cross … 1500-line line" — `code-execution.ts` measures 1177 LOC now.
- **Fix:** update the §10 wording (the file already shrank; it's a near-miss, not a breach).

### F-10 · P4 · Stale `eslint-disable` directives are themselves the lint debt
- Folded into F-02 mechanically (`--fix`), called out separately because it signals **suppression rot**: directives outlive the code that needed them. Recommend a periodic `--report-unused-disable-directives` sweep.

---

## 4. Quality Gates Assessment (Google release gates)

| Gate | Target | Actual | Pass? |
|---|---|---|---|
| Test execution | 100% | 100% run | ✅ |
| Pass rate | ≥80% | 99.96% (2,608/2,609) | ✅ |
| Deterministic suite | 0 flaky | 1 flaky (F-01) | ❌ |
| P0 bugs | 0 | 0 | ✅ |
| P1 bugs | ≤5 | 2 (F-01, F-02) | ✅ |
| Lint gate | 0 warnings | 40 warnings | ❌ |
| Type check | clean | clean | ✅ |
| Code coverage | ≥80% verified | unverified (F-07) | ⚠️ |
| Security (OWASP) | 90% | helpers present, see Sprint 1 | ⚠️ verify |

**Release readiness:** 2 gates RED (determinism, lint), 2 AMBER (coverage proof, security re-verification). Both REDs are fixable in <1 day (Sprint 0).

---

## 5. Sprint Plan

Sized for a single engineer. Each sprint ends with a green, trustworthy signal before the next builds on it.

### Sprint 0 — Restore a trustworthy signal (0.5–1 day) · BLOCKER
Goal: green, deterministic CI so every later sprint's pass/fail means something.
1. **F-01** — de-flake auth-login test (mock scrypt or bump timeout). Verify: run full suite 5× → 0 failures.
2. **F-02** — `eslint --fix` the 14 stale directives; resolve the ~6 real `any`. Verify: `lint:strict` exit 0.
3. **F-05** — set deliberate `testTimeout` in `vitest.config`.
4. **F-04** — single-source the test-count badge or de-hardcode it.
- **Exit gate:** `npm run verify:strict` green twice in a row.

### Sprint 1 — Security regression hardening (OWASP pass) (2–3 days)
Goal: convert "helpers exist" into "every entry point is test-pinned."
- **A01/A05 access control:** test `mustChangeCredentials` API gate (PM #25) across all `/api/*`; `ORCHESTRA_DISABLE_AUTH` strict-`"true"` (F-01's subject — keep the assertion, fix the flake).
- **A03 injection / path traversal:** parametrized `assertPathInside` tests over the full audited-routes table (`CLAUDE.md` Security Patterns) incl. sibling-prefix + `..` + symlink-noted cases.
- **A10 SSRF:** `assertSafeOutboundUrl` matrix (RFC1918, `169.254`, IPv4-in-IPv6, `file:`/`data:`) for **routes and tools** (PM #73 `fetch_webpage`, PM #27 MCP transport).
- **Data egress (PM #58):** assert `assertPrivacyModeAllowsSettings` fires on **every** LLM entry (`runAgent`, `runAgentText`, `runSubordinateAgent`, Telegram webhook, cron) — extend `agent-entrypoints-privacy.test.ts`.
- **Secrets (PM #28/#70):** grep-gate test that `...process.env` / `env: process.env` appears nowhere under `src/lib/tools` except scrubber callsites.
- **Exit gate:** OWASP coverage table ≥90% with a named test per row; **F-06** Telegram webhook tests landed.

### Sprint 2 — Backend depth: concurrency, abort, recovery (3–4 days)
Goal: pin the PM-class invariants that unit tests miss.
- **AbortSignal (PM #1/#23):** automate the §"AbortSignal Propagation Contract" bracket-balance grep as a test that fails on `missing>0`.
- **Race/atomicity (Critical §1):** concurrent `safeWriteFile`/`withFileLock` stress test for chat-store + project-store (no lost-update, no partial JSON).
- **Daemon billing loop (PM #59):** assert `autoPilotIterations` accumulates to `MAX_AUTO_PILOT_ITERATIONS` and `preserveAutoPilotCounter` semantics hold.
- **Sweepers fail-safe (PM #60):** assert orphan sweeps SKIP (not mass-delete) when the keep-set can't resolve.
- **MoA force-swarm (PM #22):** end-to-end through interactive + background + queue-persistence dispatch paths.
- **Exit gate:** `test:stress` documented + run; coverage report (F-07) wired and ≥80%.

### Sprint 3 — Frontend resilience & coverage (3–4 days)
Goal: close F-03; make PM #5/#33 invariants test-enforced.
- happy-dom tests for `chat-panel`, `quick-model-selector`, `model-wizards`, `cron-section`, `projects/page`.
- Assert: narrow Zustand selectors (grep-gate `useAppStore()` no-arg → 0), `MessageBubble` memoization, history refetch on `syncTick`, no `new EventSource` in components.
- Extend Playwright e2e: long generation + mid-stream `visibilitychange` toggle → final message renders (the deferred PM #5 full-e2e).
- **Exit gate:** component test files ≥15; the 6 documented frontend invariants each have a named test.

### Sprint 4 — Non-functional & decomposition (3–5 days)
Goal: performance, retention, and the §10 file-size debt.
- **Retention/sweepers (PM #32/#63):** tests that each `data/` surface in the Data Layout table is bounded (sweeper or ring-buffer or atomic-cleanup) — fail when a new unbounded dir appears.
- **Observability (PM #31):** `/api/_debug/chat/[id]` one-shot diagnostic contract test.
- **§10 extraction PR-1** for lowest-risk `project-store.ts` (re-exporter shape), guarded by existing tests.
- **Load:** baseline `test:stress` numbers recorded in `BASELINE-METRICS.md`.
- **Exit gate:** no unbounded data dir; one oversized file decomposed; perf baseline captured.

---

## 6. What's Already Excellent (do not regress)

- **Post-mortem discipline:** 75 entries, each a living regression test spec. This is best-in-class.
- **Centralized security primitives:** path/SSRF/env/privacy guards are single-source with regression tests — the correct architecture.
- **Doc-as-code contract:** `CLAUDE.md §7` enforcing doc+PM+test on every architectural fix.
- **Tech-debt hygiene:** 3 TODOs, 1 `@ts-ignore`, 7 casts across 219 files — exceptionally low.
- **Data-loss guards:** `safeWriteFile`, soft-delete trash (PM #63), `ORCHESTRA_DATA_DIR` isolation (PM #62), build-with-data-guard.

---

## 7. Immediate Next Action

Start Sprint 0. The two RED gates (F-01 flaky test, F-02 lint) are <1 day combined and unblock trust in every subsequent measurement. Do not begin coverage/feature sprints while the base signal is red — you'd be building on a meter that lies.
