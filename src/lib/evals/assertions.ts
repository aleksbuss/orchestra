/**
 * Assertion runners for the eval harness (PM #41). Pure functions —
 * each takes the agent response + an assertion spec, returns a result
 * with a human-readable reason on failure (so the operator can fix the
 * case or the prompt without re-reading source).
 */
import type {
  Assertion,
  AssertionResult,
  ContainsAssertion,
  MatchesAssertion,
  NotContainsAssertion,
} from "./types";

function runContains(
  response: string,
  spec: ContainsAssertion
): { passed: boolean; reason?: string } {
  const haystack = spec.case_insensitive !== false ? response.toLowerCase() : response;
  const needle = spec.case_insensitive !== false ? spec.value.toLowerCase() : spec.value;
  if (haystack.includes(needle)) {
    return { passed: true };
  }
  return {
    passed: false,
    reason: `expected response to contain ${JSON.stringify(spec.value)}${
      spec.case_insensitive !== false ? " (case-insensitive)" : " (case-sensitive)"
    } — not found`,
  };
}

function runNotContains(
  response: string,
  spec: NotContainsAssertion
): { passed: boolean; reason?: string } {
  const haystack = spec.case_insensitive !== false ? response.toLowerCase() : response;
  const needle = spec.case_insensitive !== false ? spec.value.toLowerCase() : spec.value;
  if (!haystack.includes(needle)) {
    return { passed: true };
  }
  return {
    passed: false,
    reason: `expected response NOT to contain ${JSON.stringify(spec.value)} — but it does`,
  };
}

function runMatches(
  response: string,
  spec: MatchesAssertion
): { passed: boolean; reason?: string } {
  let re: RegExp;
  try {
    re = new RegExp(spec.pattern, spec.flags ?? "i");
  } catch (err) {
    return {
      passed: false,
      reason: `invalid regex ${JSON.stringify(spec.pattern)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (re.test(response)) {
    return { passed: true };
  }
  return {
    passed: false,
    reason: `expected response to match /${spec.pattern}/${spec.flags ?? "i"} — no match`,
  };
}

/** Run a single assertion against the agent response. */
export function runAssertion(
  response: string,
  assertion: Assertion,
  index: number
): AssertionResult {
  let outcome: { passed: boolean; reason?: string };
  switch (assertion.type) {
    case "contains":
      outcome = runContains(response, assertion);
      break;
    case "not_contains":
      outcome = runNotContains(response, assertion);
      break;
    case "matches":
      outcome = runMatches(response, assertion);
      break;
    default:
      // Exhaustiveness check — if someone adds a new AssertionKind to the
      // type union without updating this switch, the compiler will surface
      // it via the `never` constraint.
      outcome = {
        passed: false,
        reason: `unknown assertion type: ${(assertion as { type: string }).type}`,
      };
  }
  return {
    index,
    type: assertion.type,
    passed: outcome.passed,
    reason: outcome.reason,
  };
}

/** Run every assertion in order. Returns the per-assertion results. */
export function runAllAssertions(
  response: string,
  assertions: Assertion[]
): AssertionResult[] {
  return assertions.map((a, i) => runAssertion(response, a, i));
}
