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
  cases: CaseResult[];
}
