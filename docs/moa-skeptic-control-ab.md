# MoA Skeptic — causal-isolation A/B (Skeptic-eval Step 2)

## Why

Both existing A/Bs ([`moa-value-ab.md`](./moa-value-ab.md), [`moa-heterogeneous-ensemble.md`](./moa-heterogeneous-ensemble.md)) compare **swarm vs single agent** — they measure the *ensemble's* value, not the *Skeptic's*. PM #91 made the Skeptic injection **unconditional** in production (`generateDynamicSwarm` injects the canonical critic on `!hasSkeptic`), so there is no production control arm: you cannot run "swarm **with** guaranteed Skeptic" against "swarm **without** Skeptic, same headcount" to isolate the Skeptic's causal contribution.

This is that missing control arm — **test/eval-only**, production untouched.

## The lever

`ORCHESTRA_EVAL_SKEPTIC_CONTROL=true` (honored **only** when `NODE_ENV !== "production"`). When active, `applySkepticControlArm` ([`moa-router.ts`](../src/lib/agent/moa-router.ts)) replaces **every** reviewer-role persona — a DPG-produced skeptic **and** the PM #37/#91 force-injected canonical critic — with a neutral `General Analyst` of the **same slot**. Result: a swarm of identical headcount with **no** guaranteed Skeptic.

- Flag unset (default) **or** a production build → strict no-op. The PM #91 invariant holds on every real run.
- The neutral persona's id/role/systemPrompt deliberately avoid every `detectProposerRole` reviewer token, so downstream (`moa.ts`) does not re-classify it as a second skeptic. (Its `General Analyst` role classifies as `researcher`, which gets the same tools as a reviewer — see **Confounds** below.)

**Never set this in production.**

## Confounds — what this DOES and does NOT isolate

A skeptical review (self-audit + a DoubleTake cross-model second opinion) raised two confounds; both are addressed:

- **Tools held constant (no `search_web` confound).** A reviewer/skeptic persona gets `search_web` (+ a fact-check mandate) when a search key is configured; a bare proposer does not ([`moa-proposer-tools.ts`](../src/lib/agent/moa-proposer-tools.ts)). The control persona's role is `General Analyst`, which `detectProposerRole` classifies as **`researcher`** — and reviewer AND researcher get the SAME tool treatment. So both arms have identical tools (search + mandate when a key is set; none otherwise); the ONLY variable that changes is the skeptic **persona prompt**. Pinned by a test (`detectProposerRole(controlPersona) === "researcher"`).
- **Topology unchanged.** MoA proposers (the skeptic included) run in **parallel**; a separate Aggregator synthesizes their drafts ([`moa.ts`](../src/lib/agent/moa.ts)). The skeptic is a parallel proposer, not the synthesizer — swapping its persona changes one proposer's prompt, NOT the MoA topology.

**So the A/B isolates exactly one variable: the guaranteed skeptic _persona prompt_ (doubt-the-premise framing) vs a neutral analyst prompt, with headcount AND tools held constant.** It does NOT measure "any fact-checking vs none" — with a search key set, the control persona still has search + the fact-check mandate; only the explicit skeptic framing is removed.

## Run it

Uses the fact-trap suite from PR #51 (`evals/cases/11-22`, tag `fact-trap`). Both arms hit the operator's configured real provider — set a working `chatModel`/`utilityModel` first.

```bash
# Arm A — Skeptic ON (production behavior: guaranteed critic)
npm run evals -- --real --tag fact-trap

# Arm B — control: same headcount, Skeptic swapped for a neutral analyst
ORCHESTRA_EVAL_SKEPTIC_CONTROL=true npm run evals -- --real --tag fact-trap
```

Watch stdout for the loud `⚠️ Skeptic CONTROL ARM active` line on Arm B (one per Router call) — it confirms the swap fired.

## Read the result

Each arm prints `passed/total`. The fact-trap cases assert the false premise is **corrected**, so:

- **Arm A pass-rate − Arm B pass-rate = the Skeptic's causal contribution** on false-premise correction.
- A ≈ B → on these prompts the Skeptic adds little over a same-size generic ensemble (the proposers already correct the premise).
- A ≫ B → the Skeptic is doing the correcting; the guarantee earns its keep.

Full per-case JSON lands in `evals/results/<timestamp>.json` (gitignored) for a per-case diff between the two arms.

## Scope (deliberate)

- No promptfoo / LLM-judge / big-N — deterministic string assertions only, as in Step 1.
- The production PM #91 unconditional-injection invariant is **not** touched; this is purely an eval control path.
- N is small (12 cases) — a directional signal, not a powered study.
