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
| Model — brain, proposers, Router, tournament judges | `openrouter/inclusionai/ling-3.0-flash:free` **(amended 2026-07-26, see Addendum 1)** | ONE model everywhere. Model heterogeneity is a separate variable and is not what is being tested. A FREE model is the operator's actual production regime — the whole free-tier failover stack exists for it — so testing on a paid model would have measured a configuration nobody runs. |
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

## Addendum 1 — calibration, 2026-07-26 (before any scored arm)

Three things changed between pre-registration and the scored run. All are recorded
here rather than edited silently into the text above; the one scored arm that ran
before these changes (a control round on the easy case set) was DISCARDED, not kept.

**1. The model is now free, not paid.** The first pilots ran on
`deepseek/deepseek-chat` (paid), chosen for delivery reliability. That was the wrong
call: Orchestra's free-tier failover stack — retry-on-empty, circuit breaker,
endpoint-aware pacing, the brain's delivery ladder — exists *because* the operator
runs free models, so an experiment on a paid model measures a configuration that is
never used. Switched to `inclusionai/ling-3.0-flash:free` for every role (brain,
proposers, Router, judges), which also restores the "one model everywhere" rule with
no exception. Total paid spend before the switch: ≈ $0.12.

**2. Enumerated-constraint tasks are SATURATED — they cannot answer the question.**
Two case sets were built and both ceilinged on the control (single-agent) arm:

| Case set | Constraints/case | Control mean score |
|---|---|---|
| 11 cases, 5–6 explicit constraints (`90`–`100`) | 6 | **1.0000** (66/66) |
| 11 cases, 10–14 explicit constraints incl. banned imports, exact error strings, structured docstrings (`110`–`120`) | 12 | **0.9917** |

The second set ceilinged on the FREE model too, at ~7 s/case. Spot-checking the
responses confirmed this is real capability, not a weak checker: the 2.8-second
answer to "thread-safe O(1) LRU cache, 12 constraints, no `functools.lru_cache`" was
a fully correct `OrderedDict` + `Lock` implementation. **When requirements are
enumerated explicitly, a current model — free tier included — simply satisfies them,
and there is no headroom for any aggregation strategy to demonstrate anything.**
This is itself a finding worth keeping: it rules out the entire "multi-constraint
authoring" task class as an instrument for measuring swarm value, and it is the most
likely reason earlier constraint-style A/Bs found nothing.

**3. Cases are therefore selected by measured difficulty**, from the corpora built to
catch failure (fact-traps, sycophancy pressure, agentic/tool cases) rather than
authored to be long. A calibration pass runs the control arm ONCE over the whole
corpus; cases where the control does not already score 1.0 form the experiment set.

*Why this does not rig the result:* selecting cases where control failed would bias
the ABSOLUTE level of every arm upward on re-run (regression to the mean), but every
arm — **including a freshly re-run control** — is measured on the same selected cases
with new runs. The calibration data is never reused as an arm's score. Regression to
the mean therefore moves all arms together and cancels in the paired contrasts,
which are the only quantities the decision rules read. What it does cost is external
validity: the arm means describe *hard* cases, not the average case, so the headline
must always be reported as a contrast, never as "the swarm scores X%".

## Results (2026-07-27)

### The experiment could not be run as designed — and that is the finding

The five-arm factorial never executed, because **no task class could be found where
the control arm has room to improve.** With a single free agent scoring at or near
the ceiling, every pre-registered contrast is mechanically bounded at ≤ 0: an arm
cannot beat a control that is already perfect. This is not an underpowered result —
it is a *saturated instrument*, and it invalidates the design rather than the
hypothesis.

Five independent task classes were built and measured on the control arm
(`inclusionai/ling-3.0-flash:free`, single agent, no swarm):

| # | Task class | Cases | Control mean score |
|---|---|---|---|
| 1 | Code authoring, 5–6 explicit constraints | 11 | **1.0000** (66/66) |
| 2 | Code authoring, 10–14 constraints — banned imports, exact error strings, structured docstrings | 11 | **0.9917** |
| 3 | The entire pre-existing corpus: fact-traps, sycophancy pressure, agentic/tool cases | 107 | **0.9635** (99/107 perfect) |
| 4 | Six-claim audits — mixed true/false, scored per claim, compositional load | 12 × 2 | **1.0000** (144/144) |
| 5 | **Generated logic-grid puzzles** — novel by construction, unique solution verified by brute force | 12 × 3 | **1.0000** (36/36) |

Class 5 is the decisive one. Classes 1–4 could be dismissed as textbook material the
model memorised; these puzzles were generated from a seeded RNG and each clue set
was brute-forced to admit exactly one solution, so no model can have seen them. The
hardest (5 houses, 9 clues) was solved correctly in **5.2 seconds**, matching the
brute-force ground truth exactly, on all three repeats.

Spot-checks confirm the scores are real capability, not lenient assertions: the
2.8-second answer to "thread-safe O(1) LRU cache, 12 constraints, no
`functools.lru_cache`" was a correct `OrderedDict` + `Lock` implementation.

### What the swarm costs, at equal quality

Since quality is pinned at the ceiling for every arm, the remaining measurable
quantity is price. Same 12 puzzles, same model, same build:

| Arm | Mean score | s/run | TTFT | Prompt tok/run | Completion tok/run | No-answer |
|---|---|---|---|---|---|---|
| control — single agent | 1.0000 | **3.7** | 3.5 | 12 903 | **585** | 0 |
| C — DPG swarm + synthesis (today's default) | 1.0000 | **16.4** | 16.2 | 17 949 | 2 615 | 0 |
| D — DPG swarm + tournament (selection) | 1.0000 | **27.2** | 26.9 | 18 147 | 2 907 | 0 |

**On this workload the swarm buys nothing and costs 4.4× wall clock and 4.5×
completion tokens; selection costs 7.4× and 5.0×.** TTFT tracks total latency almost
exactly, so the entire penalty is paid before the user sees a single character —
which is the cost the user actually feels.

### One clearly positive result

**The free-tier failover stack works.** Across 24 swarm runs — 3 free proposers
fanned out in parallel against one shared free endpoint, the exact herd that
produces upstream 429s — there were **zero delivery failures, zero degraded-to-
single-agent collapses, and zero lost drafts.** That is the regime the retry /
circuit-breaker / pacing / brain-ladder work was built for, and it held.

### CORRECTION — what arms C and D actually ran on the free tier

A post-hoc diagnostic (full swarm logging on one case) showed **both arm labels were
wrong on the free model**, and the reason is a single provider capability:

```
[MoA] Router fallback → static personas (reason=other, model=…/ling-3.0-flash:free). DPG did not run.
      error: status=400 … "model features structured outputs not support"
[Tournament] Judge #1/#2/#3 failed (non-fatal): Provider returned error
[MoA] Tournament produced no winner (all 3 judges failed). Falling back to synthesis aggregator.
```

`inclusionai/ling-3.0-flash:free` does not support **structured outputs**, and BOTH
of the swarm's differentiating features go through `generateObject`: the Router's
Dynamic Persona Generation, and the tournament judges' ballots
([`tournament-aggregator.ts:309`](../src/lib/agent/tournament-aggregator.ts#L309)).
So on that model:

- **"Arm C — DPG personas"** actually ran the three STATIC fallback personas
  (`analyst` / `creative` / `critic`). No task specialization happened.
- **"Arm D — tournament"** attempted selection, had all three judges fail, and fell
  back to synthesis. It measured *synthesis plus the cost of three failed judges*,
  which is why it is 10.8 s slower than arm C rather than faster.

The latency and token numbers above are still valid measurements of what executed;
only the arm NAMES were wrong. The quality conclusion is unaffected — control was at
the ceiling regardless. Both degradations were LOUD in stdout (PM #89 observability
earning its keep), but nothing in the eval harness noticed, which is a real rig gap:
the model-pin guard catches a changed model, not a silently degraded FEATURE.

**Verified fix:** pointing `utilityModel` and `aggregator.tournamentJudgeModel` at a
free model that does support structured outputs makes both features work —

```
[MoA] Router (DPG) personas generated by openrouter/nvidia/nemotron-nano-9b-v2:free — 3 persona(s)
[MoA] Proposer "logic_solver" / "swarm_verifier" / "color_theorist"   ← real specialization
[MoA] Tournament winner: logic_solver (Borda points: 2, 1/3 judges succeeded)
```

Only **4 of 15** free OpenRouter models advertise `structured_outputs`:
`nvidia/nemotron-nano-9b-v2:free`, `nvidia/nemotron-3-super-120b-a12b:free`,
`openai/gpt-oss-20b:free`, `google/gemma-4-26b-a4b-it:free`. Quality on the puzzle set
was still 1.0000 with DPG and the tournament working — the ceiling is a property of
the task, not of the degraded features.

### Honest scope

- **Tested:** short-form verifiable tasks — code authoring under explicit
  constraints, factual traps, sycophancy pressure, multi-claim auditing, novel
  deductive puzzles. On all of these, one free agent is already at the ceiling.
- **NOT tested:** long-horizon agentic work — multi-file edits, long tool loops,
  work spanning many turns where errors compound. That is the operator's actual
  usage and the only regime where a swarm still has a plausible case, because
  variance there comes from accumulated state, not from single-shot difficulty. It
  needs a different harness (programmatic verification of a repo end-state), which
  this session did not build.
- The arms C/D numbers are single-repeat (N=12 runs each). That is ample for the
  latency and token ratios reported, which do not depend on variance, and it is
  irrelevant for quality, which is pinned at 1.0 in every arm.

### Follow-up (2026-07-27): does DISAGREEMENT predict error?

If the ensemble cannot improve answers, it might still earn its place as a cheap
*difficulty detector*: run N cheap heterogeneous samples, ship the cheap answer when
they agree, escalate to an expensive model when they diverge. That requires
agreement to carry information about correctness. Tested directly.

**The homogeneous run was measuring nothing.** Distance was 0.000 on every run
because one model sampled three times at T=0.7 reproduces itself — the signal was
absent by construction, not absent in fact. Rebuilt with four model families
(brain `nemotron-3-ultra-550b`, Router `nemotron-3-super-120b`, proposers
`gpt-oss-20b` / `ling-3.0-flash` / `north-mini-code`, skeptic `laguna-m.1`), the
signal came alive: 13 of 28 runs had non-zero distance, up to 0.546. **The
heterogeneity correction was necessary and it worked.**

What it found, over 28 runs × 14 zebra puzzles (98 drafts):

| Quantity | Result |
|---|---|
| Delivered drafts correct | **91/93 (97.8 %)** |
| Cheap path (majority of drafts) correct | **28/28 (100 %)** |
| Final answer correct | **28/28 (100 %)** |
| Distance vs "all drafts correct" | r = −0.215 (right direction, driven by **2** wrong drafts) |

**The hypothesis is untestable in this regime, for the same reason as everything
else: there are no errors to predict.** Both wrong drafts came from a single model
(`gpt-oss-20b`), so even they are a model-reliability artefact rather than task
difficulty. A signal cannot be validated against an outcome that never varies.

One result is genuinely informative: **the cheap path was correct in all 28 runs**,
so the expensive 550B brain contributed nothing on these tasks — "always ship the
cheap answer" would have won outright, with no routing signal needed.

**Heterogeneity is not what the config says it is — 0 of 28 runs used 4 distinct
models** (mean 2.18). Two causes, both worth knowing:

| Model | Drafts | Delivered | Correct | Median latency |
|---|---|---|---|---|
| `inclusionai/ling-3.0-flash:free` | 53 | 53 | 53 | **4 s** |
| `nvidia/nemotron-3-super-120b-a12b:free` | 31 | 31 | 31 | 39 s |
| `openai/gpt-oss-20b:free` | 7 | 6 | 4 | 73 s |
| `cohere/north-mini-code:free` | 7 | **3** | 3 | 120 s (timeout) |
| `poolside/laguna-m.1:free` (pinned skeptic) | **0** | 0 | 0 | — |

1. Personas are mapped to models by the DPG-assigned `modelTier`, so several
   personas share a tier and you silently get one model repeatedly — `ling-flash`
   alone produced 54 % of all drafts.
2. `proposerTiers.skeptic` was pinned to `laguna-m.1:free` and produced **zero
   drafts in 28 runs** — every skeptic failed over to another model. Pinning a model
   is not the same as running it.

Cost of this configuration: **70 minutes for 28 runs (2.5 min/run)** against 4.6 s
for a single agent on the same puzzles — a ~33× latency multiplier, for an answer
that was already correct without it.

### Verdict against the pre-registered kill criterion

The criterion reads: *if the best swarm arm does not beat control by ≥ +0.05 mean
score, the MoA feature does not earn its place.* Best swarm arm − control = **0.0000**
on every task class measured. **The criterion is met on this workload**, with the
scope caveat above: this is a verdict about short-form verifiable tasks, not about
long-horizon agentic work, which remains genuinely untested.

The defensible reading is not "multi-agent is worthless" but something narrower and
more useful: **the swarm's value proposition cannot be located anywhere a current
model already succeeds on the first try — and that is now most short-form tasks,
free tier included.** Any future case for the swarm has to be made where single-pass
success is genuinely below ceiling. If that regime cannot be found either, the
honest move is the one the criterion already pre-committed to: keep the reliability
engineering, and stop paying 4–7× latency for the ensemble.
