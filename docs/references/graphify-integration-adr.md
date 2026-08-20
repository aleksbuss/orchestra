# Graphify integration — tool vs skill vs MCP (decision record)

> Level 2 reference for [`CLAUDE.md`](../../CLAUDE.md).
> **Read this when:** wiring an external CLI into the agent, adding a code-navigation capability, or before copy-pasting any `child_process.exec` tool sketch into `src/lib/tools/`.

**Status:** ACCEPTED — shipped as a skill ([`bundled-skills/graphify/SKILL.md`](../../bundled-skills/graphify/SKILL.md)). Tool form REJECTED for now with a recorded escalation path. MCP form DEFERRED.
**Date:** 2026-08-15

---

## Context

[Graphify](https://github.com/Graphify-Labs/graphify) is an MIT Python CLI that parses a repo into a local knowledge graph (`graphify-out/`) and answers `query` / `explain` / `path` over it.

**Measured build behaviour, not the marketing line (v0.9.28, 2026-08-15).** Code files go through tree-sitter **AST extraction — deterministic, offline, free**. *Non-code* files (docs) go through a **semantic LLM pass when a provider key is present in the environment**, which costs money silently: building the 16-code + 1-doc `bughunt` project emitted `semantic extraction on 1 files via gemini` / `tokens: 852 in / 311 out, est. cost (~gemini): $0.0014`. A first draft of this record repeated the advisor's "no LLM calls, free to build" claim; a controlled rerun (same directory, keys present, zero doc files → still `AST extraction`) isolated the trigger as **the presence of non-code files**, not the key. On the agent path this is moot — `scrubProcessEnv` gives the child no provider key, so the agent always gets the AST path — but never describe the build as unconditionally free.

It was **already in use in this repo — at development time only**, as an instruction in Level 1 telling the *human's* coding assistant to query the graph before grepping. It had **zero references in `src/`**: Orchestra's own agents could not use it while working on user projects under `data/projects/<id>/`.

The question this record answers: should agents get it, and through which of the two capability systems (see §8 in [`tools-and-skills.md`](./tools-and-skills.md)) — or through MCP?

## Decision

**Ship it as a skill routed through `code_execution`. Do not add a tool. Do not add an MCP server.**

The skill is opt-in per project (`installBundledSkill`), so it costs zero prompt tokens and zero risk until an operator installs it into a project. *(Updated 2026-08-18: installation is now **binary-gated auto-install** — a new project receives graphify automatically when, and only when, the `graphify` CLI is present on `PATH`. See "Binary-gated auto-install" below. The zero-cost-until-present property is preserved: no CLI → no install.)*

## Options considered

### A. Dedicated Orchestra tool — REJECTED (shape was unsafe; benefit did not clear the cost)

An external advisor proposed this. It is recorded here **verbatim in its defects** so nobody reconstructs it later:

```ts
// DO NOT COPY — every numbered defect below is in these five lines.
parameters: z.object({ command: z.enum([...]), args: z.string() }),   // (4)
execute: async ({ command, args }) => {
  const { stdout } = await execAsync(`graphify ${command} "${args}"`,  // (1) (2)
    { cwd: context?.cwd || process.cwd() });                          // (3)
  return stdout;                                                      // (5) (6) (7)
}
```

1. **Shell injection.** `args` is model-authored and interpolated into a shell string. A quote ends the argument.
2. **Env leak.** `child_process.exec` inherits `process.env`; every API key reaches the child. Non-negotiable #9 requires `scrubProcessEnv({ EXPLICIT_VAR })`.
3. **Unvalidated `cwd`.** Non-negotiable #2 requires `assertPathInside`.
4. **`parameters:` is AI SDK v4.** This repo is on `ai@^6`; the field is `inputSchema`.
5. **Returns a raw error string.** Non-negotiable #15: tools return `{ success: false, error }` — a throw kills the run, a returned failure lets the agent self-heal.
6. **No abort signal, no time bound.** Non-negotiables #13 + PM #98.
7. **Bypasses `assembleAgentToolSet`** (no loop guard, non-negotiable #14) and would require updating the pinned inventory in [`tool.test.ts`](../../src/lib/tools/tool.test.ts).

**If this is ever escalated to a tool, the correct shape is:** `execFile` with an **argv array** (no shell), a **fixed subcommand enum** (`query` | `explain` | `path` — never a free-form command string), `scrubProcessEnv` with an explicit allowlist, cwd from `resolveContextCwd(context)` (never model-supplied), a bounded deadline, capped stdout, and registration through `assembleAgentToolSet`.

**The one real thing the skill form gives up:** a read-only graph tool of that shape is exactly the class that *could* be allowlisted for untrusted triggers (Telegram, cron), which `code_execution` denies at [`code-exec-tools.ts:77`](../../src/lib/tools/code-exec-tools.ts). Record that as a deferred escalation path, **not as a virtue** — if a concrete need for graph access from an untrusted trigger appears, build the tool above.

### B. Skill through `code_execution` — CHOSEN

Inherits, without new code: the sandbox, `scrubProcessEnv`, the dangerous-command guard, cwd containment via `resolveContextCwd` (project `workDir`, not model-chosen), the execution deadline, output truncation ([`output-truncate.ts`](../../src/lib/tools/output-truncate.ts)), and the untrusted-trigger denial.

It **does not widen the injection surface**: `code_execution` already grants arbitrary shell. Teaching the agent one more binary adds no capability it lacked.

Costs: the model composes a shell string each time, gets unstructured stdout, and must distinguish "no path found" from "index missing" from "parse error" by reading text. Accepted — the failure mode is benign (command fails → the agent greps instead).

### C. Graphify's own MCP server — DEFERRED

Strongest argument, and it is a real one: upstream owns the schema, the output semantics, and the lifecycle; Orchestra already has an MCP client that treats every server-authored byte (name, description, schema, output) as untrusted (§ MCP contract in [`tools-and-skills.md`](./tools-and-skills.md)); no shell-string composition.

Against: a sidecar Python process to keep alive, an extra runtime dependency, **the staleness problem is completely unchanged**, and MCP-sourced tools do **not** inherit `code_execution`'s untrusted-trigger denial — they would need their own gate. Revisit only when a concrete consumer exists.

## What the graph can and cannot prove

**A `path` result that finds nothing is not proof that two things are unconnected.** tree-sitter builds a static syntactic graph. It cannot see dynamic imports, string-keyed registries, DI containers, event buses, reflection, generated code, DB-level coupling (shared tables, foreign keys), env/config coupling, cross-process calls, or MCP hops — and it cannot see anything the index is stale on or the parser skipped.

An empty result means **"no static AST edge in this parser's current graph, under its edge model."** Nothing more.

**Rule:** an empty `path` result must *lower* confidence, never zero it. The graph is a strong hypothesis generator and a weak refutation instrument. A Skeptic that treats it as proof of absence becomes *more confidently wrong*, which is worse than not having the graph at all.

## Freshness policy

**Staleness is the dominant correctness risk.** The agent edits files; the graph then lies with structure and confidence.

- **Mtime-based invalidation was designed and dropped.** The first draft said "re-index if `graphify-out/` is older than the agent's last write." The agent has no write ledger in prompt context and cannot compute this. Timestamps are unreliable anyway — clock granularity, copied trees, and writes that bypass the agent's file tools.
- **Session-scoped rule instead:** *if you have edited files since your last graphify call in this session, run `graphify update .` first.* This is checkable from the agent's own transcript.
- **Do not auto-update before every query.** `graphify update .` mutates project state and can race with concurrent writes.
- **Concurrency:** MoA fans out N proposers over one project directory. Concurrent `update` can tear the index. Proposers are **query-only**; only the main agent path re-indexes.
- A stronger form — an index manifest carrying graphify version, project root, generation time, and a source fingerprint, with results refused when the fingerprint differs — is the right design if this ever becomes load-bearing. It is not built; the skill is dogfood-only.

## Empirical demonstration of the epistemic limit

Run against `data/projects/bughunt` (a real Telegram Mini App monorepo: Phaser game + Cloudflare Workers API), graphify v0.9.28, 2026-08-15:

```
$ graphify path "ApiClient" "authMiddleware"
No path found between 'ApiClient' and 'authMiddleware'.

$ graphify path "middleware/auth.ts" "verifyInitData()"      # positive control
Shortest path (1 hops):
  middleware/auth.ts --imports [EXTRACTED]--> verifyInitData()
```

The two are **absolutely coupled**: [`apps/game/src/systems/ApiClient.ts:20`] sets `headers['X-Telegram-Init-Data']`, and [`apps/api/src/middleware/auth.ts:19`] reads `c.req.header('X-Telegram-Init-Data')`. One string literal, two files, an HTTP boundary — and **zero** static edges. The positive control proves the instrument was working when it returned nothing. Change that header name in one file and the app breaks; the graph would report the same "no path" before and after.

This is the canonical shape of the failure: a Skeptic asking "are these connected?" gets a confident, well-formatted **No** about a pair whose coupling is the entire feature.

## Query semantics — identifiers, not questions

`graphify query` matches **identifier/name tokens in the graph**, not natural language. Measured on the same index:

| Query | Result |
| --- | --- |
| `"auth"` | 8 nodes |
| `"verifyInitData"` | 11 nodes |
| `"telegram"` | 35 nodes |
| `"authentication"` | **0 nodes** |
| `"how does authentication work"` | **0 nodes** |

Natural-language queries appear to work on large graphs only because a long question incidentally contains real identifiers. Running `cluster-only` first does **not** change this. Write queries as symbol names.

**Refined 2026-08-20 on the ~5100-node Orchestra index — the failure mode is worse than "0 nodes".** On a large graph a natural-language question does not return nothing; it seeds the traversal from whatever common English word happens to collide with a node name. `query "how does the forced answer path work"` seeded `['path', 'final-answer-failover.ts', 'boundForcedAnswerContext()']` — the bare word **"path" matched a node literally named `path`** — exploding the traversal to 257 nodes and truncating with *"the answer may be among the 193 cut nodes."* So the small-graph symptom is a silent empty result and the large-graph symptom is a plausible-looking but seed-polluted subgraph. Both argue the same fix: **query with identifiers, never with prose.**

## `--budget` does not cap what it says it caps (measured 2026-08-20)

`graphify --help` documents `query --budget N` as "cap output at N tokens (default 2000)". It is enforced against the **node** set only; edge lines are appended unmetered. Measured on the Orchestra index, `query "forcedAnswer"`:

| `--budget` | chars | NODE lines | EDGE lines | truncated? |
| --- | --- | --- | --- | --- |
| 500 | 1,890 | 16 | 0 | yes |
| **2000 (default)** | **29,977** | 53 | **201** | **no** |
| 8000 | 29,977 | 53 | 201 | no |

29,977 chars ≈ **7,500 tokens, 3.7× the advertised default**, and byte-identical at 2000 and 8000 — the budget is simply not reached by the node count, after which the 201 edges ship free. **Always pass an explicit `--budget` (500–800) to `query`.** `explain` is unaffected: one node, ~971 chars.

Two related CLI traps: `graphify query --help` is **not a flag** — it searches for the string "help" and returns `helpers.ts` / `helpText()`; only top-level `graphify --help` lists subcommand flags. And `hook-guard`, the subcommand wired into `.claude/settings.json` by `graphify claude install`, is undocumented in `--help`.

## The "grep the graph first" mandate — WITHDRAWN 2026-08-20

The blanket instruction ("MANDATORY: run `graphify query` before grepping raw files") is removed from [`CLAUDE.md`](../../CLAUDE.md), [`src/prompts/system.md`](../../src/prompts/system.md) and [`bundled-skills/graphify/SKILL.md`](../../bundled-skills/graphify/SKILL.md). It is replaced by a **question-shape** rule: structural → `explain` (then `affected` / `path`, and `query` only with `--budget`); literal → grep, explicitly marked as the correct call rather than a lapse.

Rationale, in the order the evidence landed:

1. **It was ignored, and ignoring it was right.** The eval measured the graph invoked in **1 of 3** runs with the skill installed, the index built and the binary on PATH. In a separate working session the hook fired ~10× while the agent ran the test suite, restarted a dev server and extracted token counts from JSON — literal work the graph cannot answer. A code graph models structure, not runtime values or literal text.
2. **A correctly-ignored MANDATORY is not free.** `CLAUDE.md` carries ~27 genuinely binding rules (`assertPathInside`, `safeWriteFile`, `abortSignal`, `scrubProcessEnv`). Spending the word on a directive that is wrong ~2/3 of the time trains the model to discount the marker everywhere it appears. This is the concrete harm; the unrealized graph benefit is the lesser one.
3. **Compliance was more expensive than non-compliance.** Obeying the mandate meant `query` at its default budget: ~7,500 tokens per call, per the table above.
4. **A four-model external council (`4take`) reviewed this unanimously** on (1) and (2), and split 3–1 on the statistics. The dissent argued the between-arm ratio (1.80×) exceeded the within-arm spreads (1.79×, 1.69×) and therefore showed a real effect; its own supporting arithmetic averaged 1.668 and 1.763 to "≈1.80" (actually 1.715) by rank-pairing best-with-best, which manufactures the effect. Welch on the arm data: **t = 1.50, df ≈ 1.2, against t-crit 4.303** — not significant, and invalid anyway as an intent-to-treat comparison where 2 of 3 treated runs never received the treatment. **The −44% figure stays unreported.**

**Maintenance hazard:** the `CLAUDE.md` graphify section and the `.claude/settings.json` PreToolUse hook are both **generated by `graphify claude install`**, which is why the hook text ("MANDATORY: … You MUST run `graphify query`…") comes from the binary and not from this repo. Re-running that installer will overwrite the narrowed section and restore the mandate. `.claude/` is gitignored, so the hook is per-machine and outside this repo's review. If the section reappears verbatim, an installer re-run is the cause — re-apply this narrowing rather than assuming a human reverted it.

## Trust markers inside the graph

AST-derived edges print `[EXTRACTED]`. Nodes produced by the semantic (doc) pass carry `verification: "unverified"` — graphify flags them itself when it cannot find evidence in the source. On the `bughunt` index: 64 nodes unmarked (AST), 1 `unverified` (`pnpm_workspace_packages`, from the LLM doc pass). Treat `[EXTRACTED]` as structural fact and `unverified` as a hint that may be hallucinated.

## Failure modes verified against the real binary

- **Missing index fails loudly, and does not walk up the tree.** In a directory with no index: `error: graph file not found: <cwd>/graphify-out/graph.json`, **exit code 1**. So an agent in a project without an index gets a hard, detectable failure — it does not silently answer from some other repo's graph.
- **Residual hazard:** if a shell command `cd`s out of the project into a directory that *does* have an index, the answers describe the wrong repo. `resolveContextCwd` pins the starting cwd to the project, but a shell command can leave it. The skill forbids this explicitly.
- **tree-sitter can fail on half-written code** the agent just produced. A failed `update` must be treated as "no fresh graph", not as "nothing changed".

## End-to-end verification (2026-08-15, `scripts/run-real-task.ts`, project `bughunt`, `openrouter/~deepseek/deepseek-v4-flash-latest`, swarm forced)

Two real agent turns, same project, same question. **Primary evidence is on disk** — chats `realrun-bughunt-688c1369` (Run A) and `realrun-bughunt-42c9e7d4` (Run B); reconstruct either with `/api/debug/chat/<id>` (see [`observability-runbook.md`](./observability-runbook.md)). The `bughunt` project keeps its `graphify-out/` index and its installed copy of the skill, so both runs are re-runnable.

**Run A — neutral prompt, skill installed but not named.** The agent did **not** load the skill: `{"read_text_file": 11}`, zero `load_skill`, zero `code_execution`; 98.1s. The `<available_skills>` block WAS in the prompt with the full description, so this is a selection decision, not a delivery failure — and it was the **right** decision: on a 16-file project, reading beats indexing, which is what this skill's own "when not to use" section says. It produced a fully correct answer naming `X-Telegram-Init-Data`, `verifyInitData`, the HMAC-SHA256 + 24h freshness check and the D1 upsert.

**Run B — skill named in the prompt.** `{"load_skill": 1, "code_execution": 12, "read_text_file": 5}`; 174.8s. The agent executed the skill as written: probe (`graphify --version` → `0.9.28`), identifier queries (`query "auth"` → 8 nodes, `query "ApiClient"` → 15 nodes), `explain "authMiddleware"`, then `path "ApiClient" "authMiddleware"`.

**It hit the trap and did not fall in.** Verbatim from the answer:

> There is **no static call path** between the client and the auth check — `graphify path "ApiClient" "authMiddleware"` returns *"No path found"*. The connection is **dynamic, over HTTP** … The graph's static edges stop at the process boundary; the coupling lives in one string literal (`X-Telegram-Init-Data`) shared across the wire.

The strings "not connected" and "unconnected" do not appear. It cited `[EXTRACTED]` as its trust marker, and read 5 files instead of 11 — "only the exact lines the graph pointed me to". **The epistemic rule survives contact with a cheap model under the exact failure it was written for.**

**The honest cost line:** on this project the skill was **1.8× slower** (174.8s vs 98.1s) and spent 12 subprocess calls to reach an answer the baseline already had. Run B's answer is *better reasoned* about static-vs-dynamic coupling; it is not *more correct*. Nothing here demonstrates value at 16 files — the case for the graph has to be made on a codebase where reading everything is not an option, and that has not been measured.

## The big-codebase measurement (2026-08-15) — the value case is still NOT made, and the reason is invocation

The 16-file run above closed with "the case for the graph has to be made on a codebase where reading everything is not an option." That measurement has now been run and **it did not make the case.** Recording it here so nobody re-runs it expecting a different answer without changing the setup.

**Setup.** A linked project (`absoluteRoot`) pointing at a 336-file, 5.2 MB copy of this repository's `src/` + `scripts/` with tests excluded. Index: `graphify .` → 2652 nodes / 6521 edges / 186 communities in 20.5s, plus `graphify cluster-only .` in 11.9s. The extract billed **$0.0146** for the 30 non-code files it found — the documented doc-pass behaviour, which the agent never pays because `scrubProcessEnv` leaves it on the free AST path. Same question in every run (trace the path from the chat HTTP route to the actual provider call, with `file:line`), swarm forced, `~deepseek/deepseek-v4-flash-latest`. Trace memory and project memory were cleared between runs — the first attempt was contaminated by `.orchestra_traces` handing run 2 run 1's finished answer.

| Run | Prompt | Skill | Wall | Cost | Prompt tok | `code_execution` | graphify queries | `file:line` cites (resolve) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | neutral | not installed | 365.4s | $0.0153 | 676k | 13 | — | 12 (12) |
| A′ | neutral | not installed | 334.8s | $0.0283 | 1211k | 18 | — | 11 (10) |
| B | neutral | installed | 326.3s | $0.0112 | 403k | 7 | **0** | 18 (14) |
| C | names the skill | installed | 225.5s | $0.0136 | 478k | 9 | **4** | 37 (37) |
| C′ | names the skill | installed | 198.3s | $0.0144 | 596k | 17 | **0** | 49 (38) |

Primary evidence on disk, project `graphify-eval`: chats `realrun-graphify-eval-9a15fde4` (A), `-541065c9` (A′), `-40f3d77e` (B), `-2c2e78d3` (C), `-bd182cd1` (C′). Two earlier runs (`-e9d1bc9b`, `-58aa89ae`) are kept but **discarded from the table**: they predate the PM #105 fix, so both answered from the wrong repository, and the second one read the first one's answer out of `.orchestra_traces`.

**The finding is about invocation, not about the graph.** With the skill installed, the index present and the binary on `PATH`, the agent queried the graph in **one run out of three**. In B it loaded the skill, ran the `--version` probe, and then explored with `find`/`grep`. In C′ the user *named the skill in the prompt* and it still never issued a query. Selection into the skill is not the problem — `load_skill` fired every time; the gap is between loading it and using it.

**No speed or quality claim survives this table.** C (4 queries) was fast with exact citations, which is what the skill promises — but C′ was **faster still with no queries at all**, so the spread is prompt- and variance-driven, not graph-driven. An earlier draft of `SKILL.md` cited "226s vs 365s" as measured evidence for the graph; the replicate refuted it and the claim was removed. n=2 per arm on a stochastic pipeline: treat every number here as a range, not a result.

**The answer text is not evidence of tool use.** Run C′ opened with *"полная трасса по графу Graphify (`graphify-out/`)"* — it attributed its answer to the graph. Its 17 `code_execution` commands contain the string `graphify` only inside the working-directory path; it never issued a single `query`/`explain`/`path`, and never even ran the `--version` probe the skill mandates. **Count the executed subcommands, never the model's account of its own method** — otherwise a self-reported "answered from the graph" scores as graph usage and the measurement above inverts.

**What the exercise actually produced** was PM #105 — `get_current_project` reported the sandbox path for a linked project, the agent obeyed it, `cd`-ed out of the repository and answered from a different codebase. Driving the real agent found a defect no test had; the value question about the graph itself remains open.

## Mitigation attempt (2026-08-18) — address invocation at the policy level, not only in the skill

The 1-in-3 finding above is an *invocation* gap: `load_skill` fires, the graph does not. The skill's own Step 3 already said "query first, not grep" and it did not move the number — because the agent has usually already defaulted to `find`/`grep` **before** it reads any skill body. So the nudge was lifted to where that decision is actually made:

- **`src/prompts/system.md` (`<code_execution_rules>`)** — a "codebase-exploration tool hierarchy" line that fires at the moment the agent is about to run `find`/`grep` to *understand* structure: check `<available_skills>` for a code-navigation skill and `load_skill` it first. Deliberately **conditional** on the skill being listed, so projects without graphify (the overwhelming majority) get no instruction referencing a skill they lack. This half is global and reaches every project immediately.
- **`bundled-skills/graphify/SKILL.md`** — a `## Decision — graphify first, grep second` table moved to the TOP (above Step 0). The old fork lived at the bottom under "When not to use this skill", i.e. after the agent had already chosen its path.

**Effect is unmeasured.** This is a prompt change against a stochastic, weak-free-model pipeline where n=2-per-arm already refuted one "measured" claim in this very document — so do not record a success number until it is re-run (arms B/C/C′) and the query-vs-no-query rate is compared honestly by *counting executed subcommands*, per the epistemics two paragraphs up.

> ⛔ **SUPERSEDED 2026-08-20 — see "The 'grep the graph first' mandate — WITHDRAWN" above.** Both bullets in this section pushed the agent *toward* `query` before grepping. That direction is reversed: the fork is now by question shape (structural → `explain`; literal → grep, correctly), and `query` requires an explicit `--budget`. The section is kept because its *diagnosis* still holds — the gap is between loading a skill and using it, and a nudge buried below the fold cannot close it — but do not re-apply its prescription. **Installed-copy drift is a known gap:** the projects that carry graphify hold older `SKILL.md` snapshots and will not pick up template changes until reinstalled — nothing keeps them in sync (`installBundledSkill` refuses when a copy already exists, so it does not re-sync either).

> **Re-checked 2026-08-20: the gap had already bitten, and it is wider than recorded.** Three projects now carry a copy, not two — binary-gated auto-install added `telegramattacker` after this note was written, and all three had drifted from the template (two shared one hash, `telegramattacker` a third). Each was still serving the withdrawn "query first, grep second" directive. All three were refreshed by hand from `bundled-skills/graphify/SKILL.md` and verified byte-identical (originals copied aside to `data/_skill-backup-<ts>/` per non-negotiable #26). **Any future edit to the template must repeat this sweep** — `for p in data/projects/*/.meta/skills/graphify/SKILL.md` — because auto-install keeps adding copies and none of them self-update. This is the argument for a re-sync path in `installBundledSkill`, or at minimum a drift test; neither exists today.

## Binary-gated auto-install (2026-08-18) — A+, the "install everywhere" the operator asked for

The measured 82%-of-budget manual-exploration turn happened on a project where graphify was *not installed at all*, so no prompt fix could have reached it. The operator's standing request was to install graphify in **every** project. Blanket-installing it unconditionally is wrong for the reason this ADR kept it opt-in — it wraps a Python CLI absent on most fresh installs, so it would list a dead skill and spend prompt tokens on machines that cannot run it. The resolution is **binary-gated**: [`skill-autoinstall.ts`](../../src/lib/storage/skill-autoinstall.ts), called best-effort from `createProject`, installs graphify into a new project **only when a `graphify` executable is discoverable on `PATH`**.

- **Detection is a `PATH` scan, not a spawn** (`fs.stat` over `PATH` entries, exec-bit checked on POSIX). Probing with `graphify --version` would add a child process to the scaffolding path and drag in the `scrubProcessEnv` obligation for a spawn `project-store` has no business making.
- **`ORCHESTRA_SKILL_AUTOINSTALL`** (feature toggle, not a security-invariant bypass, so it lives here and not in the escape-hatch registry): `auto` (default — install iff the CLI is on `PATH`), `off`, `force`. The vitest setup pins it to `off` so the suite is hermetic — otherwise `createProject` would install on a developer machine that has the CLI and not on CI, and a skill-count assertion would flake by machine.
- **Clean-boot stays green, for a concrete reason:** CI has no `graphify` binary → detection returns false → no install → `createProject` behaves exactly as before. The guarantee is preserved by the *gate*, not by opt-in-ness. Never install unconditionally.
- Best-effort and never throws: the project is fully created before the copy is attempted (after the PM #104 rollback block), so a skill-copy failure cannot undo a project. It also never clobbers an existing copy. `createProject` logs `skill_autoinstall_failed` on a genuine failure (broken/permission-denied bundled copy) — distinct from the CLI simply being absent, which is silent.
- **The copy is atomic** (hardened after a `protake` review): it lands in a unique `.graphify.installing-<pid>-<ts>` staging dir, its `SKILL.md` is verified, then it is `rename`d into place. A crash mid-copy therefore cannot leave a half-populated `graphify/` that a later run mistakes for a complete install and skips forever — the failure path removes the staging dir and leaves `target` untouched. Windows detection requires an executable extension (a bare `graphify` file is not a CLI). **Determinism:** both e2e servers pin `ORCHESTRA_SKILL_AUTOINSTALL=off` in [`playwright.config.ts`](../../playwright.config.ts) rather than relying on the runner's PATH lacking the binary. **Trust boundary:** the leaf module does not re-`assertPathInside` its `targetSkillsDir` — it trusts the one caller, which derives it from a ProjectSchema-validated id; do not call it with a user-supplied path.
- Regression: [`skill-autoinstall.test.ts`](../../src/lib/storage/skill-autoinstall.test.ts) (mode parse, `PATH` detection incl. the non-exec-file negative, off/force/auto policy, install/skip-present/skip-off branches, no staging leftover) + two `createProject` integration cases in [`project-store.test.ts`](../../src/lib/storage/project-store.test.ts) (default-off installs nothing; forced installs the skill).

## Consequences

- Graphify is unavailable to untrusted triggers. Intentional; see the escalation path in option A.
- `bundled-skills/graphify` documents a dependency on an external Python CLI that is absent on essentially every fresh install. This is **not** a zero-dependency integration and must not be described as one. The clean-boot guarantee ([`clean-boot.spec.ts`](../../tests/e2e/clean-boot.spec.ts)) is unaffected because auto-install is **binary-gated** (see the section above): a machine without the `graphify` CLI on `PATH` installs nothing, exactly as before. Installation is no longer purely opt-in — on a machine that HAS the CLI, every new project now receives it automatically — but the probe still runs before use, and the gate still means a fresh install with no CLI is untouched.
- No change to the pinned tool inventory, no new npm dependency, no change to `package.json`.

## Provenance

The tool-shaped proposal came from an external AI advisor whose surrounding advice also recommended building four things — a manual swarm toggle, a classifier router, a streaming agent-activity console, and per-request cost accounting — **all four of which already exist** (`swarm-config.tsx`, `moa-router.ts`, `swarm-terminal.tsx` + `swarm-dag.tsx`, `src/lib/cost/` + `budget-banner.tsx`). Treat unsourced architectural advice about this repo as a hypothesis to check against `graphify query` and the source, not as a finding.

This record was reviewed by a three-model council (GLM 5.2, GPT-5.6 Luna Pro, Kimi K3) via `protake`. Unanimous on: the epistemic limit above, deferring MCP, and that the decision record is worth more than the feature. Three of the council's own specific claims were checked against this codebase and **did not survive** — an asserted missing output cap (already handled by `output-truncate.ts`), an asserted silent wrong-index fallback (the binary exits 1), and an asserted pure-denylist command guard (it uses explicit prefix allowlists). Cross-model review fabricates specifics; verify each one before acting on it.
