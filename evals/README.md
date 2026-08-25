# Orchestra Eval Suite (PM #41)

Assertion-based regression suite for Orchestra's MoA pipeline. The harness gives every prompt + architecture change a concrete pass/fail signal instead of relying on "vibes" — without this, the PM #36–#40 improvements are unmeasurable.

## Run it

```bash
# Mock-only mode — runs every case with mock_response, zero LLM cost.
# Goes in `npm test`-shape: deterministic, fast (~ms per case).
npm run evals

# Real-agent mode — invokes the real LLM via your configured provider.
# Use sparingly; consumes tokens.
npm run evals -- --real

# Filter by tag or id prefix
npm run evals -- --tag skeptic
npm run evals -- --case 01

# JSON output for piping
npm run evals -- --json
```

## What mock mode can and cannot score

A case is only scorable offline if it carries a recorded `mock_response`. The suite
reports three categories so a partial run can never be read as a full one:

| Category | Meaning | Counts toward pass/fail? |
|---|---|---|
| **verified** | Has a `mock_response` and at least one non-`judge` assertion — actually checked. | yes |
| **vacuous** | Has a `mock_response`, but every assertion is `judge`, which needs an LLM. Passes without checking anything. | passes, but flagged |
| **skipped** | No `mock_response`. Mock mode cannot score it, so it is **not run** — these are the real-agent-only families (`hard-*`, `audit-*`, `selection-*`, `multi-constraint-*`, `agentic-*`). | no — excluded entirely |

Skipped cases used to be run anyway: the runner fed their assertions its own
empty-string placeholder and recorded each as a **failure**, which made
`npm run evals` permanently exit 1 while verifying nothing extra. They are now
excluded from `totalCases`, `meanScore` and the pass/fail counts.

`complete: false` in the results JSON means something was skipped or vacuous. A
green exit with `complete: false` means *"nothing that ran failed"*, not *"the
suite verified everything"*.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every case that ran passed, and at least one was actually verified |
| `1` | One or more cases failed — **or** zero cases were verified (everything vacuous/skipped) |
| `2` | One or more case files failed to parse / load |
| `3` | The configured chat model changed mid-run (results not comparable) |

## Adding a case

Every case is one JSON file under `cases/`. The filename should match the `id` field. Minimal shape:

```json
{
  "id": "11-my-case",
  "description": "One-line human-readable purpose",
  "tags": ["moa", "reflection"],
  "input": {
    "message": "User prompt the agent receives",
    "swarmEnabled": true,
    "forceSwarm": true
  },
  "mock_response": "Pre-recorded response to score (omit to require --real)",
  "assertions": [
    { "type": "contains", "value": "expected substring" },
    { "type": "not_contains", "value": "forbidden phrase" },
    { "type": "matches", "pattern": "regex.*pattern", "flags": "i" }
  ]
}
```

### Assertion types

| Type | Spec | Notes |
|---|---|---|
| `contains` | `value: string`, `case_insensitive?: boolean` (default true) | Plain substring search |
| `not_contains` | `value: string`, `case_insensitive?: boolean` | Inverse of contains |
| `matches` | `pattern: string`, `flags?: string` (default `"i"`) | Regex source + flags |

LLM-as-judge assertion (`type: "llm_judge"`) is on the v2 roadmap. v1 stays free of LLM cost in the runner itself.

### Tags conventions

- `moa` — exercises the MoA pipeline
- `skeptic`, `reflection`, `disagreement` — specific Phase 2 features (PM #37, #38, #39)
- `aggregator` — assertion against synthesizer behavior
- `safety`, `refusal` — agent refusal patterns (medical, financial, legal)
- `code` — code-generation cases
- `i18n` — language-mirroring cases
- `security` — prompt-injection / untrusted-content cases
- `smoke` — minimal real-agent invocation cases (no mock_response)

## Results

Every run writes a structured JSON file to `evals/results/<timestamp>.json`. Diff successive runs to track regressions:

```bash
# Last two runs
ls -t evals/results/ | head -2 | tac | xargs -I{} jq '.passed, .failed' evals/results/{}
```

## How this is wired

| Module | Purpose |
|---|---|
| `src/lib/evals/types.ts` | `EvalCase`, `Assertion`, `CaseResult`, `EvalSuiteResult` types |
| `src/lib/evals/assertions.ts` | `runAssertion` / `runAllAssertions` — pure functions, no I/O |
| `src/lib/evals/runner.ts` | `parseCaseFromJson`, `loadAllCases`, `runCase`, `runSuite` — orchestration |
| `scripts/run-evals.ts` | CLI entry point (`npm run evals`) |
| `evals/cases/*.json` | The actual test cases |
| `evals/results/*.json` | Per-run output (gitignored — see `.gitignore`) |

## What this is NOT

- **Not a replacement for `npm test`.** Unit tests cover code correctness (algorithm, edge cases, regressions). Evals cover *behavioral* correctness of the agent (does the right answer come out for a given prompt + settings).
- **Not a benchmark.** No accuracy/F1 metrics, no leaderboard. Pass/fail per case.
- **Not enforcement.** A failing eval doesn't block deploy — it's a signal to investigate. The operator decides if the failure is a regression or an expected behavior change.
