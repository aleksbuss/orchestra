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

The skill is opt-in per project (`installBundledSkill`), so it costs zero prompt tokens and zero risk until an operator installs it into a project.

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

## Trust markers inside the graph

AST-derived edges print `[EXTRACTED]`. Nodes produced by the semantic (doc) pass carry `verification: "unverified"` — graphify flags them itself when it cannot find evidence in the source. On the `bughunt` index: 64 nodes unmarked (AST), 1 `unverified` (`pnpm_workspace_packages`, from the LLM doc pass). Treat `[EXTRACTED]` as structural fact and `unverified` as a hint that may be hallucinated.

## Failure modes verified against the real binary

- **Missing index fails loudly, and does not walk up the tree.** In a directory with no index: `error: graph file not found: <cwd>/graphify-out/graph.json`, **exit code 1**. So an agent in a project without an index gets a hard, detectable failure — it does not silently answer from some other repo's graph.
- **Residual hazard:** if a shell command `cd`s out of the project into a directory that *does* have an index, the answers describe the wrong repo. `resolveContextCwd` pins the starting cwd to the project, but a shell command can leave it. The skill forbids this explicitly.
- **tree-sitter can fail on half-written code** the agent just produced. A failed `update` must be treated as "no fresh graph", not as "nothing changed".

## End-to-end verification (2026-08-15, `scripts/run-real-task.ts`, project `bughunt`, `openrouter/~deepseek/deepseek-v4-flash-latest`, swarm forced)

Two real agent turns, same project, same question. **Primary evidence is on disk** — chats `realrun-bughunt-688c1369` (Run A) and `realrun-bughunt-42c9e7d4` (Run B); reconstruct either with `/api/_debug/chat/<id>` (see [`observability-runbook.md`](./observability-runbook.md)). The `bughunt` project keeps its `graphify-out/` index and its installed copy of the skill, so both runs are re-runnable.

**Run A — neutral prompt, skill installed but not named.** The agent did **not** load the skill: `{"read_text_file": 11}`, zero `load_skill`, zero `code_execution`; 98.1s. The `<available_skills>` block WAS in the prompt with the full description, so this is a selection decision, not a delivery failure — and it was the **right** decision: on a 16-file project, reading beats indexing, which is what this skill's own "when not to use" section says. It produced a fully correct answer naming `X-Telegram-Init-Data`, `verifyInitData`, the HMAC-SHA256 + 24h freshness check and the D1 upsert.

**Run B — skill named in the prompt.** `{"load_skill": 1, "code_execution": 12, "read_text_file": 5}`; 174.8s. The agent executed the skill as written: probe (`graphify --version` → `0.9.28`), identifier queries (`query "auth"` → 8 nodes, `query "ApiClient"` → 15 nodes), `explain "authMiddleware"`, then `path "ApiClient" "authMiddleware"`.

**It hit the trap and did not fall in.** Verbatim from the answer:

> There is **no static call path** between the client and the auth check — `graphify path "ApiClient" "authMiddleware"` returns *"No path found"*. The connection is **dynamic, over HTTP** … The graph's static edges stop at the process boundary; the coupling lives in one string literal (`X-Telegram-Init-Data`) shared across the wire.

The strings "not connected" and "unconnected" do not appear. It cited `[EXTRACTED]` as its trust marker, and read 5 files instead of 11 — "only the exact lines the graph pointed me to". **The epistemic rule survives contact with a cheap model under the exact failure it was written for.**

**The honest cost line:** on this project the skill was **1.8× slower** (174.8s vs 98.1s) and spent 12 subprocess calls to reach an answer the baseline already had. Run B's answer is *better reasoned* about static-vs-dynamic coupling; it is not *more correct*. Nothing here demonstrates value at 16 files — the case for the graph has to be made on a codebase where reading everything is not an option, and that has not been measured.

## Consequences

- Graphify is unavailable to untrusted triggers. Intentional; see the escalation path in option A.
- `bundled-skills/graphify` documents a dependency on an external Python CLI that is absent on essentially every fresh install. This is **not** a zero-dependency integration and must not be described as one. The clean-boot guarantee ([`clean-boot.spec.ts`](../../tests/e2e/clean-boot.spec.ts)) is unaffected because the skill is opt-in per project and probes for the binary before use.
- No change to the pinned tool inventory, no new npm dependency, no change to `package.json`.

## Provenance

The tool-shaped proposal came from an external AI advisor whose surrounding advice also recommended building four things — a manual swarm toggle, a classifier router, a streaming agent-activity console, and per-request cost accounting — **all four of which already exist** (`swarm-config.tsx`, `moa-router.ts`, `swarm-terminal.tsx` + `swarm-dag.tsx`, `src/lib/cost/` + `budget-banner.tsx`). Treat unsourced architectural advice about this repo as a hypothesis to check against `graphify query` and the source, not as a finding.

This record was reviewed by a three-model council (GLM 5.2, GPT-5.6 Luna Pro, Kimi K3) via `protake`. Unanimous on: the epistemic limit above, deferring MCP, and that the decision record is worth more than the feature. Three of the council's own specific claims were checked against this codebase and **did not survive** — an asserted missing output cap (already handled by `output-truncate.ts`), an asserted silent wrong-index fallback (the binary exits 1), and an asserted pure-denylist command guard (it uses explicit prefix allowlists). Cross-model review fabricates specifics; verify each one before acting on it.
