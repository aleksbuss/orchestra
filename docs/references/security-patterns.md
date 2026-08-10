# Security Patterns — full text

> Level 2 reference for [`CLAUDE.md`](../../CLAUDE.md). Moved **verbatim** 2026-08-02 — the text below is the original, unmodified.
> **Read this when:** adding an API route, handling a user-supplied path or URL, touching Privacy Mode, auth, or an escape hatch

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

**The guard validates `new URL(raw).hostname`, NEVER the raw string — and that is load-bearing.** Octal (`http://0251.0376.0251.0376/`), hex (`http://0xa9fea9fe/`), integer (`http://3232235521/`) and short-form (`http://192.168.1/`) hosts are all the same addresses as `169.254.169.254` / `192.168.0.1`, and the OS resolver treats them as such. `IPV4_RE` (`\d{1,3}` per octet) does not match them; what saves the guard is that the WHATWG URL parser canonicalises every one of these to dotted-decimal *before* the blocklist runs. A refactor that inspected the raw authority instead would reopen the whole class silently — mutation-verified: doing so turns 8 blocklist cases into false negatives AND turns `http://010.0.0.1/` (octal for the **public** 8.0.0.1) into a false positive. Pinned by the `alternate IPv4 encodings` block in [`url-guard.test.ts`](src/lib/security/url-guard.test.ts). Do not eyeball these literals — `010.0.0.1` is public, `012.0.0.1` is `10.0.0.1`.

**Known caveats** (carried in PM #8): DNS rebinding bypasses the guard; loopback scans of `localhost:<other-service>` are still reachable; no response-body size cap. The real defense for those is route auth + CSRF tokens, not URL filtering.

Failure mode if you skip the helper: PM #8.

**This applies to agent TOOLS too, not just routes (PM #73).** Any tool that performs a server-side `fetch` of a URL the MODEL or user supplies (e.g. [`fetch_webpage`](src/lib/tools/fetch-webpage.ts)) MUST (a) pass the URL through `assertSafeOutboundUrl` + an `AbortSignal.timeout` BEFORE fetching, and (b) wrap the fetched bytes in `<UNTRUSTED_*>` markers (PM #27) before they reach the model — a fetched page is untrusted external content that can carry prompt-injection. `search_web` is exempt only because it hits a fixed operator-configured endpoint, not a model-supplied URL. `fetch-webpage.ts` is the reference implementation.

### Privacy Mode air-gap — every LLM entry point (PM #47, PM #58)

When `settings.privacyMode.enabled` is true, NO user data may leave the box to a cloud LLM vendor. The runtime guard is `assertPrivacyModeAllowsSettings(settings)` (`agent.ts`) — it throws when `chatModel`, `utilityModel`, `embeddingsModel`, `proposerTiers`, or the tournament judge resolves to a non-local backend.

**The guard must hold at EVERY function that creates a model and calls the AI SDK — not just `runAgent`.** PM #58 was a P0 data-egress leak caused by enforcing it at the interactive `runAgent` only: `runAgentText` (cron + the unauthenticated Telegram webhook) and `runSubordinateAgent` (`call_subordinate`, incl. the recursive path) skipped it, so cron ticks and Telegram messages silently shipped prompts to OpenAI/Anthropic/Google while the UI showed Privacy Mode ON. **Sprint 4 (guarded AgentSession) made this STRUCTURAL, not hand-copied:** agent entry points acquire settings via **`resolveGuardedAgentSettings()`** ([`agent-privacy.ts`](src/lib/agent/agent-privacy.ts)) — `getSettings()` + `assertPrivacyModeAllowsSettings(settings)` folded into ONE atomic step, so the guard fires INSIDE acquisition and cannot be forgotten. Do NOT call bare `getSettings()` + a separate guard line in the agent layer. **CI-enforced** by [`agent-preflight-gate.test.ts`](src/lib/agent/agent-preflight-gate.test.ts): a tree-scan that fails the build if ANY `src/lib/agent` module (except `agent-privacy.ts`) imports `getSettings` directly — so a new `runAgent`-like function physically cannot acquire settings past the air-gap. (The per-request Skeptic override is NOT in settings — still guard it separately with `assertPrivacyModeAllowsSkepticOverride`.) Regression: [`agent-entrypoints-privacy.test.ts`](src/lib/agent/agent-entrypoints-privacy.test.ts) (end-to-end throw) + [`agent-privacy.test.ts`](src/lib/agent/agent-privacy.test.ts) (`resolveGuardedAgentSettings` unit) + the gate. **Rule:** a security control enforced at "the" entry point is only as strong as the number of entry points — so fold the control INTO a chokepoint the entry points can't skip (here, settings acquisition), and add a CI gate that makes bypassing the chokepoint fail the build. A new `runAgent`-like function still owns its own abortSignal plumb + loop-guard wrap + `untrustedTrigger` — re-apply those explicitly.

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

- **`ORCHESTRA_EVAL_SKEPTIC_CONTROL=true`** — EVAL-ONLY. Read by [`moa-router.ts`](src/lib/agent/moa-router.ts) `isSkepticControlArmActive()`; honored ONLY when ALSO `NODE_ENV !== "production"`. Swaps the guaranteed MoA Skeptic (§1, PM #91) for a neutral same-slot analyst so the Skeptic's causal value can be A/B'd ([`docs/moa-skeptic-control-ab.md`](docs/moa-skeptic-control-ab.md)). Default OFF → strict no-op. The `NODE_ENV` gate blocks a production build, but note a local-first dev process has `NODE_ENV !== "production"`, so the REAL protection is default-off + the loud stdout warn (same operator-trust posture as `ORCHESTRA_DISABLE_AUTH`). NEVER set in production.

- **`ORCHESTRA_EVAL_AGGREGATOR_MODE=synthesis|tournament`** and **`ORCHESTRA_EVAL_IDENTICAL_PROMPTS=true`** — EVAL-ONLY, honored ONLY when `NODE_ENV !== "production"`, both in [`eval-arms.ts`](src/lib/agent/eval-arms.ts). They are the two factors of the selection-vs-averaging experiment ([`docs/moa-selection-vs-averaging.md`](docs/moa-selection-vs-averaging.md)): the first overrides `settings.aggregator.mode` per run (synthesis = blend N drafts, tournament = K judges pick one), the second replaces the DPG role personas with N copies of ONE neutral prompt (plain self-MoA / Best-of-N) while preserving headcount, distinct ids, and the role bucket that decides tool availability. Crossing them gives the arms. Default OFF → strict no-op; an unknown aggregator value is warned about and IGNORED in the library (a typo must not kill a live turn) while `run-evals.ts` REFUSES to start on it — the CLI is the real gate, because the expensive failure is a mislabeled arm, not a crashed turn. Same operator-trust posture as `ORCHESTRA_EVAL_SKEPTIC_CONTROL`, and the identical-prompts arm warns when that flag is also set (it already strips every role, so the two confound). NEVER set in production.
- **`ORCHESTRA_PACE_ALL_MODELS=true`** — strict-string override that makes the Sprint-2 proposer pacing ([`proposer-pacing.ts`](src/lib/agent/proposer-pacing.ts)) treat EVERY endpoint as free-tier (wider stagger + the concurrency cap), for operators whose free tier doesn't carry the `:free` id suffix. Pure latency shaping — it can only slow the fan-out, never change which model runs. Companion tunables (plain settings, not bypasses): `ORCHESTRA_FREE_STAGGER_MS` (default 900), `ORCHESTRA_PROPOSER_STAGGER_MS` (default 250, the PM #66 paid profile), `ORCHESTRA_FREE_TIER_CONCURRENCY` (default 2 — read ONCE per process, a mid-run change needs a restart).

- **`ORCHESTRA_MODEL_CIRCUIT_DISABLED=true`** — strict-string opt-out for the model-endpoint circuit breaker ([`model-health.ts`](src/lib/agent/model-health.ts), §1 free-tier failover). Every `record*`/`isModelCircuitOpen` call becomes a no-op, so proposers always dispatch the operator's configured tier model even when it is returning empty bodies. Use when debugging a suspected false-positive breaker; the breaker fails OPEN anyway (`selectHealthyConfig` returns the preferred config when the whole pool is dead), so this hatch is for isolating behaviour, not for restoring availability. Companion tunables (plain settings, not invariant bypasses): `ORCHESTRA_MODEL_CIRCUIT_THRESHOLD` (default 3 consecutive failures), `ORCHESTRA_MODEL_CIRCUIT_COOLDOWN_MS` (default 300000), `ORCHESTRA_PROPOSER_EMPTY_BACKOFF_MS` (default 2000, jittered +0–40%).

- **`ORCHESTRA_EXEC_SANDBOX=off`** — strict-string opt-out for the OS-level filesystem confinement wrapped around `code_execution` ([`exec-sandbox.ts`](src/lib/tools/exec-sandbox.ts), applied at the single `prepareExecution` chokepoint so neither spawn site can get an unconfined command). Default ON where a mechanism exists (macOS Seatbelt via `sandbox-exec`; nothing on other platforms yet — those degrade to the pre-sandbox behaviour and SAY so via `SandboxDecision.reason`). Confinement is **filesystem-only, on purpose**: writes are limited to the project workdir, the system temp root and the package-manager caches, and reads are denied on the credential set (`~/.ssh`, `~/.aws`, keychains, `.netrc`, … plus `data/settings`, which holds the provider keys). Network is deliberately untouched — confining it would break the web tools, MCP and every package install, and egress already has `assertSafeOutboundUrl`. Use this hatch when a legitimate tool needs to write outside the project and you would rather widen the blast radius knowingly than debug a Seatbelt denial. **SCOPE — read this before claiming the process is confined:** the wrap covers `code_execution` ONLY. `install_packages` ([`install-orchestrator.ts`](src/lib/tools/install-orchestrator.ts)) spawns package managers on its own and is **deliberately NOT confined** — installing a system package means writing to `/opt/homebrew`, `~/.local`, or a global npm prefix, so a project-scoped profile would not harden that tool, it would break it. It keeps the guarantees it already had (`scrubProcessEnv`, `dangerous-command-guard`, denial to untrusted triggers), and a package post-install hook therefore still runs arbitrary code with the operator's write access. Container isolation (`setup:docker`) is the only answer for that path. The provider-CLI spawns (`cli-runner.ts`, `cli-models.ts`) are likewise unwrapped and are a different trust class — the operator chose those binaries. **The anchor is the PROJECT ROOT, never `prepared.cwd`:** the terminal runtime persists each run's `pwd` into its session state, so anchoring on the prepared cwd made the sandbox self-widening in two steps — `cd ~` is permitted, and the next command in that session inherited write access to the whole home directory (verified end-to-end, then pinned by a test in `code-execution.runtimes.spawn.test.ts`). **Two traps, both found by the module's own tests, both fail OPEN:** (1) every path must be `realpath`-resolved before it enters a profile — Seatbelt matches the RESOLVED path, and on macOS `/var`, `/tmp`, `/etc` are symlinks into `/private`, so a rule written against the unresolved path matches nothing while the profile still parses; (2) the credential read-denials must be emitted LAST, because Seatbelt resolves by last match and any `allow` appended after them silently re-opens the whole set.
- **`ORCHESTRA_CALL_DEADLINE_MS=0`** — PM #98 bound for NON-streaming calls ([`callDeadlineSignal`](src/lib/agent/stream-watchdog.ts), default 120000 ms), applied to every `generateText`/`generateObject` in the agent layer and enforced by [`call-deadline-contract.test.ts`](src/lib/agent/call-deadline-contract.test.ts). `0` returns the caller's bare signal, i.e. the pre-PM-#98 unbounded behaviour.

- **`ORCHESTRA_STREAM_TTFT_MS=0`**, **`ORCHESTRA_STREAM_IDLE_MS=0`** and **`ORCHESTRA_PROVIDER_HEADERS_TIMEOUT_MS=0`** — PM #98 stream time bounds ([`stream-watchdog.ts`](src/lib/agent/stream-watchdog.ts), [`fetch-timeout.ts`](src/lib/providers/fetch-timeout.ts)). Any positive value re-tunes the budget (defaults 90000 / 120000 / 60000 ms); **`0` is the documented OFF switch** and restores the pre-PM-#98 behaviour where a silent provider hangs the turn indefinitely. Note the asymmetry, which is deliberate: a NEGATIVE or non-numeric value is treated as a typo and IGNORED in favour of the default, because a fat-fingered budget silently disabling a watchdog is how the seven-minute hang comes back with nobody noticing. Only `0` — an unambiguous choice — turns a bound off.

If you add another runtime-invariant escape hatch, document it here in the same PR. Cross-link from the invariant rule (e.g. Critical Rule §1 mentions this).

---

### Dependency advisories — why `audit:gate` stops at `critical` (audited 2026-08-07)

`npm run audit:gate` is `npm audit --audit-level=critical --omit=dev`. It is **not** a claim that there are no `high` advisories — there are. Audit of `main` at `2087e43`:

- **12 advisories in PRODUCTION dependencies (1 low, 2 moderate, 9 high)**; 16 including dev. Zero `critical`, which is why the gate is green.
- **Zero are first-party.** All reach the tree through four roots: `agent-browser` (→ `webdriverio` → `undici`, `shell-quote`, part of `ip-address`), `@modelcontextprotocol/sdk` (→ `hono`, `fast-uri`, part of `ip-address`), `next` (→ `sharp`, `postcss`), `archiver` (→ `brace-expansion`).
- **`npm audit fix` (non-breaking) closes none of them.** Measured, not assumed: `--dry-run` reports *added 129 packages, changed 20* and leaves the count **unchanged at 16**. 149 packages of lockfile churn for zero advisories closed is a worse trade than carrying them.
- **`overrides.nanoid` is a security pin, not a dependency.** `postcss@8.4.31` (via `next`) asks for `nanoid@^3.3.x` and resolves to a version inside the `<=3.3.16` advisory range. A top-level `nanoid` declaration used to mask this by pinning the tree; **removing that "unused" dependency de-pinned the transitive copy and surfaced a new `high`.** The override (`^3.3.17`) expresses the actual intent — force a safe transitive version — without re-adding a dependency nothing imports, which `knip` would flag again on the next sweep. **Lesson: before deleting an unused dependency, check whether anything else in the tree wants the same package at a looser range.** An unused *declaration* can still be doing work as a version floor.

**`undici` deserves an explicit note because it is the one that LOOKS alarming and is not.** Nine of the advisories are `undici`, including a TLS-certificate-validation bypass — which reads like a direct hit on the SSRF guard's threat model. It is not. Orchestra imports `undici` **nowhere** in `src/`; the npm package arrives only via `agent-browser → webdriverio → {cheerio, webdriver}`, whose HTTP client talks to a local WebDriver endpoint. Server-side `fetch` on Node 22 uses the runtime's **built-in** undici, which is patched by Node releases and is unaffected by this package's version. Verify the same way before escalating the next one: `npm ls <pkg> --omit=dev` for provenance, then grep `src/` for a direct import.

**Posture:** accepted risk, carried deliberately, re-audit when a root dependency is bumped for other reasons. Raising the gate to `high` would make CI permanently red on advisories no first-party change can fix — the same "a permanently-red gate trains everyone to ignore it" reasoning that keeps `lint:strict` out of CI. If a `critical` ever lands, or an advisory becomes reachable from first-party code, the gate fires and this section is wrong — re-derive it rather than trusting the counts above.

---

## Free Mode — zero-configuration operation on `:free` endpoints (2026-08-03)

`settings.freeMode.enabled` overlays the model slots with free OpenRouter models chosen from the live catalogue, so a user configures nothing. Implementation: [`src/lib/agent/free-mode.ts`](../../src/lib/agent/free-mode.ts), applied inside `resolveGuardedAgentSettings` ([`agent-privacy.ts`](../../src/lib/agent/agent-privacy.ts)).

**Why that chokepoint.** Same PM #58 reasoning as the air-gap: every agent entry point already acquires settings there (CI-enforced — no `src/lib/agent` module may import `getSettings` directly), so cron, Auto-Pilot and external-message turns inherit Free Mode by construction rather than by someone remembering to thread it.

**Privacy Mode always wins.** Free Mode means OpenRouter; Privacy Mode forbids cloud egress. `applyFreeMode` yields when `privacyMode.enabled` is set, returns `suppressedByPrivacyMode: true`, and the caller says so out loud. `assertPrivacyModeAllowsSettings` then runs on the FINAL post-overlay settings — defence in depth, so a regression in the yield still cannot ship data out. Regression: the Privacy-Mode case in [`free-mode.test.ts`](../../src/lib/agent/free-mode.test.ts).

**The Router needs `structured_outputs`.** Persona generation and tournament ballots go through `generateObject`; a free model without the capability answers HTTP 400, the Router falls back to three STATIC personas and every judge fails — fail-safe and loud in stdout, but the turn still *looks* healthy. `modelSupportsStructuredOutputs` ([`openrouter-pricing.ts`](../../src/lib/cost/openrouter-pricing.ts)) reads the per-model `supported_parameters` captured from `/api/v1/models`; the Router slot is filled only from that subset, and when none qualifies the selection reports `routerSupportsStructuredOutputs: false` instead of pretending. `undefined` (catalogue not loaded) is NOT `false` — an unknown model is never treated as incapable.

**Proposer tiers are spread across DIFFERENT free models.** A free endpoint under load returns HTTP 200 with an empty body, triggered by exactly the shape MoA generates: 3–5 proposers at one endpoint through one key. Pacing bounds the burst in time; spreading tiers across endpoints spreads it across upstream quotas, removing the contention rather than queueing behind it. The failover stack itself needs no extra switch — it keys on the `:free` id suffix (`isFreeTierModel`), so selecting free ids engages every layer automatically.

**Security shape:** selections carry `provider` + `model` ONLY, never an `apiKey` or `baseUrl` — keys resolve server-side, the same posture the per-request Skeptic override settled on. The overlay is computed per request and NEVER persisted, so turning Free Mode off restores the operator's own models verbatim. `freeMode` is an allowed `PATCH /api/settings` root (the header pill toggles it); `privacyMode` deliberately is NOT — an air-gap must not be flippable from a one-click surface.
