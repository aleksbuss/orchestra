# MoA Skeptic — causal-isolation A/B (Skeptic-eval Step 2)

## Why

Both existing A/Bs ([`moa-value-ab.md`](./moa-value-ab.md), [`moa-heterogeneous-ensemble.md`](./moa-heterogeneous-ensemble.md)) compare **swarm vs single agent** — they measure the *ensemble's* value, not the *Skeptic's*. PM #91 made the Skeptic injection **unconditional** in production (`generateDynamicSwarm` injects the canonical critic on `!hasSkeptic`), so there is no production control arm: you cannot run "swarm **with** guaranteed Skeptic" against "swarm **without** Skeptic, same headcount" to isolate the Skeptic's causal contribution.

This is that missing control arm — **test/eval-only**, production untouched.

## The lever

`ORCHESTRA_EVAL_SKEPTIC_CONTROL=true` (honored **only** when `NODE_ENV !== "production"`). When active, `applySkepticControlArm` ([`moa-router.ts`](../src/lib/agent/moa-router.ts)) replaces **every** reviewer-role persona — a DPG-produced skeptic **and** the PM #37/#91 force-injected canonical critic — with a neutral `General Analyst` of the **same slot**. Result: a swarm of identical headcount with **no** guaranteed Skeptic.

- Flag unset (default) **or** a production build → strict no-op. The PM #91 invariant holds on every real run.
- The neutral persona's id/role/systemPrompt deliberately avoid every `detectProposerRole` reviewer token, so downstream (`moa.ts`) treats it as a plain tool-less proposer, not a smuggled second critic.

**Never set this in production.**

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
