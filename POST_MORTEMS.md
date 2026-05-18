# Orchestra — Post-Mortems & Known Issues Registry

This file documents critical architectural bugs, memory leaks, and model-specific edge cases that have hit Orchestra in production. **Read this before refactoring core orchestration logic.** Every entry here is a regression hazard — old PMs are the test cases for future rewrites.

---

## Conventions

- **Order:** newest entry on top, numbering is chronological (so old links stay stable).
- **Never delete.** If a subsystem is removed, mark `**Status:** OBSOLETE` and keep the entry — it documents *why* the design was abandoned.
- **Status taxonomy:**
  - `RESOLVED` — fix landed and a regression test guards it.
  - `MITIGATED` — workaround in place, root cause not addressed.
  - `OPEN` — diagnosed, fix pending.
  - `OBSOLETE` — subsystem no longer exists.
- **Severity (operator impact, not user impact):**
  - `P0` — data loss, billing leak, prod outage, or silent corruption.
  - `P1` — user-visible regression, observable degradation under normal load.
  - `P2` — model-specific edge case, narrow reproduction conditions.

## Entry Template

```markdown
## N. <Concise title>
**Date:** YYYY-MM
**Status:** RESOLVED | MITIGATED | OPEN | OBSOLETE
**Severity:** P0 | P1 | P2
**Symptoms:** What the operator/user observed.
**Detection:** How we noticed (alert, user report, log signature, on-disk vs. runtime divergence). Future-you uses this to wire alerts.
**Root Cause:** The actual mechanism. Reference real symbols (`file.ts:line` or `module → function`); avoid line-anchored refs that rot under refactor — prefer symbol grep instructions.
**Resolution:** What was changed (or, if OPEN, the planned fix).
**Regression Coverage:** Path to the test that prevents recurrence, or "none — TODO".
**Doc Updates:** Which sections of `CLAUDE.md` were updated alongside the fix. For historical PMs that predate this template, write "none at the time" rather than back-filling fictional updates.
**Rule:** A one-liner an LLM agent should remember when touching this area.
```

When adding a new PM, prepend it above the current top entry and increment the number. Old PM numbers are stable identifiers — never renumber.

---

## 21. Knowledge Routes Accepted Raw User-Controlled Filename — Arbitrary File Write / Delete Primitive
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P0 (any authenticated user could write to or delete arbitrary files on the host filesystem, scoped only by the Node process's filesystem permissions)
**Symptoms:** None observed in production at the time of discovery. Found by an architecture audit after the 2026-05 coverage sweep noticed the route had no traversal regression test.
**Detection:** Static review of [`src/app/api/projects/[id]/knowledge/route.ts`](src/app/api/projects/[id]/knowledge/route.ts) during the deep audit — POST line 73 and DELETE line 129 both called `path.join(knowledgeDir, <user-string>)` with no sanitization. The previous Sprint D route tests covered only happy paths (404/400/200/207), never exercising a traversal payload.
**Root Cause:** POST took `file.name` from the multipart upload (user-controlled Content-Disposition) and joined it raw into the knowledge directory. DELETE took `filename` from the JSON body and did the same. Both were identical in shape to the bug class fixed in PM #6 (knowledge import directory traversal) and PM #16 (sibling-prefix bypass across three file routes). The defense pattern documented in `CLAUDE.md` § "User-supplied filesystem paths — canonical guard" was not applied here.

Exploitable primitive (any authenticated user):
- POST `Content-Disposition: form-data; name="file"; filename="../../../etc/passwd"` → server writes uploaded bytes to `/etc/passwd` (subject to process FS permissions). Worse than read: this is *write*.
- DELETE `{"filename": "../../app/secret.json"}` → server unlinks the named file.
**Resolution:** Three coordinated changes:
1. Added [`sanitizeKnowledgeFilename`](src/app/api/projects/[id]/knowledge/route.ts) — a strict filter that rejects empty input, whitespace-only, `.`/`..`, anything containing `/` or `\` (POSIX `path.basename` doesn't treat `\` as a separator on Linux/macOS, so the latter must be checked explicitly), and any input where `basename(trimmed) !== trimmed`.
2. Added `assertPathInside` as defense-in-depth at the route layer — even if `sanitizeKnowledgeFilename` were ever bypassed, the resolved write/delete path is verified to live under `knowledgeDir + path.sep` before being used.
3. Pushed `assertPathInside` down into [`importKnowledgeFile`](src/lib/memory/knowledge.ts) as well — the importer is reachable from multiple callers (the route plus the bulk `importKnowledge` directory scan); guarding it makes the property invariant per the "Defense-in-depth" note in `CLAUDE.md` § Security.
**Regression Coverage:** [`src/app/api/projects/[id]/knowledge/route.test.ts`](src/app/api/projects/[id]/knowledge/route.test.ts) — a parameterized suite under `describe("PM #21 — path traversal in knowledge routes")` runs every payload (POSIX + Windows-style separators, `.`/`..`, empty/whitespace) against both POST and DELETE and asserts: status 400, no `fs.writeFile`/`fs.unlink` call, no importer/vector-deleter call. Positive sanity tests verify benign filenames (`doc.md`, `Отчёт-2026.md`) still succeed.
**Doc Updates:** `CLAUDE.md` § "Security Patterns" expanded with an "Audited routes that touch user-supplied filenames" subsection listing every route that has been hardened so the gap doesn't re-open in a new file.
**Rule:** Any API route that derives a filesystem path from a user-supplied string MUST run that string through *both* (a) a strict sanitizer that rejects separators and special segments, and (b) `assertPathInside` as defense-in-depth. The pattern is already canonical in `CLAUDE.md` § "User-supplied filesystem paths — canonical guard" — apply it without exception. When adding a new route, list every user-supplied string field that touches the filesystem (including multipart `filename` from `Content-Disposition`) and confirm each is guarded.

---

## 20. `every`-Schedule Returns Current Tick When `nowMs` Lands Exactly on an Anchor-Aligned Tick (Known Design Quirk)
**Date:** 2026-05
**Status:** MITIGATED (documented + pinned; harmonization deferred)
**Severity:** P3 (no incident; latent inconsistency)
**Symptoms:** None in production yet. Surfaced while writing regression tests for [`src/lib/cron/schedule.ts`](src/lib/cron/schedule.ts) → `computeNextRunAtMs`. A naive caller doing `if (nextRunAtMs > nowMs)` to decide "is this due in the future?" would treat an aligned tick as "due now" and re-fire immediately, then re-compute the same `nextRunAtMs`, then re-fire again — a tight loop.
**Detection:** Discovered by [`src/lib/cron/schedule.test.ts`](src/lib/cron/schedule.test.ts) — the test "aligns to anchor grid when nowMs is past the anchor" failed against my initial intuition that the formula was strict-greater-than-now. Tracing the integer-ceiling formula (`steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs))`) showed that when `elapsed` is an exact multiple of `everyMs`, the formula yields the current aligned tick rather than the next one.
**Root Cause:** `computeNextRunAtMs` for `schedule.kind === "every"` uses ceiling arithmetic on `elapsed / everyMs`. When `nowMs - anchorMs` is an exact multiple of `everyMs`, `ceil(N) === N`, and the function returns `anchorMs + N*everyMs === nowMs`. This is inconsistent with the other two schedule kinds:
- `kind: "at"`: returns `undefined` when `atMs === nowMs` (strict `>` semantics).
- `kind: "cron"`: cursor starts at `floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS` (strict `>` semantics).
- `kind: "every"`: returns `nowMs` itself when aligned (non-strict).

The runtime currently masks the issue because `CronScheduler.tick` advances `runningAtMs` before re-computing `nextRunAtMs`, so a job that "fires at now" doesn't loop in practice. But any new caller that doesn't follow that pattern is exposed.
**Resolution (current):** Behaviour is pinned in [`src/lib/cron/schedule.test.ts`](src/lib/cron/schedule.test.ts) under the test name "when nowMs is EXACTLY on an anchor-aligned tick, returns that tick (NOT strict >)" so a future refactor that "fixes" it will break the regression and require a deliberate choice.
**Resolution (deferred):** Harmonize all three kinds to strict-greater-than-now semantics. The change is a one-line bump in the `every` branch (`steps = Math.max(1, Math.floor(elapsed / everyMs) + 1)` would do it), but requires coordinated audit of every caller of `computeNextRunAtMs` to make sure nothing else relies on the non-strict behaviour. Carry as an open design item.
**Regression Coverage:** [`src/lib/cron/schedule.test.ts`](src/lib/cron/schedule.test.ts) — explicit test + comment block documenting the divergence.
**Doc Updates:** This PM. No `CLAUDE.md` rule change yet (the cron section in `CLAUDE.md` doesn't currently describe schedule semantics in detail; will codify only after harmonization).
**Rule:** When computing "next run after now" semantics, all three schedule kinds (`at` / `every` / `cron`) should share strict-greater-than-now contract. The current `every` exception is a known quirk — do NOT add new callers that depend on either behaviour; treat `computeNextRunAtMs(...) === nowMs` as ambiguous and use `> nowMs` guard at the callsite.

---

## 19. `path.posix.normalize("") === "."` Broke GitHub Skill Imports From Repo Root
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P2 (GitHub skill imports from a repo's root directory failed; surfaced as the user-facing error message `"Imported path must contain SKILL.md at its root"`, with no clue that the cause was an empty `sourcePath`)
**Symptoms:** Not observed in production. The bug was discovered while writing test coverage, NOT from a user report. Documented here so the regression test name explains itself.
**Detection:** Surfaced by [`src/lib/storage/project-store-github.test.ts`](src/lib/storage/project-store-github.test.ts) during the 2026-05 coverage sweep on [`installSkillFromGitHub`](src/lib/storage/project-store.ts) — the test exercising "import from repo root (empty `sourcePath`)" failed. Tracing into `deriveRelativeSkillPath` and `deriveSkillNameCandidate` showed both helpers were treating the empty-string input as `"."` and dropping every file. The in-source code comment in `deriveRelativeSkillPath` describes the same failure mode: empty path causes the function to bubble up "Imported path must contain SKILL.md at its root" rather than completing the import.
**Root Cause:** Both helpers in `project-store.ts` normalize input via `path.posix.normalize(...)`. Node's `path.posix.normalize("")` returns `"."` (not `""`), per POSIX semantics — the empty path is treated as "the current directory." The helpers then appended `"."` as if it were a real subdirectory segment:
```ts
function deriveRelativeSkillPath(repoPath, sourcePath) {
  const normalizedRepoPath = normalizePosixPath(repoPath);
  const normalizedSourcePath = normalizePosixPath(sourcePath); // "" → "."
  // ... downstream used "." as the relative path → install failed
}
```
The class of bug is "JavaScript stdlib defensible-but-surprising default." Empty-string handling has to be a deliberate branch in any path-normalization helper that distinguishes "no path" from "current directory."
**Resolution:** Both helpers received an explicit empty/`.` guard at the top:
```ts
if (!normalizedSourcePath || normalizedSourcePath === ".") {
  return normalizedRepoPath;  // or `return repo` in the name helper
}
```
**Regression Coverage:** [`src/lib/storage/project-store-github.test.ts`](src/lib/storage/project-store-github.test.ts) — covers both helpers with `sourcePath: ""` input.
**Doc Updates:** None in `CLAUDE.md` (this is too narrow for an architectural rule). Lives entirely in this PM + the regression test.
**Rule:** Any path-normalization helper that needs to distinguish "empty" from "current directory" must test the empty-string branch explicitly. `path.posix.normalize("")` returns `"."`, not `""` — never rely on the return value alone to detect "no path supplied."

---

## 18. `xlsx-loader.ts` Emitted UTF-16 LE Mojibake — RAG Silently Corrupted for Excel Sources
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P1 (latent silent data corruption — any uploaded `.xlsx`/`.xls` file would have been indexed as mojibake-vectors; RAG queries against Excel sources would return irrelevant matches with no error and no log signature)
**Symptoms:** Not observed in production at the time of discovery — the project had no test coverage on the loader pipeline, and no operator complaint had triggered investigation. The defect was caught by a test written during the 2026-05 coverage sweep before the loader had been exercised against meaningful non-ASCII content.
**Detection:** Surfaced by [`src/lib/memory/loaders/xlsx-loader.test.ts`](src/lib/memory/loaders/xlsx-loader.test.ts) — the Cyrillic round-trip test asserting that a cell containing `"Анна"` survives the load. Loading produced `"А·н·н·а"` with NULL bytes between every glyph. The downstream chunker → embedder pipeline treats the loader output as opaque bytes; the embedder would have turned this UTF-16 mojibake into nonsense vectors.
**Root Cause:** `loadXlsx` in [`src/lib/memory/loaders/xlsx-loader.ts`](src/lib/memory/loaders/xlsx-loader.ts) called `XLSX.utils.sheet_to_txt(sheet)`. The `sheet_to_txt` helper from the `xlsx` library emits **UTF-16 LE encoded text with a BOM** — this is documented but easy to miss. Every other path in our loader pipeline operates on UTF-8 (`fs.readFile(filePath, "utf-8")`, the chunker, the embedder request body). Feeding UTF-16 bytes into a UTF-8 consumer doesn't error — it produces silent corruption (BOM becomes a stray char, then every ASCII glyph gets a NULL byte prefix).
**Resolution:** Switched to `XLSX.utils.sheet_to_csv(sheet, { FS: "\t", RS: "\n" })` — `sheet_to_csv` emits UTF-8 and preserves the tab-separated, newline-terminated shape that the chunker is happy with. The tab separator (over comma) is RAG-friendly: each cell becomes a clearly bounded token.
**Regression Coverage:** [`src/lib/memory/loaders/xlsx-loader.test.ts`](src/lib/memory/loaders/xlsx-loader.test.ts) — explicit assertions that the loaded text contains the original Cyrillic glyphs, contains no ` ` NULL bytes, and does not start with a UTF-16 BOM. A separate assertion fixes the tab-separator + newline-terminator shape.
**Doc Updates:** Code comment in [`src/lib/memory/loaders/xlsx-loader.ts`](src/lib/memory/loaders/xlsx-loader.ts) explains why `sheet_to_csv` was chosen over `sheet_to_txt`. No `CLAUDE.md` change yet — should add a "Loaders must produce UTF-8" line under a future "Memory & RAG" subsection.
**Rule:** Every document loader under [`src/lib/memory/loaders/`](src/lib/memory/loaders/) MUST return UTF-8 text. When introducing a new loader (or replacing an existing one), the unit test MUST include a non-ASCII round-trip (Cyrillic / Chinese / emoji) and an assertion that the output contains no ` ` NULL byte and no UTF-16 BOM (`﻿` at offset 0). Library helpers that "just return text" are not implicitly UTF-8 — verify their encoding explicitly.

---

## 17. Silent Post-MoA Crash — `agent.ts` Ignored `NO_TOOL_PATTERNS` for OpenRouter
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P1 (UX — full chat turn produces an aggregator consensus, then the streaming agent throws 404 from OpenRouter and the SSE stream dies before any user-visible bytes; operator sees "Swarm crashed" with nothing in the UI)
**Symptoms:** Operator reported the Swarm consistently failing: orchestrator → subordinate handoff visible briefly via SSE, then "everything disappears." Chat JSON on disk persisted as an empty shell (`"messages": []`) for the affected turns. Memory (RAG) features also misbehaved on the same chats. Three nearly-empty chat files at `data/chats/<id>.json` from the same operator session were the trail.
**Detection:**
1. The container log (`docker logs eggent-app-1`) showed the full MoA pipeline succeeding: 5/5 proposers complete, aggregator returns 92 chars in 2.1s.
2. Immediately after `[MoA] Consensus injected (...)` came `Error [AI_APICallError]: No endpoints found that support tool use` from `https://openrouter.ai/api/v1/chat/completions` with `statusCode: 404`. The error message included OpenRouter's hint: `Try disabling "inject_mcp_defaults"`.
3. The active chat model was `openrouter/qwen/qwen-2.5-coder-32b-instruct` in one observed run, `openrouter/google/gemma-4-31b-it` in another — both flagged by [`NO_TOOL_PATTERNS`](src/lib/providers/tool-support.ts) as non-tool-capable.
4. Reading [`src/lib/agent/agent.ts`](src/lib/agent/agent.ts) (search for `supportsTools`) revealed the bug visually in <30s: the OpenRouter branch checked exactly one pattern.
**Root Cause:** Tool-capability detection lived inline in `agent.ts` with two parallel branches, copy-pasted to drift apart over time:
```ts
if (isOllamaProvider) {
  // ... live /api/show probe, falls back to NO_TOOL_PATTERNS on failure
} else if (resolvedModelConfig.provider === "openrouter") {
  supportsTools = !modelId.includes("deepseek-r1");   // ← only one pattern!
}
```
Result: any OpenRouter user picking `gemma-*`, `mistral`, `phi-*`, `mixtral`, `codellama`, `starcoder`, or `tinyllama` got 63 tools forwarded to a model that cannot tool-call. OpenRouter returns 404 with the message above. The agent's outer try/catch logged the error to stdout but did NOT push a `chat-error` SSE event, so the frontend just sat with no bytes — the "Swarm pропал" visual.

The bug was structural: copy-pasted detection logic with no shared source of truth. The Ollama branch was correct; the OpenRouter branch was a stub from when only `deepseek-r1` mattered. Nobody updated the second branch as the pattern list grew.
**Resolution:**
1. Extracted the decision into [`src/lib/providers/tool-support.ts`](src/lib/providers/tool-support.ts) — `modelSupportsTools(provider, modelId)` plus the exported `NO_TOOL_PATTERNS` constant. Single source of truth for every non-Ollama provider; the Ollama branch keeps its live `/api/show` probe and falls back to the same helper on probe failure.
2. [`src/lib/agent/agent.ts`](src/lib/agent/agent.ts) (search for `supportsTools`) now imports + uses the helper. The "two branches drifting apart" failure mode is gone by construction.
3. Added a substring check across all eight providers in the test (see Regression Coverage).
**Implication for prior fixes:** Independently of PM #15/#16 (security), this bug single-handedly explains the operator's "Swarm broken for days" experience. PM #1's "always 200, log error" contract handled the SERVER side correctly — the request didn't crash the Worker. What was missing was the CLIENT side: nothing surfaced the error to the user. That observability gap is the trigger for **Sprint 3** (`chat-error` SSE event + structured logger + trace-ids); see CLAUDE.md updates.
**Regression Coverage:** [`src/lib/providers/tool-support.test.ts`](src/lib/providers/tool-support.test.ts) — 9 cases. The PM-#17-specific case (`google/gemma-4-31b-it` on `openrouter` → `false`) is one of them; the universal "every NO_TOOL_PATTERN must be rejected on every provider" loop catches future drift.
**Doc Updates:**
- [`CLAUDE.md`](CLAUDE.md) → "🛠 Tech Stack" / new bullet under MoA explaining that capability detection MUST go through the helper and never inline. Linked from this PM.
- This PM also references the upcoming Sprint 3 work (`chat-error` SSE event) — the SECOND defect this incident exposed: silent server-side error → frontend gets no signal. Tracked separately.
**Rule:** Tool-capability detection lives in **one place** — [`src/lib/providers/tool-support.ts`](src/lib/providers/tool-support.ts). Every provider branch in the agent path MUST go through `modelSupportsTools`. Inline `modelId.includes("...")` checks for capability are forbidden — they drift, they get partially updated, they cause silent post-MoA crashes. When you find a new model that 404s on tools, add it to `NO_TOOL_PATTERNS` and write a test asserting it on every provider; the existing universal loop will keep both branches honest.

---

## 16. `startsWith()` Sandbox Guards Without `path.sep` — Sibling-Prefix Bypass Across 3 File Routes
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P0 (security — arbitrary outside-sandbox file delete via `DELETE /api/files`, arbitrary outside-sandbox file read via `GET /api/files/download`, and the same class in `chat-files-store.deleteChatFile`)
**Symptoms:** Discovered during the Sprint-1 test-coverage audit (the route-level test pattern was being established). A user with a valid session could pass `?path=../foo-evil/secrets.txt` to `DELETE /api/files?project=foo` and the route returned 200 — the file at `<workDir>/../foo-evil/secrets.txt` was actually deleted, even though `<workDir>` is `<...>/foo`. Same bypass on `GET /api/files/download` (read instead of delete) and on `chat-files-store.deleteChatFile`.

PM #6 explicitly named [`src/app/api/files/route.ts:37-44`](src/app/api/files/route.ts) as **"the canonical safe pattern"** to migrate other routes toward. That claim was wrong: the canonical pattern was itself broken in the same way the bug PM #6 fixed.
**Detection:**
1. Writing the first route-level test for `DELETE /api/files` as part of Sprint-1 coverage.
2. The textbook `..` traversal test passed (because `path.join` collapses `..`); the sibling-prefix variant `../foo-evil/<file>` did not — it was deleted.
3. `grep -rn "startsWith.*resolve\|resolve.*startsWith" src/` found two more instances of the same broken shape: [`src/app/api/files/download/route.ts:23`](src/app/api/files/download/route.ts) and [`src/lib/storage/chat-files-store.ts:100`](src/lib/storage/chat-files-store.ts).
**Root Cause:** All three sites did `resolvedPath.startsWith(resolvedWorkDir)` without the `path.sep` suffix that `assertPathInside` appends. With `workDir = "/tmp/foo"`, a malicious `path.join(workDir, "../foo-evil/x")` resolves to `/tmp/foo-evil/x`, which `startsWith("/tmp/foo")` is **TRUE** — the inlined guard says "yes, in sandbox" and lets the operation through. PM #6's fix-helper `assertPathInside` does it right: `startsWith(root + path.sep)`. The three routes were written before that helper existed and never migrated.
**Resolution:**
1. All three sites migrated to `assertPathInside`. Inlined `path.resolve` + `startsWith` guards removed.
2. PM #6's CLAUDE.md note that pointed at `files/route.ts:37-44` as the canonical safe pattern is now stale and must be removed in the same commit (see Doc Updates).
3. Imports updated: `chat-files-store.ts` now imports `assertPathInside` from `./fs-utils`; the `files` and `files/download` routes import from `@/lib/storage/fs-utils`.
**Implication for prior fixes:** PM #6 is genuinely closed for the *route it actually patched* (`knowledge`). Its claim that `files/route.ts` was a safe reference was load-bearing in the wrong direction — every other code reviewer who copied that pattern (including the operator-facing `download` route) inherited the bug. The lesson here is also a lesson about PM #6: a PM that names a "good example" must verify the example, or remove the praise.
**Regression Coverage:**
- [`src/app/api/files/route.test.ts`](src/app/api/files/route.test.ts) — 4 cases, including the sibling-prefix bypass.
- [`src/app/api/files/download/route.test.ts`](src/app/api/files/download/route.test.ts) — 3 cases, including a body-content assertion that the file's contents were not exfiltrated.
- [`src/lib/storage/chat-files-store.test.ts`](src/lib/storage/chat-files-store.test.ts) — 2 cases, exported-API contract.

All three are direct-handler tests (NextRequest → exported `DELETE`/`GET`/function), no live server needed.
**Doc Updates:**
- `CLAUDE.md` § "🛡 Security Patterns" — the line referencing `files/route.ts:37-44` as a migration target is replaced with: "All known sites migrated to `assertPathInside`. Anyone adding a new route that touches a user-supplied filesystem path MUST use the helper, not inline `path.resolve` + `startsWith`."
- This PM (#16) replaces PM #6's "files/route.ts was the original safe pattern" claim — annotated inline.
**Rule:** A `startsWith(root)` check on a resolved path is **broken** unless `root` has a trailing path separator. `assertPathInside(root, candidate)` is the only correct sandbox check in this codebase — never write the inline form again, even "just for one quick route." If you see an inline `path.resolve` + `startsWith` outside `assertPathInside` itself, treat it as a P0 security defect and migrate before merging.

---

## 15. `RootLayout` Leaked `passwordHash` Through Unauthenticated `/login` HTML
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P0 (security — unauthenticated, scripted exfiltration of an offline-bruteforceable scrypt hash from any deployment running `next dev`)
**Symptoms:** Audit step `curl http://<orchestra>/login | grep passwordHash` returned the full `auth.passwordHash` string verbatim, alongside the rest of `data/settings/settings.json`. `/login` is intentionally public (the gate before the gate); zero cookies, zero auth. The hash is the literal string Orchestra uses to verify admin login — leaking it lets any visitor brute-force the password offline at their own pace.
**Detection:**
1. Independent audit of the white-screen / "admin/admin doesn't work" support request opened by the operator. `curl /login` was the second command run after `lsof -i :3000`.
2. The leak is shaped as a React DevTools timeline event in the RSC stream:
   ```
   J{"name":"Object.readFile","start":...,"value":"$@4b"}
   T426,{full settings.json content here}
   ```
   That `J{...}` envelope is a Next.js dev-mode instrumentation record — it captures **every** server-side `fs.readFile` and embeds its return value in the served HTML for the React DevTools / segment-explorer UI. Production builds do not include this instrumentation, so the leak is dev-mode-specific *as observed*; treating it as dev-only is fragile (any operator who runs `next dev` behind a tunnel / shared LAN / Docker port-forward exposes it).
**Root Cause:** [`src/app/layout.tsx`](src/app/layout.tsx) (pre-fix) did `const settings = await getSettings()` to read `settings.general.darkMode` and apply an initial `<html className="dark">` class on first paint. `getSettings` reads `data/settings/settings.json` whole — including `auth.username`, `auth.passwordHash`, `auth.mustChangeCredentials`. Next.js dev-mode RSC instrumentation captures the readFile and serializes its full return value into the HTML stream of every page that uses the root layout. `/login` uses the root layout. Therefore `/login` HTML carries every secret the file carries.

The vector is **a layout-level fs read of a multi-purpose config file**. The actual UI need (one boolean) is dwarfed by the data we surface to the wire (every byte of the file, captured by an instrumentation we don't control).
**Resolution:**
1. Removed the `getSettings()` call from `RootLayout`. The layout no longer awaits any FS data.
2. Replaced server-side dark-mode application with a pre-paint inline `<script>` in `<head>` that reads `localStorage["orchestra-theme"]` (with a `prefers-color-scheme: dark` fallback) and sets `document.documentElement.classList.add("dark")` synchronously before the first paint — no FOUC, no SSR data, no leak vector.
3. `ThemeSwitcher` (client) now writes `localStorage["orchestra-theme"]` in addition to syncing `general.darkMode` to `/api/settings` (PUT, auth-gated). The on-disk value remains the canonical source for the authenticated settings UI; it is no longer consulted during SSR.
4. The unauthenticated read surface that exposed `passwordHash` is closed: every byte of `data/settings/settings.json` is now reachable only behind a valid session.
**Implication for prior fixes:** PM #12 (production session-secret guard) and PM #13 (login bruteforce limiter) hardened the *online* attack against `/api/auth/login`. They had no defense against the offline attack: an attacker who downloads the hash via `/login` can brute it on their own hardware without ever hitting the rate limiter. PM #15 closes that flank.
**Regression Coverage:**
- [`src/app/layout.test.ts`](src/app/layout.test.ts) — text-level invariants on `layout.tsx`: must NOT import `@/lib/storage/settings-store`, must NOT contain a `getSettings(` callsite, and the localStorage bootstrap must be present. Cheap, refactor-stable.
- [`tests/e2e/auth-hash-leak.spec.ts`](tests/e2e/auth-hash-leak.spec.ts) — Playwright assertion on the live response bodies of `/login`, `/api/auth/status`, `/api/health`, and the anonymous `/` redirect chain: none may contain `scrypt$<salt>$<hash>` or the literal `passwordHash` key. Run via `npx playwright test tests/e2e/auth-hash-leak.spec.ts`.
**Doc Updates:** `CLAUDE.md` — new bullet under "🛡 Security Patterns" titled **"Sensitive data on the SSR boundary."** Encodes the rule: any server component reachable from an unauthenticated route must not read auth-bearing files. RootLayout is reachable from `/login`; therefore RootLayout cannot read settings.
**Rule:** Server components in `src/app/layout.tsx` and any other layout-or-page reachable WITHOUT a valid session MUST NOT call functions that read auth-bearing files (`settings.json`, anything under `data/settings/`, anything under `data/external-sessions/`). Next.js dev-mode RSC instrumentation captures every server-side `fs.readFile` and embeds its raw return value in the HTML stream — it is, in effect, an unintentional public DevTools log. Apply UI preferences (theme, locale, density) via a pre-paint inline script reading `localStorage` or a non-secret cookie. If you genuinely need server-rendered data on a public page, write a *narrow* accessor that reads only the specific fields, from a file that contains no secrets — and add a regression test that greps the HTML for known-sensitive substrings.

---

## 14. `middleware.ts` at Project Root — Silently Ignored, Auth Layer Theatrical
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P0 (security — every `/api/*` route was unauthenticated; every dashboard page reachable without a session)
**Symptoms:** Discovered during the pre-release end-to-end audit by curl-testing protected routes from a fresh shell with no cookies. `/api/settings`, `/api/projects`, `/api/skills`, `/api/memory`, `/dashboard` all returned 200 / rendered HTML instead of 401 / redirecting to `/login`. The login route + rate-limiter and the in-route session checks (`/api/auth/status`) worked correctly; everything else was wide open.

The bug existed for an unknown duration. The Playwright e2e test (`tests/e2e/swarm.spec.ts`) didn't catch it because it always completed onboarding (which sets a valid cookie) before navigating to protected paths — so it never tested the no-cookie path. Manual browser testing didn't catch it because real users always come through `/login`. Only `curl` against fresh URLs revealed the gap.
**Detection:**
1. `curl http://localhost:3001/api/settings` → 200 + JSON body (expected 401).
2. Inspecting `.next/server/middleware-manifest.json` confirmed it: `{"middleware": {}, "sortedMiddleware": []}` — Next.js had not registered the file at all.
3. The build output line "ƒ Middleware 39.2 kB" was misleading: that line appears regardless of whether the manifest is populated, so it was no signal.
**Root Cause:** `middleware.ts` was at the **project root** (alongside `package.json`). The project uses a `src/` directory layout (`src/app/`, `src/components/`, etc.). Per Next.js convention, when `src/` is in use, middleware MUST live at `src/middleware.ts` — root-level placement is silently ignored, with NO build error and NO dev-mode warning. The file compiled into the bundle (the manifest reports its byte size) but was never registered as the request handler.

The Next.js docs phrase this loosely: "in the root of your project ... or inside `src` if applicable." The "if applicable" clause means "required when `src/` exists." Easy to miss; pays once.
**Resolution:**
1. Moved `middleware.ts` → [`src/middleware.ts`](src/middleware.ts). No code changes — the file content was already correct, just at the wrong path.
2. Verified with curl after restart:
   - `/api/settings` → **401** ✓
   - `/api/projects` → **401** ✓
   - `/api/skills` → **401** ✓
   - `/api/memory` → **401** ✓
   - `/dashboard` → **307** redirect to `/login?next=%2Fdashboard` ✓
   - `/api/health` (public, in `isPublicApi`) → **200** ✓
   - Rate-limiter on `/api/auth/login` continues to work end-to-end.
3. Verified `.next/server/middleware-manifest.json` after rebuild — `sortedMiddleware: ["/"]` populated.
**Implication for prior fixes:** every P0 / P1 hardening that depends on session enforcement (PM #12 production secret guard, PM #13 rate-limiter, the `auth.enabled` semantics in `/api/auth/login`) was correct in principle but ineffective in practice until this PM landed. The rate-limiter is the only one that worked anyway, because it lives INSIDE the login route handler, not in middleware.
**Regression Coverage:** [`src/middleware.location.test.ts`](src/middleware.location.test.ts) — 3 cases:
- `src/middleware.ts` exists.
- No stray `middleware.ts` at project root.
- The module exports `config.matcher` (a refactor that drops `config` would silently disable enforcement; this test forces a build break instead).

The location-existence checks are file-system reads, so the test runs in milliseconds and is reliable.
**Doc Updates:** None required to `CLAUDE.md` directly — the existing § "🛡 Security Patterns" describes auth as a route-level concern, which it now is. README's threat-model section already states "Orchestra is designed for a single trusted operator" — that policy assumed enforcement, which is now actually true.
**Rule:** When migrating a Next.js project between root-level and `src/` directory layouts, MOVE every Next.js convention file (`middleware.ts`, `instrumentation.ts`, `app/`, `pages/`) at the same time. Next.js's silent "didn't find your middleware" failure mode is the worst kind: no error, no warning, just permissive defaults. If your project has `src/`, every Next.js convention file MUST live inside it — verify with `cat .next/server/middleware-manifest.json` after `next build` to confirm registration. Empty `middleware: {}` means it was ignored.

---

## 13. No Login Bruteforce Protection
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P1 (security — would not show on a localhost deployment but bites every VPS user)
**Symptoms:** None observed (no production users yet). Found by static audit during pre-release security review. `POST /api/auth/login` accepted unlimited credential guesses per IP. With the default `admin` / `admin` credentials and `mustChangeCredentials = true` (which forces a change ON FIRST LOGIN, not before — meaning the default password remains valid until login completes), an attacker pointing a wordlist at a VPS deployment had no algorithmic obstacle.
**Detection:** `grep -rn "rate.?limit"` in the codebase returned zero hits.
**Root Cause:** No rate-limit middleware existed. The login route ran the full scrypt verification (~100ms per attempt at N=131072) on every guess, providing CPU-cost throttling but no cumulative budget. A determined attacker could mount a slow but inevitable bruteforce, and the operator would have no signal until the password was breached.
**Resolution:** New module [`src/lib/auth/rate-limit.ts`](src/lib/auth/rate-limit.ts) implements an in-memory per-IP sliding-window limiter:
- 5 failed attempts within a 60-second window → lock for 5 minutes
- successful login clears the bucket (clean slate after legitimate access)
- different IPs are independent
- "unknown IP" (no usable header) gets its own bucket so unproxied traffic can't lock out IP-identified clients
- lazy GC every 100th call drops idle entries (keeps the Map bounded)

[`/api/auth/login`](src/app/api/auth/login/route.ts) checks `shouldAllowLoginAttempt(ip)` before parsing the body and calls `recordLoginOutcome(ip, "failure"|"success")` after the credential check. Bad-request responses (missing fields) intentionally do NOT count toward the budget — those are user errors, not credential tests.

IP detection precedence: `x-forwarded-for` (first comma-separated entry) → `x-real-ip` → `cf-connecting-ip` → `x-vercel-forwarded-for` → `"unknown"`. This matches standard reverse-proxy convention.

**Known caveats (documented in README threat-model):**
- `X-Forwarded-For` is attacker-controlled when Orchestra is exposed directly on the public internet. Operators MUST run behind a reverse proxy (Caddy/nginx/Cloudflare) that overwrites the header with the actual client IP. Without that, an attacker rotates the header and bypasses the limiter.
- In-memory state means a coordinated restart resets all windows. Acceptable for the local-first / single-VPS threat model; would need Redis or similar for fleet deployments.
- Rate-limiting is per-IP only, NOT per-username. Adding per-username would let an attacker DoS a known admin account by spamming wrong passwords. Per-IP is the correct trade-off here.

**Regression Coverage:** [`src/lib/auth/rate-limit.test.ts`](src/lib/auth/rate-limit.test.ts) — 12 cases: header-precedence (5), policy (7) including lockout, window-rollover-resets-counter, success-clears-bucket, IP-independence, and unknown-bucket-isolation. Uses `vi.useFakeTimers()` to test the time-based lockout deterministically.
**Doc Updates:** README threat-model section will surface the reverse-proxy requirement (P0 #4 in the same audit). CLAUDE.md unchanged.
**Rule:** Any password-checking endpoint MUST have rate-limiting before the password check — otherwise scrypt's CPU cost is the only obstacle and a patient attacker eventually wins. IP-based limiter on a Map is enough for single-process deployments; reach for Redis only when you actually run multiple processes.

---

## 12. Hardcoded Fallback Session Secret + Public `.env.example` Default
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P0 (security — would become a CVE the moment Orchestra goes open-source)
**Symptoms:** None observed in production yet. Found by static audit during 2026-05 review prior to public release. Any Orchestra deployment running in production without `ORCHESTRA_AUTH_SECRET` set was forgeable: the server signed session tokens with the hardcoded string `"orchestra-default-auth-secret-change-me"`. Anyone with read access to the source could:
1. Read `src/lib/auth/session.ts` on the public repo.
2. Compute `HMAC-SHA256(default_secret, base64url(JSON.stringify({ u: "admin", iat, exp })))`.
3. Set the resulting `payload.signature` string as the `orchestra_auth` cookie.
4. Bypass authentication on any deployment that left the env var unset.

The historical `.env.example` shipped `ORCHESTRA_AUTH_SECRET=eggent-local-dev-secret` as a literal value, which compounded the risk — operators who copied `.env.example → .env` (a textbook setup step) inherited a publicly-known secret and saw no warning because the env var WAS set, just to a public value.
**Detection:** Code audit. The threat is one `grep` on the public repo away from being a CVE filing.
**Root Cause:** `getSessionSecret()` in [`session.ts`](src/lib/auth/session.ts) had a single fallback path: log a warning and return a hardcoded string. There was no production guard and no concept of "known-insecure values to refuse." `console.warn` in stdout is the wrong defense here — operators don't read every warning, especially when the server "just works."
**Resolution:**
1. `getSessionSecret()` now refuses to operate in `NODE_ENV=production` when the secret is missing OR matches a deny-list of known-insecure values (the historical fallback, the .env.example placeholder, common low-effort strings like `"change-me"` / `"secret"` / `"default"`). It throws with a clear message including a `openssl rand -base64 48` command to generate a strong value.
2. The deny-list is a `Set` constant (not a regex / fuzzy match) — a deny-list, not a security boundary. A determined operator who sets `ORCHESTRA_AUTH_SECRET=hunter2` can still bypass; the goal is to catch the common forget-to-set / copy-the-example case, not to enforce password complexity.
3. In non-production, the fallback still works (with a louder warning that mentions the deployment risk explicitly), so local dev iterations don't require env-var setup.
4. `.env.example` now ships an empty `ORCHESTRA_AUTH_SECRET=` plus inline instructions to generate a fresh value with `openssl rand -base64 48`. No literal value to copy by accident.
**Regression Coverage:** [`src/lib/auth/session.test.ts`](src/lib/auth/session.test.ts) — 10 cases covering: production rejects missing/empty/historical-fallback/example-placeholder/common-low-effort secrets; production accepts a strong secret end-to-end (sign + verify); development falls back with warning; verifySessionToken throws on the same conditions (covers the middleware path). All passing as of 2026-05.
**Doc Updates:** README threat-model section will reference this fix (P0 #4 in the same audit). CLAUDE.md unchanged — the operator-facing contract (set the env var) is conventional.
**Rule:** Hardcoded fallbacks in open-source code are the single biggest source of "I shipped a CVE" stories. Every secret that has a default MUST refuse to operate in production with that default. `console.warn` is not a security control; throwing is. Examples files (`.env.example`, `config.example.json`) must NEVER ship literal secret values — only placeholders that are themselves rejected by the production guard.

---

## 11. SSRF Guard Bypass via IPv4-mapped IPv6
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P1 (security — found by static audit, no production exploit observed)
**Symptoms:** None observed in production. The PM #8 SSRF guard accepted IPv6 hostnames whose embedded IPv4 portion targets blocked ranges. `[::ffff:169.254.169.254]` reached AWS/GCP/Azure cloud-metadata endpoints despite `assertSafeOutboundUrl` claiming it was safe; `[::ffff:10.0.0.1]`, `[::ffff:192.168.x.x]`, and the deprecated `[::a.b.c.d]` form had the same shape.
**Detection:** Code audit of [`src/lib/security/url-guard.ts`](src/lib/security/url-guard.ts) → `isPrivateOrLinkLocalIPv6` after PM #8 landed. The IPv4 regex (`^\d+\.\d+\.\d+\.\d+$`) does not match IPv6 syntax (colons), and the IPv6 prefix list (`fc/fd/fe8…`) does not include `::`, so IPv4-mapped addresses fell into the "safe" branch by default.
**Root Cause:** Two layers compounded:
1. `isPrivateOrLinkLocalIPv6` only checked address-family prefixes; it had no concept of "IPv6 with embedded IPv4".
2. The WHATWG URL parser that Node uses NORMALIZES the dotted-quad form to pure hex before our guard sees it. `new URL("http://[::ffff:169.254.169.254]/").hostname` returns `[::ffff:a9fe:a9fe]`. So even a naive dotted-quad regex in `isPrivateOrLinkLocalIPv6` would never have matched in production — the guard had to operate on the hex form.
**Resolution:**
1. New helper `extractEmbeddedIPv4(host)` in [`url-guard.ts`](src/lib/security/url-guard.ts) parses the post-normalization hex form `^::(?:ffff:)?(hexhi):(hexlo)$`, decodes the two 16-bit groups into a dotted-quad IPv4, and returns `null` for non-IPv4-in-IPv6 addresses.
2. `isPrivateOrLinkLocalIPv6` now defers to `isPrivateOrLinkLocalIPv4` on any embedded address before running prefix checks — single source of truth for IPv4 ranges, no duplication.
3. Loopback through the mapped form (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`) intentionally falls through, matching the module's documented loopback-allowed policy (local Ollama use case).
**Residual risks (carried as documented caveats):**
- **Pure-hex IPv6 NOT in `::ffff:`/`::` form** that happens to encode a private IPv4 in its last 32 bits (e.g. 6to4 wrapper `[2002:c0a8:101::]` for 192.168.1.1) bypasses the parser. Off-the-shelf SSRF tooling does not use these forms; a complete fix requires parsing IPv6 to canonical bytes and matching CIDR ranges. Acceptable for the local-first threat model; revisit if Orchestra is ever hardened for untrusted networks.
- **DNS rebinding** still applies (carried from PM #8).
**Regression Coverage:** [`src/lib/security/url-guard.test.ts`](src/lib/security/url-guard.test.ts) — new `describe("IPv4-in-IPv6 bypass (PM #8 follow-up)")` block with 7 cases: 4 reject (cloud metadata, RFC 1918 10/8 + 192.168/16, deprecated `::a.b.c.d`, `0.0.0.0`), 2 allow (public IPv4 via mapped form, loopback via mapped form), 1 boundary (`::ffff:0.0.0.0` rejected as 0/8). Combined suite: 24/24 passing.
**Doc Updates:** Module-level docstring in `url-guard.ts` updated to spell out the WHATWG normalization behavior and the residual hex-form gap. CLAUDE.md unchanged — the `assertSafeOutboundUrl` API surface is unaffected; callers see no change.
**Rule:** When validating user-supplied URLs against an IP blocklist, remember that `URL.hostname` for IPv6 has been normalized — your regex must match the form Node hands you, not the form the user typed. And: never assume "two address families need two parallel guards" — IPv4-in-IPv6 means address families bleed into each other, so the IPv4 check must run on any embedded IPv4, regardless of outer wrapper.

---

## 10. Custom Swarm Configuration Wizard Disabled When API Key Lives in `.env.local`
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P1 (UX-blocking — user couldn't change models in Custom Swarm Configuration)
**Symptoms:** User opened Custom Swarm Configuration via the chat-header Config button, saw the OpenRouter provider already selected, but Step 3 (API Key) still asked them to paste a key, and Step 4 (Model) was completely grayed out — no models in the dropdown, couldn't pick a different model. Same exact wizard worked correctly when the user had pasted the key into the UI directly; failed only when the key lived in `.env.local`.
**Detection:** User report. Confirmed by inspecting `data/settings/settings.json` (no `chatModel.apiKey`, no `providerApiKeys`) against `curl /api/models?provider=openrouter` (returns 371 models, including the user's exact `google/gemma-4-31b-it`). Backend resolved `process.env.OPENROUTER_API_KEY` correctly; frontend wizard had no way to know the env key existed.
**Root Cause:** The wizard's source of truth for "is a key available" was `effectiveApiKey = chatModel.apiKey || providerApiKeys[provider] || otherConfig.apiKey || ""`. None of these surfaces include `process.env.*`, so users who only set their key in `.env.local` saw an empty `effectiveApiKey`, which:
- failed the [`useModels` guard](src/components/settings/model-wizards.tsx) `if (requiresApiKey && !apiKey) return;` — model fetch never happened, dropdown stayed empty;
- failed `apiKeyConnectionReady = !requiresApiKey || !!effectiveApiKey.trim()` — Step 4 stayed grayed out via `opacity-40 pointer-events-none`.

Backend `GET /api/settings` returned only persisted settings and never communicated env-key availability to the UI. The two layers had divergent views of "what keys are available" — backend correctly resolved env, frontend pretended none existed.
**Resolution:**
1. `GET /api/settings` now augments the response with a server-derived `envApiKeys: Partial<Record<provider, boolean>>` derived from `process.env.{OPENAI,OPENROUTER,ANTHROPIC,GOOGLE}_API_KEY`. Booleans only — the actual key never crosses the network.
2. `PUT /api/settings` strips any client-echoed `envApiKeys` before persisting — it's read-only from the client's perspective; this prevents accidental persistence and tampering.
3. New optional field `envApiKeys` added to `AppSettings` interface; documented as never persisted.
4. Wizard now reads `envApiKeyAvailable = settings.envApiKeys?.[provider] === true`, threads it into `useModels(...)` (relaxes the fetch guard), into `apiKeyConnectionReady` (un-grays Step 4), and into the Step 3 UI which now shows a green banner *"Key detected in `OPENROUTER_API_KEY`. You can leave the field blank — backend will use the environment value"* when the env key exists and the user hasn't typed an override.
5. `EmbeddingsModelWizard` got the same treatment so behavior stays consistent.
**Regression Coverage:** none added — this is a UI-flow fix without a clean unit-test seam. Validated end-to-end with `curl /api/settings | jq .envApiKeys` (returned `{ "openrouter": true }` for the user's actual environment) and the existing 206-test suite continues to pass.
**Doc Updates:** none yet — could be added to CLAUDE.md § "🛡 Security Patterns" as a "do not duplicate state between server and client" rule.
**Rule:** When the backend has a source of truth (env vars, file system, OAuth state) that affects what the UI is allowed to do, surface a derived read-only signal in the API response. Don't make the client guess — the gap turns into either dead UI (this PM) or false positives (UI thinks it can act, backend rejects).

---

## 9. Swarm Auto-Bypass Defied User UI Intent
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P1
**Symptoms:** Users enabled the "Swarm" toggle in the UI, sent substantive prompts (OSINT requests, "build a competitor for X", file analyses), and observed only a single-agent reply — no MoA expert pool, no QA Auditor, no parallel proposer drafts. Reproducible with phrasings like "Ищи, предоставляй", "Я нашёл этого человека…", "Сделай сайт-конкурент…", "Помоги с кодом".
**Detection:** User report. Confirmed by inspecting `data/chats/8eca7517-1175-42ac-9943-f5dc873aaaf3.json` msg [19] ("Ищи, предоставляй") which received a single-agent refusal at msg [20] — no MoA fingerprint (no expert drafts, no synthesis). Empirically replayed the regex against the user's actual phrasings and confirmed false negatives.
**Root Cause:** `src/lib/agent/agent.ts:1209` (pre-fix) had a double gate:
```ts
if (options.swarmEnabled !== false && queryNeedsMoA(options.userMessage)) {
```
`queryNeedsMoA` was a hard-coded regex covering only `найди / find / search / искать / поиск / research / look up / расскажи / explain / describe / analyse / audit / проанализ / реддит / reddit / forum / статья / article / link / ссылк`. Every other verb (`ищи`, `нашёл`, `сделай`, `помоги`, `посмотри`, `изучи`, `разберись`, …) defaulted to `swarm OFF`, silently overriding the UI toggle the user had just clicked. Three other gates compounded the issue:
1. The regex itself (above) — primary cause.
2. The Router inside `moa.ts` (`requiresSwarm`) — secondary, can also bypass on a weak `utilityModel` like `openrouter/free`.
3. The `NO_TOOL_PATTERNS` Gemma blacklist — investigated but innocent: only `deepseek-r1` is blocked on OpenRouter; Gemma works fine via that provider.
**Resolution:** Removed `queryNeedsMoA` and its call site. The UI's `swarmEnabled` toggle is now the single source of truth at the entry path. Inside `runMoAEnsemble`, the Router still decides `requiresSwarm: true|false` based on the prompt — that's its legitimate role (decide whether to spin up 3–5 expert proposers vs. a direct single-model answer). The fix returns control to the user: when they enable Swarm, the MoA flow always runs; the Router only adjusts its internal shape.
**Regression Coverage:** none yet — the remaining branch is `if (options.swarmEnabled !== false)`, a one-line invariant that doesn't lend itself to a unit test (the meaningful coverage lives at the Router level in `moa.ts`). E2E coverage tracked under PM #5's outstanding Playwright work.
**Doc Updates:** `CLAUDE.md` § "Mixture-of-Agents (MoA) Ensemble" (clarified that `requiresSwarm` in the Router is an internal MoA decision, NOT an override of the UI toggle).
**Rule:** A UI toggle is an explicit user intent. Don't second-guess it with a regex on the entry path. If you need cost protection on trivial prompts, it belongs inside the LLM-driven Router (which already exists), not in a hard-coded keyword list that grows brittle as the user vocabulary evolves.

---

## 8. SSRF Risk via Unvalidated `baseUrl` in Models API
**Date:** 2026-05
**Status:** RESOLVED (with documented residual risks)
**Severity:** P2
**Symptoms:** None observed in production — found by static audit. The `GET /api/models` endpoint accepts a `baseUrl` query parameter that is used to construct a server-side `fetch` to discover available models from a custom provider (e.g., Ollama).
**Detection:** Manual code review of `src/app/api/**/route.ts` for input validation gaps.
**Root Cause:** [`src/app/api/models/route.ts`](src/app/api/models/route.ts) (pre-fix) read `baseUrl` from `searchParams` in the `case "ollama"` branch and used it for `fetch()` without scheme/host validation, no timeout, no size cap. An attacker via CSRF/DNS rebind could pivot the local Orchestra process into a probe of arbitrary internal services reachable from the host: `http://169.254.169.254/latest/meta-data/` (cloud metadata), other localhost services (`:6379` Redis, `:5432` Postgres, etc.), intranet IPs.
**Resolution:**
1. New module [`src/lib/security/url-guard.ts`](src/lib/security/url-guard.ts) exports `assertSafeOutboundUrl(rawUrl)` which: parses with `new URL`, restricts scheme to `http:`/`https:`, blocks RFC 1918 private ranges (`10/8`, `172.16/12`, `192.168/16`), blocks link-local (`169.254/16` — covers all major cloud metadata endpoints), blocks `0.0.0.0/8`, blocks IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`).
2. Loopback (`127.0.0.0/8`, `localhost`, `::1`) is **intentionally allowed** — local Ollama on `http://localhost:11434` is a primary legitimate use case; blocking it would break the local-first model.
3. `models/route.ts` `case "ollama"` now invokes the guard before fetching, returns HTTP 400 with `UnsafeOutboundUrlError`'s message on rejection, and adds `AbortSignal.timeout(5000)` to cap fetch latency.
**Residual risks (carried as known caveats — accepted for the local-first single-operator threat model):**
- **DNS rebinding.** A hostname that resolves to a public IP at validation time and a private IP at fetch time bypasses this guard. Complete fix requires resolving the host once and pinning the IP for the fetch. Not implemented.
- **Loopback service scan.** `http://localhost:6379` (Redis), `http://localhost:5432` (Postgres), or any other local service is still reachable. Real defense is route auth + CSRF tokens on `/api/models`, not URL filtering.
- **Response size cap.** Not implemented; timeout-bounded only. A hostile responder that streams slowly under the timeout could exhaust memory. Add if Orchestra ever runs in a memory-constrained environment.
**Regression Coverage:** [`src/lib/security/url-guard.test.ts`](src/lib/security/url-guard.test.ts) — 17 cases covering scheme, loopback policy, RFC 1918 boundaries (incl. `172.15`/`172.32` just-outside cases), `169.254.169.254`, IPv6 ULA, IPv6 link-local. All passing as of 2026-05-03.
**Doc Updates:** `CLAUDE.md` → "🛡 Security Patterns" → "User-supplied URLs — SSRF guard" updated with the helper import and policy.
**Rule:** Any `route.ts` that performs a server-side `fetch` to a user-supplied URL MUST call `assertSafeOutboundUrl` and apply `AbortSignal.timeout`. Loopback is allowed by design (local Ollama); private/link-local ranges are not. DNS-rebind is a known gap — not a reason to skip the guard.

---

## 7. Background Job Mode Bypasses AbortSignal Contract
**Date:** 2026-05
**Status:** RESOLVED (with scope correction during fix)
**Severity:** P2 (downgraded from P1 after closer reading — see Scope correction)
**Symptoms:** None reproduced from a user report — found by static audit. After abort, an auto-pilot follow-up iteration could still fire if the abort landed during the backoff window.
**Detection:** Static audit of `dispatchAgentJob` and the auto-pilot loop in [`src/lib/agent/daemon.ts`](src/lib/agent/daemon.ts).
**Scope correction:** The original audit flagged `src/app/api/chat/route.ts:55-77` (background `dispatchAgentJob` without `req.signal`) as a bug. Closer reading shows this is a **deliberate design choice**, not a regression: a background job is by definition expected to outlive the HTTP request that started it (otherwise closing the tab would kill long-running auto-pilot work the user explicitly wanted). `dispatchAgentJob` creates its own `AbortController` registered in `activeJobs[chatId]`, and cancellation goes through `POST /api/chat/abort` → `abortJob(chatId)`, not through `req.signal`. This is the "one exception" already documented in CLAUDE.md § "🛑 AbortSignal Propagation Contract".
**Root Cause (real bug):** [`src/lib/agent/daemon.ts:148`](src/lib/agent/daemon.ts#L148) (pre-fix) scheduled the next auto-pilot iteration via `setTimeout` with only one guard: `if (activeJobs.has(options.chatId)) return;`. This guard prevented duplicate concurrent jobs but did NOT cancel a pending iteration when the user aborted. Sequence: user aborts → `abortJob` clears `activeJobs[chatId]` → the previously-scheduled `setTimeout` fires → it sees `activeJobs.has === false` → it dispatches a *new* iteration on a chat the user already cancelled. Billing leak, surprising UX.
**Resolution:**
1. Added an `autoPilotTimeouts` Map in `daemon.ts` keyed by `chatId`. Every `setTimeout` for a next auto-pilot iteration is now registered there.
2. `abortJob` now calls `clearAutoPilotTimeout(chatId)` BEFORE aborting the controller — even if the controller is gone, any queued backoff iteration is cancelled.
3. The `setTimeout` callback now also checks `signal.aborted` defensively (belt-and-suspenders against the controller being aborted between `clearTimeout` racing with the timer).
4. Exposed `__testInternals` (clearly marked test-only) so regression tests can prime/inspect the timeout registry without resorting to a full `runAgent` mock chain.
**Regression Coverage:** [`src/lib/agent/daemon.test.ts`](src/lib/agent/daemon.test.ts) — new `describe("PM #7 — auto-pilot abort gate")` block with 2 cases:
- abort during backoff cancels the next iteration callback;
- absent abort, the timeout fires normally and self-removes from the registry.

All 4 tests passing as of 2026-05-03.

**Doc Updates:** `CLAUDE.md` § "🛑 AbortSignal Propagation Contract" already documents the daemon-owned-controller pattern; no further changes needed.
**Rule:** `setTimeout`-based backoffs in long-running daemons MUST register their handle so the cancellation path can clear them. Without that, abort + reload races re-spawn cancelled work and leak budget.

---

## 6. Path Traversal in Knowledge Import API
**Date:** 2026-05
**Status:** RESOLVED
**Severity:** P1 (security)
**Symptoms:** None reported in production — found by static audit. `POST /api/knowledge` accepts a `directory` field from the request body and concatenated it into a `data/knowledge/<directory>` path used for file system operations.
**Detection:** Spot-check audit of API routes for path-traversal patterns. Compare against the canonical safe pattern at [`src/app/api/files/route.ts:37-44`](src/app/api/files/route.ts#L37-L44), which `knowledge/route.ts` did not follow.
**Root Cause:** [`src/app/api/knowledge/route.ts:24-26`](src/app/api/knowledge/route.ts#L24-L26) (pre-fix) did `path.join(DATA_DIR, "knowledge", directory)` where `directory` was user-supplied and unvalidated. `path.join` does NOT prevent `../../` traversal — it just normalizes the resulting path, so `directory = "../../etc"` resolved to a path outside the intended sandbox.
**Resolution:**
1. Added a shared helper `assertPathInside(rootDir, candidate)` in [`src/lib/storage/fs-utils.ts`](src/lib/storage/fs-utils.ts). It uses `path.resolve` + `startsWith(root + path.sep)` (the `path.sep` suffix is critical — without it, sibling paths like `/data/proj-abc` would slip through a `/data/proj-a` check).
2. `knowledge/route.ts` now calls `assertPathInside(KNOWLEDGE_ROOT, directory)` for relative paths and returns HTTP 400 on traversal attempts.
3. Absolute paths remain accepted as a deliberate **local-first design choice**: a single trusted operator can ingest documents from any directory on their own machine. This is documented inline in the route and called out as a known caveat — if Orchestra is ever multi-tenanted or exposed beyond `localhost`, this branch becomes an unauthenticated arbitrary file read and must be revisited (track in a future PM).
**Known caveats (carried forward as residual risks):**
- **Symlinks bypass.** `assertPathInside` normalizes paths string-wise; it does NOT call `fs.realpath`. A symlink placed inside the sandbox (by a privileged process or an admin-installed knowledge bundle) can still point outside it, and the helper will accept the path. Acceptable for Orchestra's local-first, single-trusted-operator threat model; replace with an async `realpath`-based guard if you ever multi-tenant. Documented inline in `fs-utils.ts:assertPathInside` JSDoc.
- **Other routes not yet audited.** At minimum: `goals`, `projects`, `external`. `files/route.ts` was the original safe pattern; it should be migrated to `assertPathInside` for consistency.
- **Twin parameter `subdir` (Defect #2 from 2026-05 audit, RESOLVED):** the original PM #6 fix only validated `directory`, leaving `subdir` to flow into `lib/memory/memory.ts:getDbPath` → `path.join(DATA_DIR, "memory", subdir, ...)`. Closed by adding (a) a strict regex validator at the entry point and (b) defense-in-depth `assertPathInside` inside `getDbPath`. Lesson encoded in CLAUDE.md § "🛡 Security Patterns".
**Regression Coverage:** [`src/lib/storage/fs-utils.test.ts`](src/lib/storage/fs-utils.test.ts) — new `describe("assertPathInside")` block with 8 cases, including the subtle prefix-collision case (`../orchestra-knowledge-test-root-evil/x`). All passing as of 2026-05-03.
**Doc Updates:** `CLAUDE.md` → "🛡 Security Patterns" already documents the canonical pattern; the helper export from `fs-utils.ts` is now the single source of truth.
**Rule:** Any user-supplied path fragment fed into the filesystem MUST go through `assertPathInside`. `path.join` alone is NOT a security boundary — it normalizes traversal silently. `startsWith(root)` without a `path.sep` suffix is also a bug — sibling directories matched by prefix slip through.

---

## 5. SSE Stream Persisted, UI Showed Empty Response
**Date:** 2026-05
**Status:** RESOLVED (regression test pending — see Regression Coverage)
**Severity:** P1
**Symptoms:** A long-running generation (translation request) completed end-to-end on the backend. `data/chats/<chatId>.json` contained the full assistant message with valid JSON, no pending tool parts, no zombie state. The user observed text starting to stream and then vanishing; the chat appeared frozen. Reloading the tab restored the message.
**Root Cause:** `src/hooks/use-background-sync.ts` maintained a single shared `EventSource` per tab with no `onerror` recovery and no resync on reconnect. When the browser tab was backgrounded (laptop sleep, OS network drop, tab discard, Wi-Fi switch) the SSE connection silently dropped. On return (`visibilitychange === "visible"`) the hook bumped subscribers, but if the EventSource was in `CLOSED` state it was never re-created, and `publishUiSyncEvent` calls emitted during the gap were lost forever — the bus is fire-and-forget, with no replay. Backend state was correct (the JSON file on disk is the source of truth); the frontend snapshot was stale.
**Detection:** Manual user report; reproduced by inspecting `data/chats/<id>.json` (full assistant message present) against the live UI (empty). The on-disk vs. in-memory divergence is the diagnostic signal.
**Resolution:**
1. Added `EventSource.onerror` handler with exponential backoff (1s → 15s) that recreates the socket once the browser gives up retrying (`readyState === CLOSED`).
2. `visibilitychange === "visible"` and `window.focus` now call `ensureSharedEventSource()`, which is idempotent on healthy connections and forces a fresh socket if the previous one was dropped.
3. On every `ready` event from the server (initial connect or post-reconnect), the hook broadcasts a synthetic `{ topic: "global", reason: "reconnect-resync" }` event to all subscribers. This bumps `syncTick` in `useBackgroundSync`, which `chat-panel.tsx:365` already listens to and refetches `GET /api/chat/history?id=<chatId>` from. Reconciliation is last-write-wins against the canonical on-disk store — safe because backend writes go through `safeWriteFile`.
4. Removed the 30s `setInterval(bump)` polling fallback that was masking the real bug. Critical Rule §2 in `CLAUDE.md` is once again the single source of truth ("no `setInterval` polling on the frontend").
**Regression Coverage:** none yet — TODO. Required Playwright scenario: start a long generation, programmatically trigger `visibilitychange === "hidden"` then `"visible"` mid-stream (or `offline`/`online`), assert final message renders without page reload.
**Doc Updates:** `CLAUDE.md` → "🔄 Realtime & Frontend Resilience Contract" (target items moved to "Already implemented"); Critical Rule §2 simplified back to no-exception form.
**Rule:** SSE reconnect without state resync is not reconnect. After any connection gap, always reconcile against the canonical store — never trust that the bus replayed missed events.

---

## 4. Chat History Sync Race Conditions
**Date:** 2026-04
**Status:** RESOLVED
**Severity:** P1
**Symptoms:** Messages in the UI would randomly disappear or overwrite each other when switching chats rapidly.
**Root Cause:** The `src/hooks/use-background-sync.ts` React effect lacked a debounce/cooldown mechanism, causing simultaneous `setMessages` updates to clash with the local Zustand state. Concurrent backend writes also corrupted the JSON file when two requests landed within milliseconds.
**Resolution:** Implemented atomic `withFileLock` on the backend (`src/lib/storage/fs-utils.ts:20`) and added a 1-second cooldown on the frontend hook to absorb React Strict Mode unmount/mount cycles.
**Regression Coverage:** `src/lib/storage/fs-utils.test.ts`.
**Doc Updates:** none at the time. Architectural rule retroactively codified during the 2026-05 refactor in `CLAUDE.md` § "Data Persistence & File I/O" and § "Realtime & Frontend Resilience Contract".
**Rule:** Always sanitize concurrent file writes via `withFileLock`/`safeWriteFile`. Always debounce frontend resync triggers — React Strict Mode and rapid navigation will fire effects twice.

---

## 3. Tool Hallucination via Static System Prompts
**Date:** 2026-04
**Status:** RESOLVED
**Severity:** P2
**Symptoms:** The agent would hallucinate tool calls or complain "I cannot use the search_web tool" when the user disabled Web Search in UI settings.
**Root Cause:** `src/prompts/system.md` contained an unconditional mandate: `"YOU MUST use the search_web tool to verify facts."` This prompt was applied even when `search_web` was stripped from the execution context due to user settings, leaving the model in an impossible bind.
**Resolution:** Updated the Fact-Checking Mandate to use conditional phrasing: `"If you have access to the search_web tool, YOU MUST use it..."`. The same conditional pattern is enforced inside `moa.ts` Router prompt (search-tool instruction is gated on `searchEnabled`).
**Regression Coverage:** none — prompt-level change, manually validated.
**Doc Updates:** none at the time. Retroactively reflected in `CLAUDE.md` § "Fact-Checking Mandate" during the 2026-05 refactor.
**Rule:** Static prompts must NEVER unconditionally demand the use of a tool that can be dynamically toggled off. Always gate tool mandates on tool availability.

---

## 2. MoA Aggregator Crash on Strict Models (e.g., Gemma 4)
**Date:** 2026-04
**Status:** RESOLVED
**Severity:** P1
**Symptoms:** The MoA (Mixture-of-Agents) ensemble successfully generated drafts, but the final Aggregator step threw a fatal API error, resulting in an empty user-facing response.
**Root Cause:** In `src/lib/agent/moa.ts`, the Aggregator was appending the final prompt as a `{ role: "user" }` message right after `safeHistory`, which often already ended with `{ role: "user" }`. Strict models (Gemma 4 via OpenRouter, some Anthropic configurations) reject API calls with consecutive same-role messages.
**Resolution:** For the Aggregator phase, the raw `safeHistory` is omitted and ONLY the `aggregatorPrompt` (which encapsulates both the user's original request and the expert drafts) is injected. Added a fallback that returns the best individual draft if aggregation fails.
**Regression Coverage:** `src/lib/agent/__tests__/` — MoA integration tests.
**Doc Updates:** none at the time. Retroactively codified in `CLAUDE.md` § "MoA Ensemble" → "Aggregator Constraint" during the 2026-05 refactor.
**Rule:** Always sanitize message arrays to prevent consecutive `user` or `assistant` roles, especially when using OpenRouter or diverse model providers. When in doubt, return a graceful fallback rather than an empty response.

---

## 1. The 100% CPU Zombie Stream Leak (V8 GC Thrashing)
**Date:** 2026-04
**Status:** RESOLVED (all originally-tracked residual gaps closed during 2026-05 audit)
**Severity:** P0
**Symptoms:** The Next.js production server (`npm run start`) hit 100% CPU usage after several days of uptime. Memory usage skyrocketed and the process locked up.
**Root Cause:** In `src/app/api/chat/route.ts`, the `req.signal` (which fires when the user closes the tab or clicks Stop) was NOT being passed down to `runAgent`. When users disconnected, the long-running agent streams (which can take minutes through tool calls and MoA) became orphaned but continued running silently. Over days, these zombie streams accumulated, exhausting Node's heap limit and triggering V8 garbage collection thrashing — which manifests as sustained 100% CPU.
**Resolution:** Explicitly bound `req.signal` to `abortSignal` in the interactive `POST /api/chat` path and propagated it into `generateText` and the daemon's primary iteration loop. The original outage shape no longer reproduces.
**Residual gaps audit (2026-05) — all closed:**
- ~~background-mode `dispatchAgentJob` in `chat/route.ts`~~ — clarified during PM #7 fix as a **deliberate design choice** (background jobs own their own controller, cancelled via `/api/chat/abort`), not a leak.
- ~~auto-pilot `setTimeout` backoff in `daemon.ts:148`~~ — closed by **PM #7 (RESOLVED)**: timeouts now registered in `autoPilotTimeouts` Map, cleared on abort, with regression coverage in `daemon.test.ts`.
- ~~`search-engine.ts:45,80` — web-search and Tavily `fetch()` calls~~ — **CLOSED 2026-05**: `searchWeb` now accepts an optional `AbortSignal` parameter that callers thread through from the AI SDK tool runtime (`tool.ts` and `moa.ts`). Internal `buildFetchSignal` helper combines the caller signal with a 15s `AbortSignal.timeout` so a single hung upstream cannot pin the agent.
- ~~`tool.ts:1420` — Telegram `sendDocument` upload~~ — **CLOSED 2026-05**: the AI SDK's `abortSignal` is now passed to `fetch`, combined with a 60s upload timeout via `AbortSignal.any` (with graceful fallback for runtimes lacking that API).
- ~~`cron/runtime.ts:16-19` — boot-time queue recovery~~ — **CLOSED 2026-05**: a module-level `bootRecoveryController` (global-keyed against Next.js dev-mode reloads) now gates the recovery loop. `process.once("SIGTERM"|"SIGINT")` aborts the controller; the loop checks `signal.aborted` before each `dispatchAgentJob` and skips ghost-task cleanup if shutdown started during recovery. Deferred jobs are picked up on the next boot since the queue store is persistent.
**Regression Coverage:** `src/lib/agent/daemon.test.ts` covers the auto-pilot abort gate. The other three residual fixes are propagation-only changes (signal threaded through existing callsites); they are exercised by the existing integration paths but lack dedicated regression tests — acceptable trade-off because the fixes are 1-line `signal:` additions, not new control flow.
**Doc Updates:** none at the time. Retroactively codified in `CLAUDE.md` § "🛑 AbortSignal Propagation Contract" and § "Agent Lifecycle & Loop Guards" during the 2026-05 refactor.
**Rule:** NEVER initiate a long-running LLM stream, fetch, child process, or `setTimeout`-based backoff without an `AbortSignal` tied to either the client connection, a daemon-owned controller, or — for boot-time work — a process-shutdown controller. Pair every long-running `fetch` with an `AbortSignal.timeout` even when a caller signal is present, so a single hung upstream cannot block the entire agent.
