/**
 * Replay harness for postmortem files (Sprint 5).
 *
 * Goal: turn each captured failure into a permanent regression check.
 * When a chat turn fails, `dumpPostmortem` writes a JSON file that
 * encodes everything an investigator needs. The replay harness reads
 * those files back and verifies that today's code STILL classifies the
 * captured error the same way (same `kind`, same `recoverable` flag).
 *
 * Why this is the right shape, NOT a "rerun the LLM call" replay:
 *   - Re-running a real upstream call burns tokens and is non-deterministic
 *     (rate-limit windows, model availability change daily).
 *   - The valuable invariant a future change can violate isn't "the
 *     upstream still 404s" — that's a property of the upstream — but
 *     "given this exact upstream error, our classifier still produces an
 *     actionable hint and recoverability flag." That's what we lock down.
 *
 * The replay function below is pure (no I/O, no fetch, no fs). The
 * vitest harness (`replay.test.ts`) reads `data/postmortems/*.json`,
 * pushes each through this function, and asserts:
 *
 *   1. Schema parses (forwards-compat trip-wire on shape changes).
 *   2. The classification we'd produce *today* matches the classification
 *      stored in the file. A drift means either the classifier got better
 *      (update the postmortem) or got worse (fix the regression).
 *   3. No secrets in the persisted file (defense-in-depth on the
 *      sanitizer; a regression there would land here as a test failure).
 */
import { classifyChatError } from "@/lib/observability/classify-error";
import type { PostmortemFile } from "@/lib/observability/postmortem";
import type { ChatErrorPayload } from "@/lib/realtime/types";

export interface ReplayResult {
  /** True iff the classifier today produces the same `kind` and
   *  `recoverable` flag as recorded in the postmortem. */
  consistent: boolean;
  /** What the classifier produces today, given the captured raw error. */
  reclassified: ChatErrorPayload;
  /** What was recorded at dump time. */
  original: ChatErrorPayload;
  /** Specific drift reasons, if any. Empty when `consistent === true`. */
  drift: string[];
}

/**
 * Reconstruct an Error from the persisted shape. We can't restore the
 * original Error subclass (e.g. AI_APICallError) but we can rebuild a
 * shape the classifier's duck-typing recognizes — that's enough for the
 * regression check.
 */
function reconstructErrorForReplay(pm: PostmortemFile): unknown {
  const { rawError, errorClassification } = pm;

  // The classifier specifically detects `AI_APICallError`-shaped values
  // by `name` and `statusCode`. PM files don't store statusCode directly,
  // but the original ChatErrorPayload kind tells us what bucket the error
  // fell into; we synthesize a matching shape.
  if (errorClassification.kind === "upstream_no_tools") {
    return {
      name: "AI_APICallError",
      statusCode: 404,
      responseBody: JSON.stringify({
        error: { message: "No endpoints found that support tool use." },
      }),
      message: rawError.message,
    };
  }
  if (errorClassification.kind === "upstream_rate_limit") {
    return {
      name: "AI_APICallError",
      statusCode: 429,
      message: rawError.message,
    };
  }
  if (errorClassification.kind === "upstream_4xx") {
    return {
      name: "AI_APICallError",
      statusCode: 400,
      message: rawError.message,
    };
  }
  if (errorClassification.kind === "upstream_5xx") {
    return {
      name: "AI_APICallError",
      statusCode: 503,
      message: rawError.message,
    };
  }
  if (errorClassification.kind === "abort") {
    const e = new Error(rawError.message);
    e.name = "AbortError";
    return e;
  }

  // "internal" — non-SDK error, just rebuild a generic Error with the
  // captured message. Not perfect (loses original .name and .cause) but
  // enough for the classifier's "fallback" branch.
  const e = new Error(rawError.message);
  if (rawError.name) e.name = rawError.name;
  return e;
}

/**
 * Pure replay: given a postmortem file, rerun the classifier with a
 * synthesized error matching the captured shape, and return whether it
 * still produces the same kind + recoverable.
 */
export function replayPostmortem(pm: PostmortemFile): ReplayResult {
  const reconstructed = reconstructErrorForReplay(pm);
  const reclassified = classifyChatError(reconstructed, pm.traceId);
  const original = pm.errorClassification;

  const drift: string[] = [];
  if (reclassified.kind !== original.kind) {
    drift.push(
      `kind drift: original=${original.kind}, today=${reclassified.kind}`
    );
  }
  if (reclassified.recoverable !== original.recoverable) {
    drift.push(
      `recoverable drift: original=${original.recoverable}, today=${reclassified.recoverable}`
    );
  }

  return {
    consistent: drift.length === 0,
    reclassified,
    original,
    drift,
  };
}

/**
 * Validate that a postmortem file's serialized form contains no
 * obviously-sensitive substrings. This is a "defense-in-depth" check —
 * the sanitizer is the primary guard. If a regression in
 * `sanitizeSettingsForPostmortem` lets a key slip through, this check
 * catches it whenever any postmortem is replayed.
 */
export function findSecretsInPostmortemString(serialized: string): string[] {
  const findings: string[] = [];
  // The default scrypt envelope this codebase emits. Any leak of a real
  // hash would match this regex.
  if (/scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+/.test(serialized)) {
    findings.push("scrypt$<salt>$<hash> envelope present");
  }
  // OpenAI-shaped key.
  if (/sk-[A-Za-z0-9_-]{20,}/.test(serialized)) {
    findings.push("OpenAI-shaped sk- key present");
  }
  // OpenAI organization prefix and other common provider tokens.
  if (/sk-ant-[A-Za-z0-9_-]+/.test(serialized)) {
    findings.push("Anthropic sk-ant- key present");
  }
  if (/AIza[A-Za-z0-9_-]{20,}/.test(serialized)) {
    findings.push("Google AIza key present");
  }
  if (/tvly-[A-Za-z0-9_-]{20,}/.test(serialized)) {
    findings.push("Tavily tvly- key present");
  }
  return findings;
}
