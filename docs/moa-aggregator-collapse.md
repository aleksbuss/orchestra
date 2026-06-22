# Sprint 2 — Collapse the MoA aggregator into the final tool-capable stream

**Status:** **2a + 2b SHIPPED** on `feat/moa-bypass-no-double-gen` (behind `settings.aggregator.inlineSynthesis`, **default OFF** — zero production change yet). Sprint 1 already removed the bypass path's vestigial generation. **2c MEASUREMENT DONE (2026-06-22)** — quality held; latency −31%, completion tokens −16%, cost −3.8% over N=8 (see §10). **Remaining: the FLIP only** — set `inlineSynthesis` default ON + update gate test / README mermaid / this doc (and tournament collapse, deferred).

**Decisions (resolved with the operator, 2026-06-21):** flag default **OFF → measure → flip in 2c**; synthesis directive lives in **`src/prompts/synthesis-inline.md`** (operator-tunable, `loadSynthesisInlineDirective()` falls back to `DEFAULT_SYNTHESIS_INLINE_DIRECTIVE`); tournament collapse **deferred** to a later micro-sprint.

**Landed surface:** `aggregator.inlineSynthesis` (`types.ts`); `MoAResult.synthesisHandoff` + the collapse gate + `buildInlineSynthesisInjection` (`moa.ts`); `loadSynthesisInlineDirective` / `DEFAULT_SYNTHESIS_INLINE_DIRECTIVE` + `synthesis-inline.md` (`prompts.ts`); the 3-way injection branch + relocated `onFinish` trace capture (`agent.ts`). Tests in `moa.test.ts` (builder + collapse gate) and `prompts.test.ts` (directive load/fallback).

---

## 1. Problem

The MoA ensemble's output is **never terminal**: `runAgent` always runs a final tool-capable `streamText` after `runMoAEnsemble` returns and re-answers. On the **swarm path** this means **two brain-model generations per turn**:

```
proposers → aggregator (generateText, brain, AGGREGATOR_SYSTEM_PROMPT, NO tools) → text
          → agent.ts injects text as "## Expert Consensus"
          → final streamText (brain, full system prompt, tools, streaming) → answer   ← 2nd brain gen
```

The aggregator's synthesis is computed, demoted to "reference context," and then **re-synthesized from scratch** by the final stream. For a synthesis task that needs no tools (the common MoA case) the second generation is almost pure waste.

## 2. Target

**One brain generation.** Delete the separate aggregator call. The final `streamText` — which already runs, already has tools + streaming + the full system prompt + RAG memory — *becomes* the synthesizer:

```
proposers → drafts (+ disagreement marker)
          → agent.ts injects "## Expert Drafts to Synthesize" + synthesis directive + marker
          → final streamText synthesizes AND may call tools AND streams → answer   ← ONE brain gen
```

**Bonus capability:** the collapsed synthesizer can call tools *during* synthesis (verify a claim, run code) — the standalone aggregator never could.

## 3. Scope decision (the important one)

**Collapse ONLY the default synthesis path** — `aggregatorMode === "synthesis"` AND `reflection.disabled`. Leave **reflection-enabled** and **tournament** paths on their current two-pass behavior.

Rationale:
- **Reflection** (generator→critic→revisor) is *inherently multi-pass*: it needs a complete answer to critique, then rewrites it. That is fundamentally incompatible with single-pass streaming (you'd be revising tokens the user already saw). It is **opt-in** — those operators chose extra passes. Forcing it into the collapse is the wrong fight.
- **Tournament** returns a *specific winning draft verbatim* (no synthesis). Delivering pre-existing exact text through the UI stream is a different mechanism ("echo a fixed string as a stream") and reintroduces re-audit defect #4. Out of scope for Sprint 2; can be a later micro-sprint.
- The **default config** (synthesis, no reflection) is the **majority of swarm turns**, so collapsing just it captures most of the win with the smallest blast radius.

| Path | Today | After Sprint 2 |
| --- | --- | --- |
| Bypass (`requiresSwarm:false`) | single stream (Sprint 1 ✅) | unchanged |
| **Synthesis, reflection OFF** | aggregator + stream (2 gens) | **stream-synthesizes (1 gen)** |
| Synthesis, reflection ON | aggregator + reflection + stream | unchanged (2-pass, opt-in) |
| Tournament | judges + winner + stream | unchanged (later micro-sprint) |

## 4. Contract changes

### `MoAResult`
Add fields so `runMoAEnsemble` can hand the raw material UP instead of a finished synthesis:
```ts
interface MoAResult {
  // ... existing ...
  /** When set, runAgent's final stream must synthesize these (collapsed path). */
  synthesisHandoff?: {
    drafts: { proposerId: string; role: string; text: string }[];
    disagreementMarker: string;   // PM #39 — "" when consensus
    signals: TraceSignals;         // for the relocated trace capture
  };
}
```
`text` stays populated for the unchanged paths (reflection, tournament, single-draft, all-failed).

### `runMoAEnsemble`
After drafts + disagreement detection, branch:
- **collapsed** (`mode==="synthesis" && !reflection.enabled && successfulDrafts.length >= 2`): SKIP the aggregator `generateText`; return `{ synthesisHandoff: { drafts, marker, signals }, cumulativeUsage }`.
- **all other cases**: unchanged (aggregator runs, reflection runs, tournament runs, trace captured inside MoA).

### `agent.ts`
Replace the Sprint-1 "Expert Consensus" injection with a branch:
- `moaResult.synthesisHandoff` present → inject **`## Expert Drafts to Synthesize`** (the drafts) + the **synthesis directive** (key rules ported from `AGGREGATOR_SYSTEM_PROMPT`) + the disagreement marker into `systemPrompt`. The existing final `streamText` does the rest. Capture the trace in `onFinish` using `synthesisHandoff.signals` + the streamed final text.
- `moaResult.text` present (unchanged paths) → inject as today's "Expert Consensus" reference.
- `moaResult.bypassed` → no injection (Sprint 1).

**Drafts go in the SYSTEM prompt, not a second user message** — a consecutive `user` turn crashes strict models (PM #2). This mirrors the existing injection, so message-role hygiene is unchanged.

## 5. Subsystem handling

| Subsystem | Concern | Resolution |
| --- | --- | --- |
| **Reflection** | Needs a complete answer to critique | Collapse is gated OFF when reflection is enabled — its path is untouched |
| **Tournament** | Returns verbatim winner, no synthesis | Out of scope (gated by `mode==="synthesis"`); unchanged |
| **Trace-memory** | Captures final synthesized text | Moves to `onFinish` for the collapsed path (signals plumbed up via `synthesisHandoff`); stays in MoA for unchanged paths |
| **Disagreement marker** | Computed in MoA | Passed up in `synthesisHandoff.disagreementMarker`, prepended to the synthesis directive |
| **Persistence / PM #61 unwrap** | Must route through the chokepoint | **Inherited free** — the collapsed path uses the EXISTING `streamText` + `onFinish`, no new persistence path |
| **Budget banner (PM #36)** | Aggregator tokens were counted | Removed call = fewer tokens; the final stream's tokens are already counted by `onStepFinish`/`onFinish`. Net: lower + still accurate |
| **AbortSignal / loop-guard / token-governor** | Contracts | Final `streamText` already has all three; nothing new |

## 6. Risks & mitigations

- **R1 — synthesis quality shift (main risk).** Today the aggregator runs a dedicated, benchmarked prompt (`AGGREGATOR_SYSTEM_PROMPT`, PM #40). Collapsed, synthesis happens under the *main orchestrator* system prompt + a synthesis directive. The orchestrator framing ("you have tools, call `response`") could dilute synthesis focus.
  **Mitigation:** port the load-bearing synthesis rules from `AGGREGATOR_SYSTEM_PROMPT` verbatim into the injected directive; measure via trace-memory quality scores (already computed per run) before/after; ship behind a flag.
- **R2 — regression for power users.** Mitigated by scope: reflection/tournament untouched.
- **R3 — silent behavior change.** Put the collapse behind **`settings.aggregator.inlineSynthesis` (default… TBD — see open questions)** so it's revertible and A/B-able.

## 7. Edge cases

- `successfulDrafts.length === 0` → unchanged (existing "all failed" return).
- `successfulDrafts.length === 1` → unchanged (existing "skip aggregation, return the single draft"). No synthesis needed.
- MoA throws → unchanged (agent.ts catch → single-agent stream).
- Collapsed synthesis stream itself errors → existing `streamText` `onError` + model-fallback (PM #17) already covers it.

## 8. Sub-sprints

- **2a — plumbing (no behavior change):** add `synthesisHandoff` to `MoAResult`; extract `TraceSignals` assembly so it can be returned without capturing; add the inline-synthesis directive constant (ported from `AGGREGATOR_SYSTEM_PROMPT`). Tests compile, full suite green, behavior identical.
- **2b — the collapse (behind flag, default OFF):** MoA returns `synthesisHandoff` on the collapsed path; agent.ts injects drafts + directive; trace capture relocates to `onFinish`. Flag default OFF → zero production change until flipped.
- **2c — measure + default ON:** run real swarm chats both ways, compare trace quality scores + token counts (the Sprint 1 per-turn log already exposes the 2-gen baseline); if quality holds, flip the flag default ON and update README's "MoA pipeline" + the mermaid diagram (doc-freshness §7).

Two PRs minimum (2a, then 2b+2c), per the §10 "re-exporter first" decomposition rule.

## 9. Open questions — RESOLVED (2026-06-21)

1. **Flag default.** ✅ **OFF → measure → flip in 2c.** `inlineSynthesis` ships opt-in; 2c flips the default after the trace-quality comparison.
2. **Synthesis directive home.** ✅ **`src/prompts/synthesis-inline.md`** (operator-tunable). `loadSynthesisInlineDirective()` reads it and falls back to `DEFAULT_SYNTHESIS_INLINE_DIRECTIVE` when absent.
3. **Tournament collapse.** ✅ **Deferred.** The gate is `aggregatorMode === "synthesis"`; tournament keeps its verbatim-winner delivery. Revisit as the "stream a fixed string" micro-sprint.

## 10. 2c checklist

**Measurement DONE (2026-06-22)** — live A/B, deepseek-v3 orchestrator + proposers over OpenRouter, N=3 then N=8 diverse prompts (REST / locking / OOP / iterative-Fibonacci code / DB-index / HTTP1.1-vs-2 / microservices-vs-monolith / CAP):

- [x] Ran swarm chats ON and OFF. Collapse fired **8/8** on ON (log: "Inline-synthesis collapse: handing N drafts → 1 brain generation"); aggregator ran **8/8** on OFF (log: "Starting aggregation").
- [x] Quality **HOLDS** — ON answers equivalent or marginally better across all prompts (incl. code/long-form/contentious; e.g. the collapsed code answer added a docstring + input validation). Trace-memory quality scores were a non-discriminator (signal-derived → 1.000 on both ON and OFF because proposers converged); quality was judged on the answers themselves.
- [x] Token / cost / latency (N=8): **latency −31%** (40.6s→27.8s avg, every prompt faster — removing the serial aggregator step is the real win); **completion tokens −16%** (the aggregator generation removed); **cost only −3.8%** and **prompt tokens −1.1%** (the final stream's large system prompt dominates and is shared by both paths). Earlier live runs also confirmed the collapsed synthesizer can call tools mid-synthesis (deepseek called `code_execution`).

**Remaining:**

- [ ] **Flip `inlineSynthesis` default to ON** (quality held → recommended). Gate: `settings.aggregator?.inlineSynthesis === true` in `moa.ts` → `!== false`, OR add `aggregator.inlineSynthesis: true` to `DEFAULT_SETTINGS` (settings-store.ts, no `aggregator` today). Same PR: update the "inlineSynthesis OFF (default)" gate test in `moa.test.ts`, the README "MoA pipeline" prose + mermaid (doc-freshness §7), §9.1 above, and the CLAUDE.md next-session handoff note. NOTE: the trace-memory quality-score comparison the original plan named is a weak proxy (converging proposers max it to 1.000 on both arms) — judge by answers + the latency/token deltas instead.
- [ ] (Later micro-sprint) tournament collapse via a stream-fixed-string mechanism.
