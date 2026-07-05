# MoA Swarm vs Single Agent — Value A/B (2026-07-05)

Answers the long-open question (CLAUDE.md handoff item, 2026-06-22): **is the MoA swarm worth its token/latency cost vs a single agent?** The prior 2c experiment only compared inline-synthesis collapse ON/OFF with the swarm ON in both arms; this is the first swarm-ON vs swarm-OFF comparison.

## Verdict

**The swarm earns its cost exactly where the architecture predicted: contentious, multi-faceted, and fact-sensitive prompts (8/12 blind wins, 0 losses). On consensus prompts it adds cost for zero quality gain (2/2 ties) — which validates the Router's `requiresSwarm: false` bypass as the right design.**

Price of the swarm on this config: **1.9× cost, 3.1× latency, 1.6× tokens** (totals across N=12).

## Method

- **Arms:** identical brain both sides (`deepseek/deepseek-chat` via OpenRouter). Single = `swarmEnabled: false`; swarm = `swarmEnabled: true` (production defaults: inline-synthesis collapse ON, reflection OFF, no forceSwarm — Router decides, and it chose `requiresSwarm: true` with 4 DPG personas on every measured prompt).
- **Runner:** `scripts/moa-ab/run-ab.mjs` — background-mode `POST /api/chat` with client-supplied chatId against an isolated dev server (`:3001`, throwaway `ORCHESTRA_DATA_DIR` seeded with a settings copy, `ORCHESTRA_DISABLE_AUTH=true`), polling `GET /api/chat/history` with a stability re-check. Sequential runs for clean latency numbers.
- **Prompts:** `scripts/moa-ab/prompts.json` — 4 contentious (commit-to-a-recommendation tradeoffs), 3 multi-faceted (breadth-demanding designs/plans), 3 fact-sensitive (precision with hallucination bait), 2 consensus controls.
- **Judge:** `scripts/moa-ab/judge.mjs` — blind pairwise, `deepseek-chat` at temperature 0, **two passes with swapped A/B positions**; a verdict counts only when both passes agree, otherwise it is recorded as *position-sensitive* (≈ tie). Rubric: correctness ≫ completeness/insight ≫ directness; verbosity explicitly not rewarded.

## Results (N=12)

| Prompt | Category | Verdict | Cost single/swarm | Latency | 
|---|---|---|---|---|
| sqlite-migration | contentious | **swarm** | $0.0030 / $0.0083 | 17s / 86s |
| monorepo-vs-polyrepo | contentious | **swarm** | $0.0030 / $0.0076 | 21s / 80s |
| rust-rewrite | contentious | tie (pos-sensitive) | $0.0032 / $0.0085 | 23s / 96s |
| rest-vs-graphql | contentious | **swarm** | $0.0030 / $0.0074 | 20s / 83s |
| offline-sync design | multi-faceted | tie (pos-sensitive) | $0.0034 / $0.0082 | 35s / 80s |
| nextjs-12→15 migration | multi-faceted | **swarm** | $0.0066 / $0.0089 | 29s / 120s |
| key-leak incident response | multi-faceted | **swarm** | $0.0056 / $0.0091 | 48s / 94s |
| js-sort semantics | fact-sensitive | **swarm** | $0.0033 / $0.0111 | 29s / 92s |
| python-gil / 3.13 | fact-sensitive | **swarm** | $0.0062 / $0.0099 | 27s / 106s |
| http-caching RFCs | fact-sensitive | **swarm** | $0.0065 / $0.0091 | 32s / 76s |
| fibonacci (control) | consensus | tie (pos-sensitive) | $0.0058 / $0.0056 | 23s / 68s |
| email-regex (control) | consensus | tie (pos-sensitive) | $0.0029 / $0.0072 | 23s / 70s |

Per category: contentious 3 swarm + 1 tie · multi-faceted 2 swarm + 1 tie · fact-sensitive **3/3 swarm** · consensus controls **0 swarm, 2/2 tie**. Single agent: zero agreed wins anywhere.

Totals: single $0.053 / swarm $0.101 (**1.9×**) · mean latency 28s / 88s (**3.1×**) · tokens 234K / 364K (**1.6×**).

Signal quality notes: on fact-python-gil the judge caught the single arm mis-stating Python 3.13 free-threading status in BOTH passes (the swarm's forced QA-auditor/Skeptic persona is plausibly the mechanism); on fact-http-caching the single arm cited the outdated RFC 7234 where the swarm cited RFC 9111.

## Caveats (honest bounds)

1. **Judge is deepseek judging deepseek outputs** — self-preference bias possible. Mitigated (not eliminated) by blind randomized positions + double-pass with swap; the 4 position-sensitive results show the control working. A second-family judge (e.g. a Gemini/GPT re-judge of the saved answers) would strengthen this.
2. **N=12, one model family, one settings profile.** Direction is consistent across categories, but this is one configuration: deepseek proposers ×4 + deepseek brain, collapse ON, reflection OFF.
3. **Latency includes local contention:** the agent semaphore (2 permits on this box) queues 2 of the 4 proposers, so swarm latency is realistic for THIS machine, not a lower bound.
4. The operator's production brain at measurement time (`meta-llama/llama-3.3-70b-instruct:free`) was returning `Provider returned error` on every call (OpenRouter free-tier), so both arms ran on deepseek. Free-tier brains are a reliability liability independent of this experiment.

## Reproduce

```bash
# throwaway server
mkdir -p /tmp/ab-data/settings && cp data/settings/settings.json /tmp/ab-data/settings/
ORCHESTRA_DATA_DIR=/tmp/ab-data ORCHESTRA_DISABLE_AUTH=true ORCHESTRA_BACKUP_DISABLED=true npx next dev -p 3001
# runs + judging (results land next to the scripts)
node scripts/moa-ab/run-ab.mjs
node scripts/moa-ab/judge.mjs
```

Raw per-run artifacts (`results.json`, `judge-report.json`) are throwaway session outputs — the numbers above are the durable record.
