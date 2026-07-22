# Test-Strengthening Guide — Orchestra `src/lib`

**Written 2026-07-21. Mostly self-contained** (a few entries point to `CLAUDE.md` / the source
files — all in the repo, so read them there; there is no external dependency). Based on a full Stryker
mutation run over all of `src/lib` (24,049 mutants; overall score 45.4%, 60% on covered code)
**and a cross-model (Gemini/DoubleTake) adversarial review that corrected the first triage.**
Re-run any time: `npx stryker run stryker-lib.config.json` (config in repo root, ~2h). HTML
report to browse every survivor: `reports/stryker/stryker.html`.

---

## 0. Read this first — how to use the guide (the method, and its LIMITS)

A **survived mutant** = a code change the tests COVERED but did NOT catch. It flags a test that
runs the code without asserting enough. **But a survivor is not automatically a bug** — some are
*equivalent mutants* (impossible to kill). This guide tells you where to look; YOU must look at
the test before acting.

**Corrections from the Gemini review (do not skip — the first triage was too crude):**

1. **Do NOT blanket-dismiss `StringLiteral` / `ObjectLiteral` / `ArrayDeclaration` survivors as
   "noise."** They are equivalent ONLY when the string is a log/error-reason message nothing
   asserts. They are **REAL** when the literal is: a security blocklist token, an API/payload
   key, a status string a caller switches on, a config default (`{ retries: 3 }` → `{}`), or an
   initial state (`[]` → `["x"]`). **Rule:** for each literal survivor, ask "does any consumer
   branch on this value?" If yes → real, add an assertion. If it's only a human-readable message
   → equivalent, skip. (Verified example: in `dangerous-command-guard.ts` the 52 string
   survivors are `id`/`reason` fields — mostly equivalent, EXCEPT the `id`s that no test pins via
   `expect(r.ruleId).toBe(...)`; add ruleId assertions for those.)

2. **Prioritise by CRITICALITY, then kill-RATE — NOT by raw survivor count.** Ranking by count
   just surfaces the biggest files. One surviving `Conditional` in a security guard that lets a
   dangerous input through outweighs 200 survivors in a formatting script. Tiers below are
   ordered by blast radius, not count.

3. **A very low kill-rate has TWO possible causes — you MUST open the test to tell which.** Do NOT
   infer the cause from the number (the first draft wrongly assumed "18% = over-mock = rewrite";
   `agent.ts` is 18% yet its test is well-designed — see its entry). Open the test and read its
   `expect(...)`s:
   - **(a) It asserts on MOCK call-counts / mock return values, never on real outputs** → the design
     is broken; more assertions can't help → **REWRITE** toward asserting real outputs. (Scope a
     rewrite as its OWN multi-hour task with a clear "done" = the target scenarios assert real
     persisted/returned values; do not open-endedly rewrite.)
   - **(b) It asserts on REAL outputs but only covers a few scenarios of a big/branchy file** →
     design is fine, it's just UNDER-COVERAGE → **ADD SCENARIOS** (strengthen), do not rewrite.
   Same 18% number, opposite fix. The test's assertions — not its score — decide.

4. **kill-rate hides `NoCoverage` and punishes branchy code.** A file can show a great ratio while
   1000 mutants have no coverage at all; branch-heavy logic naturally yields harder mutants. Use
   the numbers as a pointer, never as a grade.

**Mutation-verify EVERY fix** (this is the whole point — don't trust green):
> Add the test → break the exact source line the survivor names (flip the condition / blank the
> string) → run the file's test → confirm it goes **RED** → restore the source. If it stays green,
> your new assertion is decorative; try again.

5. **BEFORE adding any suggested case below, `grep` the test first — several may ALREADY exist.**
   A cross-check of the actual files (2026-07-21) found this guide's first draft told you to add
   cases that were already present (e.g. `dangerous-command-guard.test.ts` already covers flag
   reordering / quoting / `$HOME` variants). A survivor does NOT prove the input is untested — it
   can be an *equivalent* regex/boundary mutant that no input can distinguish. **Only add what is
   genuinely missing, and only keep the addition if breaking the source line turns it RED.** This
   guide's file PRIORITIES are sound; treat each specific "add X" as a hypothesis to verify, not a
   fact — Stryker + a model that cannot see the code both overstate.

---

## TIER 1 — SECURITY (a survivor here CAN be a real vulnerability — but verify each)

> **Actionable priority order within security (post file-verification):** `scrub-env.ts` ✅ DONE
> (2026-07-22, see its entry). Remaining: the single `dangerous-command-guard.ts` L282/L288
> conditional. `dangerous-command-guard`'s 266 regex survivors and `url-guard`'s boundary survivors
> were file-verified as mostly EQUIVALENT / already-covered — they are listed below for completeness
> but are **LOW priority; do them only with spare time, expected yield near zero.** Do not open the
> 5-day effort by hunting equivalent mutants.

### `security/scrub-env.ts` — ✅ DONE 2026-07-22 (37.93% → 48.28%; zero behavioural survivors).
Tests in `src/lib/security/scrub-env.test.ts` (direct import) + `src/lib/tools/code-execution-env.test.ts`.
**Outcome (line-by-line recheck 2026-07-22 — every category below break-the-line-verified, not inferred):**
of the 18 survivors, 4 tests were added to `scrub-env.test.ts`, each verified GREEN → break source → RED → restore:
1. bare `AUTH`/`AUTHORIZATION` — carried by the always-scrub list ONLY (no regex token), so it isolates
   L36 `ALWAYS_SCRUB_NAMES.has(upper)` AND protects the `"AUTH"`/`"AUTHORIZATION"` Set entries (L15/L18/L19);
2. mixed-case `Authorization` — kills L35 `toUpperCase()` mutants;
3. gemini-cli with `GOOGLE_APPLICATION_CREDENTIALS` unset → `in`-check asserts the key is ABSENT,
   isolating L72 `if (value !== undefined)`;
4. **gemini-cli with `GOOGLE_APPLICATION_CREDENTIALS` SET → asserts it survives passthrough.** Found by
   the recheck: blanking that map entry (L59:54) was GREEN across the whole suite — the entry was a
   genuinely UNPROTECTED value (service-account auth would silently break in the spawned CLI). The only
   one of the 15 "literal survivors" that was a real gap.

**DoubleTake (Gemini) cross-review round (same day) — 3 accepted findings, all fixed + mutation-verified:**
5. **regex-token-family test** — PASSWD/KEYS/TOKENS/SECRETS/PASSWORDS/PRIVATE alternation tokens had ZERO
   pins in either test file (deleting any → suite green). One test now gives each token a name ONLY it
   catches (`API_KEYS` — the KEY branch fails its boundary on the trailing S; `DB_PASSWD`, `OAUTH_TOKENS`,
   `CLIENT_SECRETS`, `USER_PASSWORDS`, `GPG_PRIVATE`). Verified: PASSWD-token removal → RED, PRIVATE-token
   removal → RED.
6. **hermetic `beforeEach`** — the file now clears the whole host env before seeding (matching
   `code-execution-env.test.ts`), so assertions can't be masked/flaked by the operator's real shell exports.
7. **gemini-cli test asserts `ANTHROPIC_API_KEY`/`TAVILY_API_KEY` dropped** — verified by injecting
   `ANTHROPIC_API_KEY` into the gemini passthrough in SOURCE → RED.
Rejected from the same review (with reasons): Windows case-insensitive `process.env` hazard (no Windows
target — darwin local, Linux CI); empty-string-value passthrough (the scrubber is name-based by design).
One DESIGN finding escalated to its own task, NOT fixed here: `HTTP_AUTHORIZATION`/`PROXY_AUTHORIZATION`
(and arbitrary `*_AUTH_*` app names) bypass both the regex and the exact-match Set — fix is a design
decision because an `AUTH` regex token would scrub `SSH_AUTH_SOCK` (breaks ssh-agent in subprocesses) and
`AUTHORIZATION_HEADER` (pinned as KEPT by an existing contract test).

The remaining survivors, by verified category:
- **L34 `if (value === undefined) continue;` = EQUIVALENT (unreachable).** `process.env` physically cannot
  hold a real `undefined` enumerable value — `Object.defineProperty(process.env, k, {value: undefined})`
  THROWS and `process.env.k = undefined` coerces to the string `"undefined"`.
- **L16/L17 (`"ORCHESTRA_AUTH_SECRET"`/`"ORCHESTRA_SESSION_SECRET"` Set entries) = EQUIVALENT by
  REDUNDANCY.** Both names also match the secret regex (`_SECRET` at end), so blanking the Set entry
  changes nothing — verified: source blanked → all 13 tests stay GREEN. No test can ever kill these.
- **⚠️ STATIC-MUTANT FALSE-SURVIVORS (the rest) — a tooling artifact, not a test gap.** Survivors on
  MODULE-LEVEL consts — the `SECRET_ENV_RE` regex (L14 ×2), the Set/map literals — report "Survived"
  even when a test pins the value, because the const is evaluated ONCE at import and the mutated literal
  never re-evaluates in a cached module graph. PROVEN by breaking the SOURCE: regex `^`-drop → 1 test RED,
  regex `$`-drop → 6 tests RED, `"codex-cli": []` → RED, map `{}` → 3 RED, `"AUTH"` blanked → RED (the new
  test). All value-protected now. **DO NOT add tests to chase these — the Stryker number will not move.**
  This pattern will recur on EVERY module-const-heavy file below (`dangerous-command-guard.ts` regex table,
  `cost/pricing.ts` price maps, `providers/model-config.ts` data-map): treat a "regex/literal/map survivor"
  as false-survivor-or-equivalent FIRST and break-the-line to decide — BUT the L59:54 find above is the
  counter-lesson: one of them can still be a real unprotected value. Break-the-line each literal whose value
  a consumer depends on; expect ~1 in 15 to be real. (Killing them inside Stryker would need each mutant to
  run against a fresh module graph — expensive, out of scope for per-file strengthening.)

<details><summary>Original survivor notes (superseded by the outcome above)</summary>

Behavioural survivors on the SCRUBBER'S OWN CORE LOGIC:
- **L36 `if (ALWAYS_SCRUB_NAMES.has(upper)) continue;`** (Conditional survived) → no test proves
  the always-scrub list (`ORCHESTRA_AUTH_SECRET`, `AUTH`, `AUTHORIZATION`…) is dropped **via this
  branch specifically**. Add: for EACH name in `ALWAYS_SCRUB_NAMES`, assert it's absent from the
  scrubbed env; and a name that is ONLY caught by this list (not by the regex) to isolate the branch.
- **L34 `if (value === undefined) continue;`** → add a case where `process.env` has an explicitly
  `undefined` value and assert it's skipped, not copied as `"undefined"`.
- **L14 regex `/(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|…)/`** → add boundary cases: `MY_API_KEY`
  (scrubbed), `KEYBOARD` (kept — not `_KEY`), `X_TOKEN_Y` vs `TOKENISER`. Each kills a regex mutant.
- **L72 `if (value !== undefined) overrides[name] = value;`** → assert an explicit override with a
  real value lands, and an `undefined` override does not.

</details>

### `security/dangerous-command-guard.ts` — score 9% BUT VERIFIED DECENT. LOW priority.
**CORRECTION (file-verified 2026-07-21): the 9% is misleading — this file is actually well-tested.**
Test: `src/lib/security/dangerous-command-guard.test.ts` (244 lines, table-driven blocks/allows).
Reading the actual test shows it ALREADY covers the variants the first draft told you to add:
`rm -fr /` (flag order), `rm -Rf /` (uppercase), double-spaces, trailing whitespace, `"$HOME"` /
`$HOME/` / `${HOME}` (all three quoting forms), etc. **Do NOT add duplicate variant rows.**
- The 266 "regex survivors" are **overwhelmingly EQUIVALENT mutants** — Stryker mutates each
  complex regex 12–19 ways, and most produce a pattern that still matches every tested input
  (e.g. `\s+` → `\s*`, char-class tweaks that don't change matching on real strings). A 9% score
  on a file made almost entirely of regexes is EXPECTED and does NOT mean the guard is weak.
- **Only real action (optional, low value):** open `reports/stryker/stryker.html`, filter to this
  file's regex survivors, and look for the RARE one that represents a GENUINE bypass — i.e. a
  dangerous string that the *mutated* regex fails to block but the original blocks. If found, add
  that exact string as a `blocks` row. Expect to find few or none.
- The 2 `Conditional` survivors (L282/L288 `if (!shellSubprocess.ok) return …`) are the only
  behavioural ones: add a python/node case whose EMBEDDED shell command is dangerous, asserting the
  runtime dispatch returns the block. That is the single worthwhile fix here.

**This file was WRONGLY elevated to a Tier-1 emergency in the first draft (parroting a review that
could not see the test). It is decent — treat as low priority.**

### `security/url-guard.ts` — score 75% (decent). SSRF guard. LOW priority.
Test: `src/lib/security/url-guard.test.ts` (already strengthened this session for fe80::/10).
**CAVEAT (verify first): the RFC-1918 boundaries are already largely tested** — the suite has
`172.15.x`/`172.32.x` (allow) and `172.16`/`172.31` (block), so the `172.16–31` boundary survivors
are likely EQUIVALENT (a `>=`→`>` on an edge no test input reaches, or an over-block `→true` that
the "allows" cases don't neighbour). `grep` the test before adding anything.
- Only if a survivor turns RED when you break its line: add the missing exact boundary pair
  (e.g. `192.168.0.0` vs `192.167.255.255`; the octet `> 255` reject on L68). Most won't — expect
  mostly equivalent mutants here.
- **L57 `Number.isFinite(hi) || Number.isFinite(lo)`** (IPv4-in-IPv6 decoder): a genuinely
  malformed embedded-IPv4 that should return `null` may be worth one case — verify it's not covered.

---

## TIER 2 — SAFETY / RCE (high blast radius)

### `agent/tool-guard.ts` — score 25% (killed 62, survived 113 + 40 regex). Loop guard (PM #76).
Test: `src/lib/agent/tool-guard.test.ts`. Survivors cluster on the guard's INTERNAL helpers that
build the repeat-detection key + extract tool output — if these break, the loop guard silently
stops catching runaway tool loops.
- **L60 `if (!trimmed.startsWith("{") || !trimmed.endsWith("}"))`** (Conditional + Logical +
  Method survived): `parseJsonObject` accepts things it shouldn't. Add: `"[1,2]"` → null (array,
  not object), `"{"` → null (unterminated), `"{}"` → parses, `" {..} "` → trims then parses,
  `"garbage"` → null. Assert the return, not just "no throw".
- **L35 `if (Array.isArray(value))`** (Conditional→false): the array branch of the arg-serialiser
  isn't asserted. Add a tool call whose args CONTAIN an array and assert the dedup key is stable /
  differs correctly when the array changes.
- **L39 / L76 `if (!record)`** (null-record branch): pass a non-object where a record is expected;
  assert graceful handling, not a throw.
- **L72 `if (typeof output === "string")` / L79 `record.output` ternary**: pass a tool result with
  a NON-string `output` and assert the extractor handles it; pass one WITH a string and assert it's
  used. Currently the string-vs-non-string branch is unverified.

### `tools/code-execution.ts` — score 41% (killed 118, survived 99 + no-coverage 600). RCE executor.
Test: `src/lib/tools/code-execution.spawn.test.ts` (added this session — real `node` spawns).
GAPS the spawn suite left (even the fresh tests aren't mutation-complete):
- **L166 `Number.isFinite(options.yieldMs)` + L178 `!runInBackground && yieldMs === null`**: the
  `yieldMs` (yield-to-background) path is untested. Add: call with `{ yieldMs: 500 }` on a command
  that outlives the yield, assert it returns a running managed session; and a finite `yieldMs` on a
  fast command, assert it returns the completed result.
- **L217 `summaries.sort((a,b) => b.startedAt - a.startedAt)`** (Arrow/Method survived): start TWO
  background sessions, assert `listManagedProcessSessions()` returns them newest-first.
- **L334–L356 `killManagedProcessSession` branches** (`sessionId.trim()`, `if(!id)`, `if(existing)`,
  the `success:false` returns): add kill of an empty id → error; kill of an already-finished session
  → `already_finished`; kill of an unknown id → `not_found`. Each is a distinct untested branch.
- The 600 no-coverage mutants are the terminal-runtime + python-venv resolution paths — those need
  NEW tests (a real `sh -lc` echo command + a python `-c` run), not strengthening.

---

## TIER 3 — CORE ORCHESTRATORS (check test DESIGN — likely REWRITE, not strengthen)

### `agent/agent.ts` — score ~12–18% (killed 32, survived 144). The god-file orchestrator.
**CORRECTION (file-verified 2026-07-21): NOT an over-mock / rewrite case — the first draft was
wrong.** `src/lib/agent/agent.integration.test.ts` is WELL-DESIGNED: it mocks only the LLM
(`MockLanguageModelV3`, unavoidable) and asserts on REAL outputs — the persisted assistant text
(`expect(text).toBe("INTEGRATION_OK")`), that `onFinish` actually persisted to disk, that hallucinated
`<tool_call>` markup is stripped, that a re-issue happened. That is exactly the right shape. **Do NOT
rewrite it.** The 18% kill-rate is simply because ONE integration file with a few scenarios cannot
exercise a 1700-line orchestrator's many branches — it is UNDER-COVERAGE (too few cases), not bad
design. **Fix = ADD MORE END-TO-END SCENARIOS** on the same solid pattern: a tool-loop that calls
several tools then answers; an error/`finishReason` path; the step-limit pause (PM #82); compaction
firing on a long history; a fallback-model switch. Each new scenario, asserting real persisted
output, kills a cluster of the 144 survivors. Sized as its own task, but it's coverage-expansion,
NOT a redesign.

### `agent/moa.ts` — score ~50% (killed 107, survived 103). MoA ensemble core.
`moa.test.ts` is the harness (see CLAUDE.md gotchas: `mockReset` the AI mocks per reflection test;
assert `log.info` via a file-level `vi.mock`). Strengthen by asserting on the ACTUAL synthesis
handoff / draft selection / disagreement result, not just that the ensemble ran. Medium priority.

### `agent/agent-response.ts` — killed 585, survived 208 + 62 regex. Decently tested, big + branchy.
High absolute survivors but also high kills — it's a large parser (unwrap serialized calls, detect
hallucinated markup, premature-completion). Strengthen the specific parsers with more real
malformed-input fixtures (PM #61/#81/#84 shapes). Lower priority than Tier 1–2.

---

## TIER 4 — STRENGTHEN (lower criticality; add assertions/cases)

Ranked by kill-rate, lowest first — but ALL below Tier 1–3 in urgency:
- `cron/tool-normalize.ts` (killed 175 / survived 210) — high count, low criticality. Add cases
  covering each normalisation branch's OUTPUT, not just "no throw".
- `providers/provider-auth.ts` (241 / 122) — OAuth/token handling; add token-shape + error-path asserts.
- `tools/install-orchestrator.ts` (173 / 200) — installer fallback ladder; assert which manager is
  chosen per ecosystem + failure fallbacks.
- `cron/service.ts` (377 / 182), `storage/project-store.ts` (386 / 89), `storage/chat-store.ts`
  (182 / 70) — storage/CRUD; assert persisted content + error handling, not just call success.

**LOWEST priority (mostly equivalent, but NOT a blanket ignore):** `providers/model-config.ts`
(0% — pure config data-map). Most mutants ARE equivalent, BUT per Correction #1 do not blanket-skip:
if any entry is an endpoint URL, a model id, or a default a consumer branches on, a test that
resolves/validates each map entry would kill those specific mutants — worth it ONLY if such an entry
exists. Pure `reason`/log-message string survivors everywhere: genuinely skip.

---

## How to measure progress + concrete success criteria

Fast inner loop while writing ONE test: run just the new case, not the whole file —
`npx vitest run <file> -t "<test name substring>"` (or add `.only`), so the break-it→RED→restore
check is seconds, not minutes. Only run the full file before moving on.

Measure a file after strengthening: edit `mutate` in `stryker-lib.config.json` to that ONE file,
`npx stryker run stryker-lib.config.json` (seconds–minutes for one file), compare survivors in
`reports/stryker/stryker.html`.

**Definition of done per tier (goal is NOT 100% — equivalent mutants make that impossible):**
- **Tier 1 (`scrub-env.ts` + the `dangerous-command-guard` L282 conditional):** zero SURVIVING
  behavioural mutants. This is the only MUST for a first pass.
- **Tier 2 (`tool-guard.ts`, `code-execution.ts` covered gaps):** behavioural survivors down to
  only ones you've individually confirmed equivalent (break-the-line stays green). The 600
  `code-execution` no-coverage mutants are a SEPARATE, larger task (write NEW terminal/python
  spawn tests) — scope it on its own, don't fold it into "strengthening."
- **Tier 3 (`agent.ts` scenarios, etc.):** a bounded goal, e.g. "+4 end-to-end scenarios covering
  tool-loop / error path / step-limit / compaction" — NOT "kill all 144." Stop when the added
  scenarios are green + mutation-verified; the rest is diminishing returns.
- **Tier 4:** opportunistic; no hard target. Strengthen a file only if you're already touching it.

If you only have limited time: do Tier 1 `scrub-env.ts` fully, mutation-verified, and stop. That
single file is the highest security value in the whole list.


---

## COMPLETE SCOPE — every file below 60% covered-score (44 files)

**The tiers above are PRIORITY PICKS (~11 files), NOT the full scope.** A cross-check (after the
operator caught the omission) found the tiers named only 11 of these 44 files — 33 were
silently missing. This is the COMPLETE inventory; do NOT stop after the tiers. `score` =
covered-score, `surv` = survived mutants, `nocov` = mutants with no test at all. Same rules:
verify each survivor (grep the test, break-the-line -> RED); some are equivalent. Worst-first.

| score | surv | nocov | file |
|---|---|---|---|
| 0% | 198 | 0 | `providers/model-config.ts` |
| 9% | 347 | 0 | `security/dangerous-command-guard.ts` |
| 12% | 233 | 481 | `agent/agent.ts` |
| 14% | 12 | 130 | `tools/cron-tool.ts` |
| 15% | 17 | 38 | `tools/goal-tools.ts` |
| 22% | 18 | 167 | `tools/project-nav-tools.ts` |
| 23% | 76 | 53 | `providers/hardware-detect.ts` |
| 25% | 190 | 140 | `agent/tool-guard.ts` |
| 26% | 35 | 177 | `tools/skill-tools.ts` |
| 28% | 21 | 4 | `tools/memory-knowledge-tools.ts` |
| 30% | 247 | 76 | `agent/moa.ts` |
| 30% | 16 | 59 | `tools/project-mcp-tools.ts` |
| 31% | 59 | 0 | `providers/model-output-limits.ts` |
| 32% | 13 | 0 | `types.ts` |
| 32% | 85 | 4 | `agent/moa-reflection.ts` |
| 35% | 320 | 112 | `cron/tool-normalize.ts` |
| 36% | 79 | 131 | `providers/cli-models.ts` |
| 37% | 12 | 49 | `storage/chat-files-store.ts` |
| 38% | 149 | 8 | `cost/pricing.ts` |
| 38% | 18 | 0 | `security/scrub-env.ts` |
| 39% | 39 | 24 | `agent/semaphore.ts` |
| 39% | 42 | 0 | `memory/text-splitter.ts` |
| 41% | 168 | 600 | `tools/code-execution.ts` |
| 42% | 186 | 231 | `mcp/client.ts` |
| 45% | 148 | 35 | `agent/reflection.ts` |
| 46% | 200 | 168 | `tools/install-orchestrator.ts` |
| 47% | 69 | 35 | `observability/logger.ts` |
| 47% | 140 | 27 | `tools/web-task.ts` |
| 48% | 43 | 1 | `storage/settings-store.ts` |
| 48% | 73 | 72 | `tools/code-exec-tools.ts` |
| 50% | 76 | 8 | `agent/moa-prompts.ts` |
| 50% | 7 | 19 | `tools/blackboard-tools.ts` |
| 52% | 26 | 0 | `cron/parse.ts` |
| 53% | 32 | 0 | `util/multi-process-guard.ts` |
| 53% | 43 | 61 | `agent/daemon.ts` |
| 56% | 191 | 155 | `providers/provider-auth.ts` |
| 56% | 74 | 10 | `agent/compressor.ts` |
| 57% | 68 | 26 | `tools/fetch-webpage.ts` |
| 57% | 19 | 61 | `tools/telegram-tools.ts` |
| 58% | 5 | 0 | `agent/agent-stream.ts` |
| 58% | 27 | 1 | `agent/reflection-evidence.ts` |
| 59% | 116 | 30 | `storage/chat-store.ts` |
| 59% | 80 | 9 | `agent/agent-messages.ts` |
| 60% | 52 | 6 | `memory/knowledge.ts` |

**Notable files the priority tiers MISSED — re-tier these by criticality:**
- `mcp/client.ts` (42%, 186 surv) — MCP read-only gate + SSRF guard. **Belongs in TIER 1 (security).**
- `tools/code-exec-tools.ts` (48%) — even after this session's kill-intent fix + tests, the tool
  execute bodies / schemas are under-tested. TIER 2.
- `cost/pricing.ts` (38%, 149 surv) — billing math; a wrong survivor here mis-charges. TIER 2-3.
- Agent core: `reflection.ts` (45%), `moa-reflection.ts` (32%), `compressor.ts` (56%),
  `daemon.ts` (53%), `semaphore.ts` (39%) — core orchestration logic. TIER 3.

**Honest scope:** ~33% of all files (44 of 132 with real coverage) are below 60%; ~17% below 40%.
Full cleanup is WEEKS, not days. Prioritize by criticality (security -> safety -> core -> rest);
the long tail is chipped away over time, not in one pass.
