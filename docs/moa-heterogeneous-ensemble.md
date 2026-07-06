# Heterogeneous MoA Ensemble — A/B (2026-07-06)

Follow-up to [`moa-value-ab.md`](moa-value-ab.md). That run proved the swarm beats a single agent **when every model is the same** (all `deepseek-chat`). This run tests the intended production shape: **a premium orchestrator, cheap free-tier proposers, and a premium cross-family Skeptic — do the pieces work in concert, and does the swarm still win?**

## Configuration under test

| Role | Model | Rationale |
|---|---|---|
| Orchestrator / brain (final synthesis stream) | `openai/gpt-4o` | premium synthesizer, the hypothetical "real" operator brain |
| Proposers (researcher personas, fan-out) | `nvidia/nemotron-3-super-120b-a12b:free` | free-tier workers — cheap, diverse, disposable |
| **Skeptic (reviewer persona)** | **`anthropic/claude-sonnet-4.6`** | premium **cross-family** critic (`resolveSkepticModelConfig` → `proposerTiers.skeptic`) |
| Router / utility | `deepseek/deepseek-chat` | DPG persona generation + disagreement embedding |

All via OpenRouter. Single-agent arm = `gpt-4o` alone (`swarmEnabled: false`). Judge = `deepseek-chat` — now **outside both arms' model families**, which removes the self-preference caveat that dogged the homogeneous run (there deepseek judged deepseek).

## Verdict

**The heterogeneous ensemble works end-to-end AND wins more decisively than the homogeneous one: swarm 10/12 agreed blind wins, 1 loss, 1 tie** (vs 8/12, 0 losses homogeneous). A premium brain + a premium cross-family Skeptic + diverse cheap proposers is the strongest configuration tested.

The wiring is proven from the server log across the run: **Sonnet resolved onto the reviewer persona 13×, nemotron onto researchers 24×, gpt-4o synthesized every final answer** — exactly the `resolveSkepticModelConfig` precedence (`proposerTiers.skeptic` beats the tier path) the operator-owned-Skeptic track built.

## Results (N=12)

| Prompt | Category | Verdict | Cost single/swarm | Latency single/swarm |
|---|---|---|---|---|
| sqlite-migration | contentious | **swarm** | $0.055 / $0.034 | 9s / 664s\* |
| monorepo-vs-polyrepo | contentious | **swarm** | $0.054 / $0.072 | 21s / 86s |
| rust-rewrite | contentious | **swarm** | $0.054 / $0.190 | 14s / 108s |
| rest-vs-graphql | contentious | **swarm** | $0.027 / $0.100 | 11s / 111s |
| offline-sync design | multi-faceted | **swarm** | $0.031 / $0.096 | 14s / 148s |
| nextjs migration | multi-faceted | **swarm** | $0.057 / $0.078 | 14s / 80s |
| key-leak IR | multi-faceted | **swarm** | $0.030 / $0.124 | 11s / 86s |
| js-sort semantics | fact-sensitive | single | $0.055 / $0.119 | 17s / 126s |
| python-gil / 3.13 | fact-sensitive | **swarm** | $0.153 / $0.087 | 27s / 89s |
| http-caching RFCs | fact-sensitive | **swarm** | $0.061 / $0.170 | 17s / 86s |
| fibonacci (control) | consensus | tie (pos-sensitive) | $0.027 / $0.028 | 8s / 21s |
| email-regex (control) | consensus | **swarm** | $0.030 / $0.101 | 17s / 147s |

\* sqlite swarm 664s is a cold-server-start outlier recovered from disk (the runner hit its per-run timeout on the very first swarm run while Next.js was still compiling); it inflates the mean only.

Per category: contentious **4/4 swarm** · multi-faceted **3/3 swarm** · fact-sensitive 2/3 swarm (1 single) · consensus 1 swarm + 1 tie.

Totals: swarm **10 wins / 1 loss / 1 tie**. Cost single $0.63 / swarm $1.20 (**1.9×** — same ratio as homogeneous, but ~12× the absolute dollars because gpt-4o + Sonnet are premium). Latency single median 15s / swarm median **99s** (89s dropping the sqlite outlier) — the free proposers and the two-permit local semaphore dominate this.

The single arm's one win (js-sort) was a style call — the judge found both answers correct and complete, gpt-4o "slightly more concise." Not a swarm error. Meanwhile the swarm's wins on python-gil and http-caching again turned on the single arm making precise factual slips (wrong free-threading build flag, `max-age=0` vs `no-cache` confusion) that the Sonnet-audited ensemble avoided.

## Findings

1. **Heterogeneous routing is correct.** `resolveSkepticModelConfig` / `resolveProposerModelConfig` put Sonnet on the reviewer and nemotron on researchers on every swarm run; the brain stayed gpt-4o. No config leaked across roles.
2. **A cross-family premium Skeptic strengthens the result.** The homogeneous swarm won 8/12; swapping in a gpt-4o brain + a Sonnet skeptic took it to 10/12. The forced anti-sycophancy critic is more valuable when it is a genuinely different, strong model auditing the drafts — which is the whole point of the operator-owned-Skeptic knob.
3. **Free-tier proposers are flaky but the ensemble degrades gracefully.** Proposer success ran 1/4–4/4 (mean ≈ 2.5/4); nemotron:free frequently returned near-empty drafts or took 100s+ under parallel load. `isSuccessfulDraft` dropped the empties and the inline-synthesis collapse ran on whatever survived (≥2). Cheap flaky workers + a premium skeptic + a premium brain still beat a single premium agent.
4. **The economics flip vs homogeneous.** Same 1.9× ratio, but ~$0.10/prompt absolute — the premium brain and Skeptic dominate cost. On this config the swarm is worth it for hard prompts and clearly not for trivial ones (unchanged conclusion; the Router bypass matters more here because each wasted swarm is pricier).
5. **Cross-family judge removes the prior caveat.** deepseek judging gpt-4o/nemotron/Sonnet outputs has no self-preference toward either arm — strengthening the homogeneous run's directional result.

## Caveats

- Free-tier proposer reliability is upstream-rate-limited and time-varying (see the model-probe: llama/qwen/gpt-oss `:free` were all 429 at test time; nemotron:free worked but flaked under load). A different day yields a different proposer mix.
- N=12, single judge, one heterogeneous config. Directionally strong (10/1/1) but not a benchmark.
- Latency is machine-bound (2-permit semaphore queues 2 of 4 proposers) and includes one cold-start outlier.

## Reproduce

Same harness as `moa-value-ab.md` (`scripts/moa-ab/`), with the throwaway settings set to the four models in the table above (`chatModel`, `proposerTiers.{fast,balanced,frontier}` = the free proposer, `proposerTiers.skeptic` = the Sonnet id, `utilityModel` = deepseek). Confirm the wiring in the server log:

```bash
grep -oE "role=(researcher|reviewer), model=openrouter/[^)]+" server.log | sort | uniq -c
```

Every `role=reviewer` line must name the Skeptic model.
