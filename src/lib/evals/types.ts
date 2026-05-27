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

export type AssertionKind = "contains" | "not_contains" | "matches";

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

export type Assertion =
  | ContainsAssertion
  | NotContainsAssertion
  | MatchesAssertion;

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
}

export interface EvalSuiteResult {
  startedAt: string;
  finishedAt: string;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  cases: CaseResult[];
}
