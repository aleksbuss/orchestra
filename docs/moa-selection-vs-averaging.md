# Selection vs averaging — pre-registration

**Status:** pre-registered 2026-07-26, BEFORE any arm was run. Nothing below may be
edited after the first arm completes; corrections go in a dated addendum at the bottom.

## The two questions

Every previous Orchestra swarm experiment confounded these. This run separates them
with one factorial design.

1. **Does SELECTION beat AVERAGING?** N drafts → pick the best, vs N drafts → blend
   them into a new answer (today's default). Selection turns *mean of N* into *max of
   N*; synthesis can smooth a correct draft into a worse blend.
2. **Do ROLE PERSONAS (DPG) beat plain N-sampling of the same model?** N *different*
   role prompts vs N *identical* prompts. This is the existential question for the
   product: if identical prompts match role prompts, Orchestra is a Best-of-N wrapper,
   not a Mixture-of-Agents.

## Arms

| Arm | Proposer prompts | Aggregation | Env |
|---|---|---|---|
| `control` | — (no swarm) | single agent | `ORCHESTRA_EVAL_SWARM_MODE=single` |
| `A` | identical × N (self-MoA) | synthesis | `SWARM_MODE=swarm IDENTICAL_PROMPTS=true` |
| `B` | identical × N (self-MoA) | tournament | `+ AGGREGATOR_MODE=tournament` |
| `C` | DPG role personas | synthesis (today's default) | `SWARM_MODE=swarm` |
| `D` | DPG role personas | tournament | `SWARM_MODE=swarm AGGREGATOR_MODE=tournament` |

`B−A` and `D−C` answer question 1. `C−A` and `D−B` answer question 2. `control` anchors
everything. All env vars are prefixed `ORCHESTRA_EVAL_`; each is dev-only, defaults off,
and is a strict no-op unset (`src/lib/agent/eval-arms.ts`). The runner stamps the active
arms into every results file so an arm cannot be mislabeled afterwards.

## Declared parameters (fixed for every arm)

| Parameter | Value | Why it is declared |
|---|---|---|
| Model — brain, proposers, Router, tournament judges | `openrouter/deepseek/deepseek-chat` | ONE model everywhere. Model heterogeneity is a separate variable and is not what is being tested. Chosen for reliable delivery (free tiers 429 under parallel load, and delivery noise would swamp the signal) while still being weak enough to leave headroom. |
| Proposer temperature | **0.7** | At T=0 the self-MoA arms produce N identical drafts and the whole comparison collapses. |
| Brain temperature | 0.7 | Orchestra's default. |
| Router temperature | 0.3 | The Router is not under test; low temperature keeps persona *headcount* stable across arms. |
| `maxSwarmSize` | **3** | The Router schema is `.min(3).max(maxSwarmSize)`, so 3 pins the swarm at exactly N=3 in every arm. Headcount variance would otherwise confound arm comparisons. |
| `tournamentJudgeCount` | 3 | Best-of-N is only as good as its selector; 3 judges of the same model give self-consistency voting instead of a single weak opinion. Part of the definition of arms B/D. |
| `reflection.enabled` | false | Multi-pass reflection is a third factor. |
| `traceMemory.enabled` | **false** | Trace memory feeds past successful runs back into the Router as few-shots — later arms would inherit earlier arms' traces. This is the single worst contamination risk in a multi-arm run. |
| `degradationPolicy` | **quality** | `speed` (the default) lets the failover ladder SUBSTITUTE a different model when one looks dead — which would silently break "one model everywhere". `quality` forbids substitution. |
| Search | unavailable (no key) | Constant across arms. |

Operator's pre-experiment settings are backed up outside the repo and restored afterwards.

## Cases

11 constraint-satisfaction cases tagged `selection-ab` (`evals/cases/90..100`), 6
independent programmatic constraints each — 66 constraint observations per repeat per
arm. Tool-free by design: proposers run without tools (PM #77), so a tool-dependent case
measures the brain, not the aggregation being tested.

**Scoring is CONTINUOUS**: each case scores `constraints satisfied / constraints
scorable` ∈ [0,1]. Binary pass/fail discards most of the signal — "5 of 6" and "0 of 6"
are both a fail — which is why earlier A/Bs needed an unreachable N. Assertions are
programmatic only (regex/substring); no LLM judge sits in the scoring path. The judge
inside arms B/D is part of the *system under test*, never part of the metric.

**Repeats: 3 per case per arm** (33 runs per arm, 165 runs total). Repeats are the only
defence against the run-to-run variance that dominated every earlier result — two runs of
the same build once scored 5/6 and 3/6. Repeats are interleaved (all cases once, then
again) so a mid-run change in upstream conditions hits every case rather than one.

## Primary metric and pre-committed decision rules

**Primary metric:** arm mean continuous score. Secondary: binary pass rate, mean wall
clock per run, TTFT, USD cost. Delivery failures (`noAnswer`) are reported separately and
never read as a capability difference.

**Declared minimum interesting effect: +0.05 absolute mean score** (≈ one extra satisfied
constraint per 20). Anything smaller is not worth the latency multiple a swarm costs, so
declaring it uninteresting in advance is honest, not a dodge.

1. **Selection beats averaging** only if BOTH `B−A > 0` and `D−C > 0`, and at least one
   contrast reaches +0.05 with a 95 % paired bootstrap CI excluding 0.
2. **Role personas beat identical prompts** only if BOTH `C−A > 0` and `D−B > 0` under
   the same rule. If they are within ±0.05, the honest conclusion is that Orchestra's
   DPG buys nothing over plain N-sampling on this task class.
3. **KILL CRITERION:** if the BEST swarm arm (max of A–D) does not beat `control` by
   ≥ +0.05 mean score, the MoA feature does not earn its place — keep the reliability
   engineering, strip or rebrand the swarm. **Written up either way.**

Paired bootstrap is computed per case id (11 pairs, means over the 3 repeats) from the
raw per-run scores kept in each results JSON.

## Known limitations, stated in advance

- **Arms B/D are "selection + brain finalization", not verbatim shipping.** Orchestra's
  tournament winner is injected into the final tool-capable stream as
  `<expert_consensus>`; the brain then writes the answer. Collapsing the tournament path
  to ship the winner verbatim is a deferred micro-sprint
  (`docs/moa-aggregator-collapse.md` §9.3) and writing it now would be building
  aggregator code before the experiment justified it. What is measured is the selection
  path Orchestra actually ships today.
- **Empty answers score above 0**, because a `not_contains` assertion is vacuously true
  against an empty string (3 of the 11 cases have one). This inflates the floor
  identically in every arm, so it cannot bias a contrast; `noAnswer` runs are reported
  separately regardless.
- **Task class is bounded**: multi-constraint code/spec authoring, verifiable
  programmatically. It says nothing about open-ended work with no checkable answer.
- The Router still runs in the identical-prompts arms (it fixes headcount and the
  requiresSwarm verdict); only the persona prompts are replaced.
- N=11 cases × 3 repeats is sized for a LARGE effect only. A real effect below the
  declared threshold will not be detected, by design.

## Wall-clock and cost budget

Committed before launch: ≈ 5 h of wall clock and ≤ $5 of OpenRouter credit across all
five arms. If the pilot shows the total exceeding that, repeats drop to 2 for EVERY arm
(never for some arms only), and this line is amended before any scored arm runs.

---

## Results

*(filled in after the run — nothing above this line changes)*
