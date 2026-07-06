# Orchestra Subagent Swarm — Full Architecture Report

**Written 2026-07-06.** How the Mixture-of-Agents (MoA) swarm of subagents actually works, traced against the live source (`moa.ts`, `moa-router.ts`, `moa-personas.ts`, `moa-proposer-tools.ts`, `disagreement.ts`, `tournament-aggregator.ts`, `reflection.ts`, and the swarm integration in `agent.ts`). The conclusions section was cross-checked by a second model (DoubleTake / gemini-2.5-pro) — see the last section.

> One-paragraph version: when you turn Swarm ON, every turn goes through the MoA pipeline. A cheap **Router** model looks at your prompt and either bypasses the swarm (trivial prompt) or invents **3–7 hyper-specialised expert personas** on the fly, one of which is ALWAYS forced to be a Skeptic. Those personas run as **parallel proposers**, each a bounded single-shot agent. Their drafts are filtered, checked for **disagreement** (via embeddings), and — by default — handed straight into the **final answer stream** so your brain model synthesises them inline (one generation, not two). Optionally a **reflection loop** (Deep Audit) has a Skeptic critique the answer and a revisor fix it. Every stage is cost-tracked, abort-aware, and loop-guarded.

---

## 1. Activation — one switch, one internal optimiser

The **only** thing that turns the swarm on is the UI toggle `swarmEnabled` (per-request, threaded `/api/chat` → `runAgent`). There is no hidden regex gate on the entry path (an earlier `queryNeedsMoA` regex was removed — PM #9 — because it silently overrode user intent).

Inside the swarm, a second decision exists but it is an *optimisation, not a gate*: the **Router** may decide `requiresSwarm: false` for a trivial prompt ("thanks", "hi", a one-line edit) and skip the fan-out. If you want to force the full fan-out regardless, the **Force Swarm** toggle (`forceSwarm`) overrides the Router. So:

| You set | Router says | Result |
|---|---|---|
| Swarm OFF | — | single agent, no MoA code runs at all |
| Swarm ON | `requiresSwarm: true` | full fan-out (3–7 proposers) |
| Swarm ON | `requiresSwarm: false` | **bypass** — single-agent stream answers directly |
| Swarm ON + Force | (ignored) | full fan-out always |

**Critical property:** the swarm's output is **never the terminal answer**. `runAgent` ALWAYS runs a final tool-capable `streamText` after the swarm. The swarm produces *advisory context* (drafts / a consensus / a handoff) that gets injected into that final stream's system prompt. This is why on disk a swarm turn can look identical to a plain single-agent turn — the proposers and aggregator are SSE-only internals, not chat messages.

---

## 2. The pipeline, stage by stage

```
your message
   │
   ▼
[Router / DPG]  utilityModel · generateObject
   │  requiresSwarm? ──no(+ not forced)──▶ BYPASS ──▶ final stream answers directly
   │  yes
   ▼
3–7 personas (one FORCED Skeptic)
   │
   ▼
[Fan-out] proposers run in PARALLEL (semaphore-bounded)
   │   each: bounded single agent, tier-resolved model, role-based tools
   ▼
drafts ──▶ filter (isSuccessfulDraft) ──▶ 0? fallback · 1? use it · ≥2? continue
   │
   ▼
[Disagreement check]  embed drafts · pairwise cosine · marker if divergent
   │
   ▼
[Fan-in]  one of:
   • INLINE-SYNTHESIS COLLAPSE (default) ─▶ hand drafts to the final stream
   • standalone synthesis aggregator (brain generateText)
   • tournament (K judges Borda-rank, verbatim winner)
   │
   ▼
[Reflection loop]  (Deep Audit only) Skeptic critiques → brain revises → repeat
   │
   ▼
[Final stream]  streamText — synthesises, can call tools, streams to you
   │
   ▼
[Trace memory]  capture a successful run as a few-shot for future Routers
```

### 2.1 Router / Dynamic Persona Generation (DPG) — `moa-router.ts`

Driver model: **`utilityModel`** (a cheap "utility" model, deliberately not your brain). It runs one `generateObject` call with a Zod schema that forces:
- `requiresSwarm: boolean` — the bypass decision;
- `personas: [3 … maxSwarmSize]` — each with `id`, `role`, a structured `[GOAL]/[RULES]/[FORMAT]` system prompt, a UI colour, and an optional `modelTier` hint.

`maxSwarmSize` is your `settings.maxSwarmSize` clamped to **[3, 7]** (the clamp is mandatory — a value < 3 would make the Zod `.min(3).max(n)` invalid and crash the Router every turn).

Three hardening layers around the LLM:
1. **Forced Skeptic (PM #37).** After generation, if no persona is classified as a `reviewer` (via `detectProposerRole`), the canonical Adversarial Critic is force-injected (evicting the weakest tail persona if already at the cap). CLAUDE.md's "one role is ALWAYS a QA Auditor / Skeptic" is enforced in code, not just prompt-hoped. **Edge case (found by the DoubleTake pass):** the injection is gated on `object.requiresSwarm`. So in the ONE corner where `forceSwarm` is on AND the Router returned `requiresSwarm: false`, the bypass is skipped (Force wins) but the personas run **without the guaranteed Skeptic** — the LLM's raw 3–5 personas may not include one. Narrow (needs Force + a Router that judged the prompt trivial), but a real gap: the skeptic guarantee holds for the normal `requiresSwarm: true` path, not the forced-over-a-bypass path. Candidate one-line hardening: force-inject the skeptic whenever the swarm will actually fan out, not only when `requiresSwarm`.
2. **Fail-safe fallback.** ANY Router failure (auth, 404, timeout, schema-parse, other — classified by `classifyRouterError`) falls back to the 5 static personas in `MOA_PROPOSERS` with `requiresSwarm: true`, and emits a `moa_router_fallback` warn naming the model + reason. It never throws.
3. **Observability (PM #89/#90).** A success line names the resolving model + persona count + the bypass decision. This exists because a degraded `utilityModel` (e.g. an OpenRouter free/meta pseudo-id) silently produced junk personas for a long time with nothing pointing at the cause.

**Operator note:** the Router is the single most `utilityModel`-sensitive component. A weak utility model mis-classifies substantive prompts as trivial (surprising direct answers under Swarm-ON) or schema-fails `generateObject` → the fallback fires and you always get the static 5 personas. Point `utilityModel` at a competent model.

### 2.2 Fan-out — the proposers (`moa.ts`)

Each persona becomes a **proposer**: a bounded, single-purpose agent. Key mechanics:

- **Parallel, semaphore-bounded.** All proposers launch together but pass through `agentSemaphore` (2 permits on this box), so 2 run in flight and the rest queue. A small staggered start (250 ms × index + jitter, PM #66) breaks the thundering-herd 429 burst on rate-limited tiers.
- **Per-proposer model (PM #48 tiers).** `resolveProposerModelConfig` maps each persona to a model: the Router's `modelTier` hint, or a role-derived tier (reviewer→fast, researcher/tool→balanced, coder→frontier), looked up in `settings.proposerTiers.{fast,balanced,frontier}`. If you configured no tiers, every proposer uses the default `workerConfig`. **Reviewer floor:** a would-be `fast` reviewer is bumped to `balanced` (the anti-sycophancy audit shouldn't run on the cheapest model), UNLESS an explicit operator control (`swarmSandbox.reviewer` / `skepticTier`) or a stronger persona `modelTier` already set it. The **reviewer/Skeptic proposer** is special — see §3. NB: if a resolved tier has no configured model, `resolveProposerModelConfig` **silently** returns `workerConfig` (this is model *resolution*, distinct from the LOUD runtime failover in §2.2).
- **Role-based tools (PM #42/#50/#77).** Reviewer + researcher personas get `search_web` (with a Fact-Check Mandate appended to their prompt) when search is usable; coders get `code_execution` only if `codeExecution.proposerAccess` is opted in. Tool-less proposers are explicitly TOLD they're tool-less (`PROPOSER_NO_TOOLS_DIRECTIVE`) so a tool-demanding prompt doesn't make them return an empty draft. Whatever tools they get are wrapped by `applyGlobalToolLoopGuard` (§5).
- **Bounded.** 2-minute per-proposer timeout (`AbortSignal.any([caller, timeout])`); output capped (PM #66 ceiling: `min(configured, 4096)`, default 2048 — proposers are N-way parallel intermediates, so an uncapped ceiling risks an N× cost blow-up); tool proposers get up to 3 steps (`stopWhen: stepCountIs(3)`), tool-less get 1 (PM #65 — omitting `stopWhen` silently caps at step 1 and returns empty text); an in-flight **token governor** prunes the payload between steps.
- **Fault-isolated.** A proposer that throws does NOT reject the batch — it returns an `[Error: …]` draft that the filter drops. Throwing would collapse the whole ensemble to a single agent, discarding every good draft. The **Skeptic proposer specifically** gets a LOUD failover to `workerConfig` (a failed critic is worse than a slow one), and if even that fails it's dropped like any other.

### 2.3 Draft filtering and the 0/1/N branches

`isSuccessfulDraft` drops empties and `[Error: …]` drafts. Then:
- **0 successful** → return a "all proposers failed, check config" message.
- **1 successful** → use it verbatim, skip aggregation.
- **≥2 successful** → continue to disagreement + fan-in.

This is why flaky free-tier proposers degrade gracefully: the ensemble runs on whatever survived, as long as ≥1 did (≥2 for the collapse path).

### 2.4 Disagreement detection (PM #39) — `disagreement.ts`

The ≥2 surviving drafts are embedded (via `embeddingsModel`) and pairwise cosine **distance** is computed. If the max distance exceeds the threshold (default 0.35), a `<<DISAGREEMENT_DETECTED>>` marker is prepended to the synthesis input, instructing the synthesiser to **surface the conflict rather than smooth it away**. Non-fatal: an embedding failure (no key, etc.) just skips the check. This is the mechanism behind the swarm's edge on fact-sensitive prompts — a divergent Skeptic draft raises the distance and forces the conflict into the open.

### 2.5 Fan-in — three aggregation paths

**(a) Inline-synthesis collapse — the DEFAULT (Sprint 2c, `docs/moa-aggregator-collapse.md`).** Gated narrowly: `aggregator.inlineSynthesis === true` (shipped on in `DEFAULT_SETTINGS`) AND `mode === "synthesis"` AND reflection OFF AND ≥2 drafts. Instead of a separate aggregator generation, the ensemble hands the drafts UP (`synthesisHandoff`); `agent.ts` injects the ported synthesis directive + the drafts + the disagreement marker into the **final stream's SYSTEM prompt** (never a second user turn — consecutive user messages crash strict models like Gemma). The final stream then synthesises inline: **one brain generation instead of two**, and it can call tools mid-synthesis. Backed by the N=8 A/B: quality held, latency −31%, tokens −16%.

**(b) Standalone synthesis aggregator.** When collapse is off (or reflection is on), the **brain model** runs a dedicated `generateText` with the `AGGREGATOR_SYSTEM_PROMPT` (Together-AI MoA template, adapted): preserve technical detail + code, no meta-commentary, resolve conflicts using its own knowledge, honour the disagreement marker, correct draft errors silently. Temperature 0.3.

**(c) Tournament (PM #52).** When `mode === "tournament"`, K judges rank the drafts, Borda count picks a winner, and the **winning draft is returned verbatim** (no synthesis). Reflection is skipped (re-judging what was just judged). If every judge fails, it falls back to the synthesis aggregator.

### 2.6 Reflection loop — "Deep Audit" (PM #38/#46, `reflection.ts`)

OFF by default globally; enabled per-request via the **Deep Audit** toggle (`deepAudit`) or `settings.reflection.enabled`. When on (which also disables the collapse, since reflection needs a complete answer to critique), it's a **generator–critic–revisor loop**:
- **Critic = the Skeptic model** (`reflectOnResponse`, `modelOverride: skepticConfig ?? brainConfig`) — Doubt-Driven `CLAIM → EXTRACT → DOUBT`, emits `{shouldRevise, critique, suggestion}` as a trailing JSON verdict (parsed by the last-balanced-object scanner so reasoning braces don't confuse it).
- **Revisor = the brain** (`reviseWithCritique`) — the judge audits, but only the brain writes. Can return `cannot_fix` if the critique is wrong/impossible.
- **Stops when:** critic says clean, OR revisor says `cannot_fix`, OR successive revisions converge (cosine ≥ `settings.reflection.convergenceThreshold`, **default 0.97, configurable**), OR a hard cap of 3 rounds (`ABSOLUTE_MAX_REFLECTION_ROUNDS`, clamps a too-high operator setting). The convergence embed is skipped entirely when `maxRounds === 1` (no oscillation possible — saves the embed cost).

### 2.7 Final stream + trace memory

The final `streamText` always runs, with the swarm's output injected as system-prompt context, full tools, RAG memory, and streaming to your UI. On success, a **trace** (prompt + final answer + signals: proposer success ratio, disagreement, reflection rounds, latency, aggregator mode) is captured into the trace pool (global or per-project) and later retrieved as **few-shots to bias future Routers** toward proven persona patterns.

---

## 3. "The Skeptic" — one knob, two surfaces

There are **two** places a skeptic judgment runs: the **reviewer proposer** in the fan-out, and the **reflection critic** in Deep Audit. The **direct Skeptic model** for both comes from one function, `resolveSkepticModelConfig(settings, perRequestOverride?)`, which resolves ONLY the top two precedence levels: **per-request panel override > `settings.proposerTiers.skeptic`** (else `undefined`). That result is then consumed two ways:
- the **reflection critic** uses it directly (`skepticConfig ?? brainConfig`);
- the **reviewer proposer** passes it into `resolveProposerModelConfig`, where it wins outright if set, and otherwise the rest of the chain resolves: `skepticTier` / `swarmSandbox.reviewer` / persona `modelTier` / role-derived (with the `fast → balanced` reviewer floor).

So the **full** reviewer precedence is: per-request override > `proposerTiers.skeptic` > `swarmSandbox.reviewer` > `skepticTier` > persona `modelTier` > derived. The direct-model knob (top two levels, the single source) beats every role→tier knob.

**Security shape:** a per-request override is `Pick<ModelConfig, "provider"|"model">` ONLY. The `/api/chat` route 400s a smuggled `apiKey` (key-injection) or `baseUrl` (SSRF — `createModel` doesn't run `assertSafeOutboundUrl`) or an unknown provider, via `isValidSkepticOverride`. Keys resolve server-side (`resolveWorkerKey`). Threaded through every dispatch path (interactive, background, queue persistence, daemon continuation) and Privacy-Mode-guarded.

**Family-overlap advisory (PM Sprint 8, corrected).** If the Skeptic ends up in the same model *family* as the workers/brain (in-breeding → sycophancy risk), a once-per-process warning fires — but nothing is auto-switched. The forced "make the skeptic a third vendor" design was rejected (breaks single-provider and all-local Privacy setups, and silently overrides operator choice). It is advisory only.

**Fallbacks are LOUD.** The Sprint-6 reviewer failover and the reflection API-retry keep the swarm alive if the Skeptic model fails, but they warn naming both models — they never silently substitute the operator's chosen Skeptic.

---

## 4. Who runs which model

| Role | Model source | Runs |
|---|---|---|
| **Router / DPG** | `utilityModel` | 1× `generateObject` per turn |
| **Proposers** | `proposerTiers[tier]` or `workerConfig` (per persona) | N parallel `generateText` |
| **Skeptic proposer** | `resolveSkepticModelConfig` (override > `proposerTiers.skeptic` > tier) | 1 of the N |
| **Disagreement / convergence** | `embeddingsModel` | embed calls |
| **Aggregator / synthesiser** | `chatModel` (brain) | 1× (or inline in the final stream) |
| **Reflection critic** | Skeptic model (else brain) | Deep Audit only |
| **Reflection revisor** | `chatModel` (brain) | Deep Audit only |
| **Final stream** | `chatModel` (brain) | always, 1× |
| **Tournament judges** | `aggregator.tournamentJudgeModel` or brain | tournament mode only |

---

## 5. Cross-cutting guarantees

- **Cost.** Every LLM call folds its usage into `moaUsage`, attributed to the *resolved* provider/model (tiers can hit 3 providers in one turn), and bubbles up to the per-chat budget banner. A hard `costGuard.maxUsdPerChat` cap can 402 a turn before it starts.
- **Abort.** `abortSignal` (your `req.signal`) threads into every `generateText`/`generateObject`/`embed` — closing the tab cancels the whole swarm (PM #1/#23).
- **Loop guard.** Every proposer ToolSet (and the main agent's) goes through `applyGlobalToolLoopGuard`: tools return `{success:false}` instead of throwing (self-heal, don't kill the run), identical `(tool+args)` calls are blocked after repeats, per-tool output is capped.
- **Token governor.** Between tool steps, `createTokenGovernor` prunes the payload to the model's *reliable* window (`effectiveContextWindow`, capped at 120K even if a provider advertises 1M) so accreting tool results can't overflow.

---

## 6. What is NOT persisted (durable gotchas)

- `swarmEnabled` is a per-**request** param, NOT saved to `data/chats/*.json`. You cannot infer swarm on/off from a chat file.
- Swarm internals (proposers, aggregator, DAG nodes) are `runMoAEnsemble`-internal + SSE-only. With inline-synthesis collapse ON (default), a swarm turn looks like a plain single-agent tool loop on disk.
- **To see what the swarm did, read server STDOUT** (`[MoA]` lines), not the chat JSON. `data/logs/` is empty in dev — all `[MoA]` output is terminal-only.

---

## 7. Empirical grounding (measured this project)

Two A/B studies validate the design (details in `docs/moa-value-ab.md` and `docs/moa-heterogeneous-ensemble.md`):

- **Homogeneous** (one model everywhere): swarm won 8/12 blind pairwise vs a single agent, 0 losses — all wins on contentious/multi-faceted/fact-sensitive prompts, both trivial controls tied. Price 1.9× cost, 3.1× latency.
- **Heterogeneous** (gpt-4o brain / free proposers / Sonnet cross-family Skeptic): swarm won **10/12** — BEATING the homogeneous run. The premium cross-family Skeptic strengthened the ensemble, exactly as the operator-owned-Skeptic knob intends. Free-tier proposers flaked (≈2.5/4 succeeded) but the ensemble degraded gracefully and still won.

Both confirm the core thesis: **the swarm earns its cost on hard prompts and is pure overhead on trivial ones — which is precisely why the Router bypass exists.**

---

## 8. Failure modes & degradation ladder

| Failure | Behaviour |
|---|---|
| Router LLM fails | fall back to 5 static personas, `requiresSwarm: true`, warn |
| Weak `utilityModel` | mis-routes bypass / schema-fails → static personas |
| A proposer throws/times out | dropped; ensemble runs on survivors |
| Skeptic proposer fails | LOUD failover to worker model, else dropped |
| 0 drafts survive | "all proposers failed" message |
| 1 draft survives | used verbatim, no aggregation |
| Embedding unavailable | disagreement check skipped silently |
| Tournament judges all fail | fall back to synthesis aggregator |
| Reflection critic mis-fires | `cannot_fix` / convergence / 3-round cap bounds it |

The swarm is engineered to **degrade, never crash** — every stage has a safe fallback, and the final single-agent stream is the ultimate backstop.

---

## 9. Cross-model verification (DoubleTake)

The conclusions above were re-checked by a second model (gemini-2.5-pro via DoubleTake) against the verbatim inlined source of `moa.ts` / `moa-personas.ts` / `moa-router.ts`. It was asked to flag only claims that were wrong/imprecise. Each finding was then re-verified against the real source (not the prompt) before folding in — the corrections above (§2.1 edge case, §2.2 reviewer floor, §2.6 convergence, §3 resolution split) all came from this pass.

**Confirmed and folded in:**
- **Forced-Skeptic edge case (strongest catch).** The skeptic force-injection is gated on `object.requiresSwarm`, so `forceSwarm` over a Router `requiresSwarm: false` runs personas without the guaranteed Skeptic. Verified real; documented in §2.1 with a candidate one-line fix. This is a genuine (narrow) CODE gap, not just a doc gap — flagged to the operator as optional hardening.
- **Convergence is configurable + skipped at 1 round** (§2.6) — my "cosine ≥ 0.97" was imprecise.
- **`resolveSkepticModelConfig` scope** (§3) — it resolves only the top two precedence levels; the rest lives in `resolveProposerModelConfig`. My "one function" framing was too broad.
- **Reviewer tier floor** (`fast → balanced`) — I'd omitted it entirely (§2.2).

**Reviewed and NOT changed (DoubleTake misfire):**
- It flagged claim #7 ("LOUD Skeptic failover") as wrong, pointing at `resolveProposerModelConfig`'s *silent* fallback. That is a DIFFERENT code path — model *resolution* (before running), correctly silent. My claim was about the **runtime** failover in `moa.ts` (a proposer that throws), which IS loud (`console.warn("[MoA] Skeptic failover: …")`). The claim stands; I added the resolution-vs-runtime distinction to §2.2 so the two aren't conflated.
- Two of its "missed behaviours" (the model-family sycophancy advisory, the classified router telemetry) were already in §3 and §2.1 respectively.

Net: the cross-model pass caught one real code gap and three doc imprecisions, and one of its five findings was a misfire — a useful, honest result. The doc above reflects the corrections.
