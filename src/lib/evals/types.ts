/**
 * Eval harness types (PM #41). Cases are JSON files under `evals/cases/`.
 *
 * Design constraints:
 *   - Zero new dependencies (no js-yaml etc.) — JSON keeps the surface tight.
 *   - Cases are operator-readable AND machine-parseable.
 *   - Runner can either invoke the real agent (operator API key required)
 *     OR consume a pre-recorded `mock_response` (for testing the harness
 *     itself in CI without burning tokens).
 *   - Assertion types are deliberately minimal in v1 (string-shape only).
 *     LLM-as-judge is on the roadmap for v2 — keeps v1 free of LLM cost
 *     in the runner itself.
 */

export type AssertionKind = "contains" | "not_contains" | "matches" | "judge";

export interface ContainsAssertion {
  type: "contains";
  /** Substring that MUST appear in the agent response. */
  value: string;
  /** Default true. When false, the match is case-sensitive. */
  case_insensitive?: boolean;
}

export interface NotContainsAssertion {
  type: "not_contains";
  /** Substring that MUST NOT appear in the agent response. */
  value: string;
  case_insensitive?: boolean;
}

export interface MatchesAssertion {
  type: "matches";
  /** Regex pattern (as a string) the response must match somewhere. */
  pattern: string;
  /** Regex flags. Default "i" (case-insensitive). */
  flags?: string;
}

export interface JudgeAssertion {
  type: "judge";
  /**
   * A yes/no rubric an LLM judge answers about the response. PASS = the
   * response satisfies the rubric. Semantic + format-insensitive: unlike
   * `contains`/`matches`, a correct answer wrapped in markdown or phrased
   * differently still passes. Requires `--real` (the judge calls a model);
   * in mock-only mode the assertion is SKIPPED, not scored.
   */
  rubric: string;
}

export type Assertion =
  | ContainsAssertion
  | NotContainsAssertion
  | MatchesAssertion
  | JudgeAssertion;

export interface EvalCase {
  /** Stable id used in result files and CLI filters. Match the filename. */
  id: string;
  /** One-line human description of what is being tested. */
  description: string;
  /** Tags for filtering: ["moa", "skeptic", "reflection", "code", etc.] */
  tags?: string[];
  /** Test input fed to the agent. */
  input: {
    /** The user message. */
    message: string;
    /** When true, Swarm mode is forced ON for this case (overrides the user's UI setting). */
    swarmEnabled?: boolean;
    /** When true, force-swarm overrides the Router bypass decision. */
    forceSwarm?: boolean;
  };
  /**
   * Optional pre-recorded response. When set, the runner skips runAgent
   * entirely and runs the assertions against this string. Useful for
   * (a) unit-testing the harness without an LLM and (b) replaying a
   * known-good response to verify assertion stability.
   */
  mock_response?: string;
  /** Assertions all run; case passes only if every assertion passes. */
  assertions: Assertion[];
}

export interface AssertionResult {
  index: number;
  type: AssertionKind;
  passed: boolean;
  /**
   * True when the assertion was not actually scored (e.g. a `judge` assertion
   * in mock-only mode, where no judge model is available). A skipped assertion
   * does NOT count against the case's pass/fail.
   */
  skipped?: boolean;
  /** Human-readable reason when failed (e.g., "expected to contain 'Canberra'"). */
  reason?: string;
}

export interface CaseResult {
  id: string;
  description: string;
  tags: string[];
  passed: boolean;
  /** ms wall-clock from invocation to last assertion. */
  durationMs: number;
  /** Response that was scored (either real or mock). */
  response: string;
  assertions: AssertionResult[];
  /** Set when the case errored before assertions could run (case parse failed, agent threw, etc.). */
  error?: string;
  /**
   * F3 — true when EVERY assertion was skipped (e.g. a judge-only case run in
   * mock mode, where the judge cannot execute). Such a case reports `passed:true`
   * vacuously — nothing was actually verified. The flag lets the CLI surface it
   * so a broken judge-only case can't hide as a green pass in CI.
   */
  vacuous?: boolean;
  /**
   * True when the real agent returned an EMPTY response (no answer delivered) —
   * a DELIVERY failure (timeout / degraded swarm / silent orchestrator spin),
   * NOT a reasoning failure. Distinguishing the two is load-bearing: an A/B that
   * scores an empty response as a plain assertion FAIL conflates "the system
   * didn't answer" with "the system answered wrong", which produced a false
   * capability signal (a swarm-vs-single Δ that was really a delivery-reliability
   * difference). Analysis MUST separate no-answer from delivered-but-wrong.
   */
  noAnswer?: boolean;
  /**
   * CONTINUOUS score in [0,1]: the fraction of SCORABLE assertions that passed
   * (`constraintsPassed / constraintsTotal`). Binary pass/fail throws away most
   * of the signal on a multi-constraint case — "5 of 6 constraints satisfied"
   * and "0 of 6" are both `passed: false` — which is why earlier A/Bs needed an
   * unreachable N to detect anything. Skipped assertions are excluded from the
   * denominator; a case with nothing scorable (all skipped, or an error before
   * assertions ran) scores 0 and is flagged `vacuous` / `error` respectively.
   */
  score: number;
  /** Assertions that passed (excludes skipped). */
  constraintsPassed: number;
  /** Assertions actually scored (excludes skipped). Denominator of `score`. */
  constraintsTotal: number;
  /** 1-based repeat index when `--repeat N` re-runs the same case. */
  repeatIndex?: number;
  /**
   * Time-to-first-token in ms (real-agent runs only). Selection aggregators
   * cannot stream a winner that has not been picked yet, so TTFT is the metric
   * that exposes what a tournament arm costs the user perceptually — a fact a
   * pass-rate table hides entirely.
   */
  ttftMs?: number;
  /** Chat cumulative cost in USD after the turn (real-agent runs only). */
  costUsd?: number;
  /** False when at least one LLM call in the turn had no pricing entry. */
  costFullyPriced?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  /**
   * MoA internals for the disagreement experiment (only when
   * `ORCHESTRA_EVAL_CAPTURE_SWARM=true`). Each draft is scored with the SAME
   * assertions as the final answer, so "were the proposers right?" and "did they
   * disagree?" can be crossed against "was the final answer right?".
   *
   * `distinctModels` is the heterogeneity check: with N personas mapped onto
   * three tiers, two personas can land on the same tier and hand you one model
   * twice while the settings still look heterogeneous. Reading it from the
   * RESOLVED per-draft model makes that visible instead of assumed.
   */
  swarm?: {
    disagreementDetected: boolean;
    disagreementMaxDistance: number;
    disagreementAverageDistance: number;
    disagreementPairCount: number;
    disagreementThreshold: number;
    disagreementRan: boolean;
    distinctModels: number;
    drafts: Array<{
      proposerId: string;
      role: string;
      provider: string;
      model: string;
      tier?: string;
      latencyMs: number;
      /** Continuous score of THIS draft under the case's assertions. */
      score: number;
      /** True when the draft satisfied every scorable assertion. */
      correct: boolean;
      chars: number;
    }>;
  };
}

/** Per-case aggregate across `--repeat` runs. */
export interface CaseAggregate {
  id: string;
  runs: number;
  /** Mean continuous score across repeats — the primary per-case statistic. */
  meanScore: number;
  /** Every repeat's score, so a bootstrap / paired test can be run offline. */
  scores: number[];
  /** Fraction of repeats where every assertion passed (the old binary metric). */
  passRate: number;
  meanDurationMs: number;
  noAnswerCount: number;
}

export interface EvalSuiteResult {
  startedAt: string;
  finishedAt: string;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  /** F3 — count of cases that passed vacuously (all assertions skipped). Subset of `passed`. */
  vacuous: number;
  /** Count of real-agent cases that returned an empty response (delivery failure, not reasoning). */
  noAnswer: number;
  /**
   * Mean of every run's continuous `score` — the experiment's PRIMARY metric.
   * Reported alongside the binary pass count, never instead of it.
   */
  meanScore: number;
  /** How many times each case was run (`--repeat`, default 1). */
  repeats: number;
  /**
   * Active eval-arm flags (`aggregator=tournament prompts=identical`) or null
   * when none are set. Stamped into the results file so an arm can never be
   * mislabeled after the fact — the single most expensive mistake in an A/B.
   */
  arms: string | null;
  /** Summed chat cost across every real-agent run in the suite, USD. */
  totalCostUsd: number;
  /** False when any run had an unpriced LLM call (so the total is a LOWER bound). */
  costFullyPriced: boolean;
  meanDurationMs: number;
  /** Mean TTFT across runs that reported one; null when no real-agent run did. */
  meanTtftMs: number | null;
  cases: CaseResult[];
  /** One entry per distinct case id, aggregating its repeats. */
  aggregates: CaseAggregate[];
}
