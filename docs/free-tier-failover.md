# Free-tier failover — making MoA development work on $0 models (2026-07-26)

## The claim, stated narrowly

**Layered failover raises Orchestra's DELIVERY RATE on free models.**

That is an engineering claim about availability, and it is measurable. It is deliberately **not** the claim that the swarm reasons better — that was tested repeatedly across [`moa-value-ab.md`](moa-value-ab.md), [`moa-heterogeneous-ensemble.md`](moa-heterogeneous-ensemble.md) and the 2026-07-25 benchmark work, and on verifiable tasks it was never demonstrated. Two different questions; only the first one is answered here.

Who this is for: a user for whom **$0 is a hard constraint**. Paying users get the same machinery as an invisible safety net. The honest pitch is *"Orchestra makes MoA development possible on free models — pay for speed and predictability; don't pay and it still works, slower, switching between models, and quality may vary"* — never *"same quality, just slower"*, which would be false the moment a substitution happens.

## Why free endpoints fail

An OpenRouter `:free` endpoint under load does not return a clean error. It returns **HTTP 200 with an empty body**. Sometimes it returns 429. Both look identical to "the model produced nothing", and both are triggered by exactly the traffic shape MoA generates: 3–5 proposers firing at the same instant, through one API key, at one shared endpoint.

The consequences cascade:

1. The aggregator needs **≥ 2 successful drafts**. Below that, synthesis is skipped.
2. Deep Audit only runs if aggregation produced something to critique — so a pinned premium Skeptic silently never audits.
3. The turn answers as a plain single agent, indistinguishable from a healthy run unless something says so.

Empty bodies also hit the **brain** (the final `streamText` that writes the answer), where there are no survivors at all: the turn just ends blank.

## The five layers

Innermost first. Each one exists because the layer inside it cannot cover the case.

| # | Layer | Module | What it cannot do |
|---|---|---|---|
| 1 | Retry on empty body / 429 | `moa.ts` | Cannot fix a permanently dead endpoint |
| 2 | Circuit breaker + cross-model substitution | [`model-health.ts`](../src/lib/agent/model-health.ts) | Cannot prevent the failure, only route around it |
| 3 | Endpoint-aware pacing | [`proposer-pacing.ts`](../src/lib/agent/proposer-pacing.ts) | Cannot help once an endpoint is already down |
| 4 | Brain-side delivery ladder | [`final-answer-failover.ts`](../src/lib/agent/final-answer-failover.ts) | Cannot decide whether swapping models is acceptable |
| 5 | Degradation policy | [`degradation-policy.ts`](../src/lib/agent/degradation-policy.ts) | — (it is the user's decision, not a mechanism) |

### 1. Retry on empty

`ORCHESTRA_PROPOSER_EMPTY_RETRIES` (default 2) re-issues the generation with a linear, **jittered** backoff. A fresh `AbortSignal` is built per attempt — a reused expired signal aborts the retry instantly — and the parent abort stays chained. A **thrown** 429 is retried on the same budget: the AI SDK's own `maxRetries: 2` retries on a millisecond ladder, which is the wrong timescale for a shared quota that needs seconds.

The jitter is not cosmetic. Proposers that hit the same endpoint at once would otherwise wake at the same millisecond and re-fire in lockstep, recreating the burst one layer down.

### 2. Circuit breaker

`N` consecutive failures (default 3) trip an endpoint for a cooldown (default 5 min), after which exactly **one** half-open probe is handed out. Three design rules earned through review:

- **Reads are pure.** An earlier cut healed the entry as a side effect of `isModelCircuitOpen`, so the instant the cooldown expired every proposer saw "closed" and the whole herd hit a maybe-dead endpoint. Half-open must hand out one probe, not permission to stampede.
- **Failures require positive evidence.** `classifyModelFailure` returns `null` for anything that is not demonstrably the endpoint's fault — an over-long prompt, a full semaphore queue, a local `TypeError`. Counting those let an *Orchestra* bug mark a healthy model dead for every concurrent chat. A breaker must open on evidence, never on ignorance.
- **One failure per proposer, on retry exhaustion.** The counter is shared by concurrent proposers, so per-attempt recording made N proposers each hitting one transient empty look like N consecutive failures — spurious open, abandoned retries, lost drafts. That regressed the exact metric this track exists to raise.

Substitution draws from the operator's own configured models, rotated by proposer index so concurrent proposers pick *different* substitutes. It **fails open**: when every candidate is tripped, the operator's own model runs anyway. A breaker that can block a run is worse than the throttling it guards against.

### 3. Pacing

The only layer that prevents the failure rather than recovering from it. `computeStaggerMs` replaces the old uniform `index × 250 ms` with an endpoint-aware offset: paid endpoints keep the previous profile, free endpoints spread wider, and an endpoint the breaker has already seen fail spreads wider still — capped at 8 s so a slow start can never dominate the turn. The sleep is abort-aware, because 8 s of non-cancellable wait after the user presses stop is not acceptable.

`withFreeTierPacing` additionally caps concurrent free-tier dispatches on a process-global semaphore shared across chats. **Ordering matters:** it is acquired *outside* the global `agentSemaphore`. Nested the other way, a proposer waiting on a remote quota holds one of the machine's scarce global permits (2 on a 16 GB box) and starves the embedder and the main agent path.

"Free" is the literal `:free` OpenRouter id suffix — a naming fact, so it cannot misclassify a paid model. `ORCHESTRA_PACE_ALL_MODELS=true` forces pacing everywhere for operators whose free tier is named differently.

### 4. Brain-side delivery ladder

Layers 1–3 protect the proposer fan-out. The brain had none of it: when its endpoint returned an empty body, the forced final answer ran **once** on that same endpoint, got another empty body, and the turn returned `""` silently.

Now: brain → one jittered abort-aware retry → one attempt on a healthy substitute from the operator's settings, each substitution announced in the turn's notice. An undeliverable turn always carries an explanation instead of silence.

It **never replays the tool-capable stream**. "Zero output reached the client" does not prove the remote side executed nothing — a tool may have run before the stream dropped — so every attempt is tool-less by construction. The worst case is a wasted generation, never a repeated side effect.

### 5. Degradation policy

A substituted model is a *different* model. Whether that trade is acceptable is the user's call:

- **`speed`** (default) — substitute automatically, and always say which model answered instead of which.
- **`quality`** — never substitute; retry the user's model, then report honestly.
- **`ask`** — never substitute; the closing notice offers the choice for the next turn.

Background/Auto-Pilot runs are forced to `speed`: nobody is there to read a "try again later" notice.

**Honest limitation of `ask`:** Orchestra has no mid-turn user-input primitive, so it cannot pause a running turn and pop a dialog. It asks at the end of the turn, once the pool is exhausted. Per-empty-body prompting was rejected outright — one observed run logged 14 empty bodies, and 14 modals would be unusable.

## What is deliberately NOT built

- **MoA DAG checkpoint + resume.** On the free tier drafts cost $0, so preserving partial progress saves only time while adding a persisted state machine, schema migrations, daemon-vs-user write races, orphan cleanup, and SSE desync. Graceful degradation already covers it: 4 of 5 proposers surviving should just synthesize.
- **Garbage-repetition detection.** An NLP problem, not a network one; a brittle regex would cause false-positive retry storms.
- **Per-empty-body user prompts.** See above.

## Operator knobs

| Variable | Default | Effect |
|---|---|---|
| `ORCHESTRA_PROPOSER_EMPTY_RETRIES` | 2 | Retries when a proposer gets an empty body |
| `ORCHESTRA_PROPOSER_EMPTY_BACKOFF_MS` | 2000 | Base backoff (jittered +0–40%) |
| `ORCHESTRA_PROPOSER_TIMEOUT_MS` | 120000 | Per-proposer generation budget |
| `ORCHESTRA_MODEL_CIRCUIT_THRESHOLD` | 3 | Consecutive failures that trip an endpoint |
| `ORCHESTRA_MODEL_CIRCUIT_COOLDOWN_MS` | 300000 | Cooldown before the half-open probe |
| `ORCHESTRA_MODEL_CIRCUIT_DISABLED` | unset | Strict-string opt-out of the breaker |
| `ORCHESTRA_FREE_STAGGER_MS` | 900 | Free-endpoint stagger base |
| `ORCHESTRA_PROPOSER_STAGGER_MS` | 250 | Paid-endpoint stagger base (unchanged) |
| `ORCHESTRA_FREE_TIER_CONCURRENCY` | 2 | Concurrent free dispatches; `0` disables the cap |
| `ORCHESTRA_PACE_ALL_MODELS` | unset | Treat every endpoint as free-tier |
| `ORCHESTRA_FINAL_ANSWER_BACKOFF_MS` | 2000 | Brain-retry backoff (jittered) |

Health surface: `/api/health` → `model_endpoints` lists every tripped endpoint with its consecutive-failure count and last failure kind. Breaker state is in-memory and per-process, so an empty list right after a restart means "nothing dispatched yet", not "everything is healthy".

## Measurement — and a correction

### The headline metric was measuring the harness, not the agent

The thesis was "failover raises free-tier DELIVERY". Measuring it exposed a bug **in the measuring instrument**, not in the agent.

`invokeRealAgent` extracted the answer as *"last assistant message wins"*. When a model answers through the `response` tool — Orchestra's explicit final-answer channel (PM #61) — the last assistant message is the tool-CALL carrier with `content: ""`, and the answer text lives in the following `role: "tool"` message. Every such turn was scored as an **empty response, i.e. a delivery failure**.

Cross-checking each scored-empty case against its chat as persisted on disk (soft-deleted eval chats survive in `data/.trash/chats/`, PM #63):

| Run | Cases the harness scored EMPTY | What was actually on disk |
|---|---|---|
| swarm, pre-failover | `83-agentic-verify-fib`, `91-multi-constraint-refactor` | 425 and 676 characters delivered |
| swarm, retry only | `91-multi-constraint-refactor` | 676 characters delivered |
| swarm, full stack | `85-agentic-primes`, `92-multi-constraint-validator` | 101 and 780 characters delivered |

Across ~300 persisted eval chats, exactly **one** contains no delivered answer. Real delivery on these six cases was 6/6 in every arm, before and after this work.

**Therefore the previously recorded "delivery 4/6 → 5/6 (67% → 83%)" improvement is withdrawn.** It was an artifact. Fixed in `extractDeliveredAnswer` (last `response`-tool result, else last non-empty assistant text), pinned by regression tests in [`runner.test.ts`](../src/lib/evals/runner.test.ts).

### What the runs DO show

From the run logs (which record the proposer layer directly), on the free-hetero config — `nemotron-3-super-120b:free` brain, `north-mini-code:free` / `gpt-oss-20b:free` / `ling-3.0-flash:free` / `nemotron-3-nano-30b:free` tiers:

- **Empty bodies from free endpoints are real and frequent.** One 6-case swarm run logged **8 empty-body events** across two free models, including two proposers that needed a second retry. The jittered backoff is visible in the log (2255 ms, 2359 ms, 4532 ms, 5033 ms).
- **The retry recovers them.** No circuit tripped in that run — no endpoint accumulated three *exhausted* proposers, which is exactly the intended threshold behaviour: transient empties that recover leave no mark.
- **Run-to-run variance dominates any 6-case score.** Two swarm runs of the *same build*, 20 minutes apart: 5/6 and 3/6 assertion passes. Any delivery or quality claim at this N is noise.
- **The swarm costs ~2.5× the latency of the single arm** on this config (441 s vs 174 s total across 6 cases) and did not win on quality: both arms passed 5/6, failing the same case.

### Honest conclusion

The failover stack is justified by the *mechanism* it handles — empty bodies and 429s from shared free endpoints are observable, frequent, and recovered by these layers — and by the unit tests that pin each layer's behaviour. It is **not** justified by an end-to-end delivery-rate improvement, because on the measured cases delivery was already ~100% once the metric itself was correct.

The user-visible effect of this work is therefore: **fewer proposers lost to throttling** (more drafts reach the aggregator), **no silent blank turns** when the brain's endpoint is throttled, and **no silent model substitution**. Those are worth having. "Failover raises delivery from 67% to 83%" is not a claim this repository can support, and it should not be repeated.

## Known-dead free models (do not configure)

- `google/gemma-4-31b:free` — 0/16 delivery when probed. Also matched by `NO_TOOL_PATTERNS`, so it never receives tools at all.
- All `poolside/laguna-*:free` — empty body 3/3.
- `openrouter/free` and `openrouter/auto` — meta-router pseudo-ids that silently substitute a model of their own choosing; they defeat every measurement in this document.

Confirmed working at test time: `deepseek/deepseek-chat`, `openai/gpt-4o`, `anthropic/claude-sonnet-4.6`, and `nvidia/nemotron-3-super-120b-a12b:free` (fine solo, flaky under swarm parallelism — which is what this track exists to handle).
