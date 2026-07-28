/**
 * Eval-case runner (PM #41).
 *
 * Responsibilities:
 *   1. Load + validate cases from `evals/cases/*.json`.
 *   2. For each case: either consume `mock_response` (unit-test path) OR
 *      invoke the real agent against the operator's configured provider.
 *   3. Run every assertion, collect per-assertion results.
 *   4. Return a structured suite result for CLI rendering / persistence.
 *
 * Real-agent invocation is dynamic-imported so the runner module stays
 * cheap to load for cases that use `mock_response` only. This matters
 * for the harness unit tests, which should NOT pull the full agent
 * runtime + LLM provider stack into the test bundle.
 */
import fs from "fs/promises";
import path from "path";
import type {
  Assertion,
  CaseAggregate,
  CaseResult,
  EvalCase,
  EvalSuiteResult,
} from "./types";
import { runAllAssertions } from "./assertions";
import { describeActiveEvalArms } from "@/lib/agent/eval-arms";

/** Telemetry a real-agent invocation reports alongside the answer text. */
interface AgentInvocation {
  answer: string;
  swarm?: import("@/lib/agent/eval-arms").EvalSwarmTelemetry;
  /** ms from invocation to the first TEXT delta on the wire (not the first byte). */
  ttftMs?: number;
  costUsd?: number;
  costFullyPriced?: boolean;
  promptTokens?: number;
  completionTokens?: number;
}

const CASES_DIR_DEFAULT = path.join(process.cwd(), "evals", "cases");

/**
 * Parse + validate a JSON case file. Throws with a descriptive error
 * the CLI surfaces instead of a stack trace.
 */
export function parseCaseFromJson(raw: string, sourcePath: string): EvalCase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${sourcePath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourcePath}: case must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) {
    throw new Error(`${sourcePath}: missing or empty "id" string`);
  }
  if (typeof obj.description !== "string" || !obj.description) {
    throw new Error(`${sourcePath}: missing or empty "description" string`);
  }
  if (!obj.input || typeof obj.input !== "object") {
    throw new Error(`${sourcePath}: missing "input" object`);
  }
  const input = obj.input as Record<string, unknown>;
  if (typeof input.message !== "string" || !input.message) {
    throw new Error(`${sourcePath}: missing or empty input.message`);
  }
  if (!Array.isArray(obj.assertions) || obj.assertions.length === 0) {
    throw new Error(`${sourcePath}: must declare at least one assertion`);
  }
  return parsed as EvalCase;
}

/** Load every `*.json` in CASES_DIR_DEFAULT (or a custom dir). */
export async function loadAllCases(
  casesDir: string = CASES_DIR_DEFAULT
): Promise<{ cases: EvalCase[]; errors: Array<{ file: string; error: string }> }> {
  const cases: EvalCase[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let files: string[];
  try {
    files = await fs.readdir(casesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { cases, errors };
    throw err;
  }
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(casesDir, file);
    try {
      const raw = await fs.readFile(full, "utf-8");
      cases.push(parseCaseFromJson(raw, full));
    } catch (err) {
      errors.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { cases, errors };
}

/**
 * Invoke the real agent for an eval case. Dynamically imports the agent
 * runtime so the runner module itself stays lightweight for unit tests.
 *
 * The flow mirrors what `POST /api/chat` does for the interactive path:
 *   - Create a fresh chat via chat-store (so the case is isolated)
 *   - Call runAgent with the case's input + settings
 *   - Wait for runAgent's stream to complete via onFinish
 *   - Pull the final assistant text out of `data/chats/<id>.json`
 *   - Optionally clean up the chat afterwards
 *
 * For v1 we keep this simple: synchronously call runAgent and consume
 * the StreamTextResult to drain it. The assertion runs against the
 * concatenated assistant text.
 */
async function invokeRealAgent(testCase: EvalCase): Promise<AgentInvocation> {
  // Late imports to keep the runner module light for unit tests.
  const [
    { runAgent },
    { createChat, getChat, deleteChat, flushAllPendingChats },
    crypto,
  ] = await Promise.all([
    import("@/lib/agent/agent"),
    import("@/lib/storage/chat-store"),
    import("node:crypto"),
  ]);

  const chatId = `eval-${testCase.id}-${crypto.randomUUID().slice(0, 8)}`;
  await createChat(chatId, `[eval] ${testCase.id}`);

  // Arm-level swarm override for the parallelism-vs-single A/B.
  // `ORCHESTRA_EVAL_SWARM_MODE` (dev-only, honored when NODE_ENV !== "production",
  // same posture as ORCHESTRA_EVAL_SKEPTIC_CONTROL) forces EVERY case into one arm
  // regardless of its declared swarmEnabled/forceSwarm — so the SAME hard cases
  // run both the swarm arm and the single-agent control without editing each file.
  //   "swarm"  → swarmEnabled + forceSwarm ON  (full MoA ensemble)
  //   "single" → swarmEnabled + forceSwarm OFF (single agent, no proposers)
  //   unset    → per-case fields (default; unchanged behavior)
  // An unknown value is validated + rejected loudly by the CLI (run-evals.ts).
  const armMode =
    process.env.NODE_ENV !== "production"
      ? process.env.ORCHESTRA_EVAL_SWARM_MODE
      : undefined;
  let swarmEnabled = testCase.input.swarmEnabled ?? false;
  let forceSwarm = testCase.input.forceSwarm ?? false;
  if (armMode === "swarm") {
    swarmEnabled = true;
    forceSwarm = true;
  } else if (armMode === "single") {
    swarmEnabled = false;
    forceSwarm = false;
  }

  const startedAt = Date.now();
  try {
    const result = await runAgent({
      chatId,
      userMessage: testCase.input.message,
      swarmEnabled,
      forceSwarm,
    });

    // Drain the stream by consuming the response. We only need the
    // final assistant text — which lands on disk via the agent's
    // onFinish hook before the stream closes.
    //
    // TTFT is measured to the first TEXT delta, not the first byte: the stream
    // opens with protocol/start frames that carry no answer, so first-byte
    // would flatter every arm equally but measure nothing the user perceives.
    // Note this clock starts BEFORE runAgent, so on a swarm turn it correctly
    // includes the whole MoA fan-out that precedes the brain's first token.
    let ttftMs: number | undefined;
    const response = result.toUIMessageStreamResponse({});
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttftMs === undefined && value) {
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.includes("text-delta") || chunk.includes('"type":"text"')) {
            ttftMs = Date.now() - startedAt;
          }
        }
      }
    }

    // Make sure the debounced chat-store write has flushed before we read.
    await flushAllPendingChats();

    const chat = await getChat(chatId);
    if (!chat) {
      throw new Error(`Chat ${chatId} disappeared after runAgent`);
    }
    // The chat is created fresh per case, so its cumulative usage IS this
    // turn's usage — including the MoA proposers, the Router and the judges.
    const usage = chat.cumulativeUsage;
    const { takeEvalSwarmTelemetry } = await import("@/lib/agent/eval-arms");
    return {
      answer: extractDeliveredAnswer(chat.messages),
      swarm: takeEvalSwarmTelemetry(chatId),
      ttftMs,
      costUsd: usage?.costUsd,
      costFullyPriced: usage?.fullyPriced,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
    };
  } finally {
    // Best-effort cleanup; ignore failures.
    try {
      await deleteChat(chatId);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Pull the answer the agent actually DELIVERED out of a persisted chat.
 *
 * MEASUREMENT BUG THIS FIXES (2026-07-26): the old extraction was "last
 * assistant message wins", which silently scored a delivered answer as EMPTY
 * whenever the model answered through the `response` tool (PM #61's delivery
 * path). In that shape the last assistant message is the tool-CALL carrier with
 * `content: ""`, and the answer text lives in the following `role: "tool"`
 * message. Two cases in a live free-tier run were recorded as delivery failures
 * while their chats on disk held 101- and 780-character answers — so the eval
 * was measuring its own extraction, not the agent's delivery, and any
 * "delivery rate" derived from it was partly an artifact.
 *
 * Order: the last `response`-tool result (the explicit final-answer channel),
 * else the last assistant message with non-empty text. Anything else is a
 * genuine non-delivery.
 */
export function extractDeliveredAnswer(
  messages: Array<{ role: string; content?: unknown; toolName?: string }>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.toolName === "response") {
      const text = typeof m.content === "string" ? m.content.trim() : "";
      if (text) return text;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content.trim() : "";
      if (text) return text;
    }
  }
  return "";
}

/**
 * Run a single case. Either uses `mock_response` (deterministic, no LLM
 * cost) or invokes the real agent. Returns a structured result with
 * per-assertion outcomes and a duration.
 */
export async function runCase(
  testCase: EvalCase,
  options: { useRealAgent?: boolean; repeatIndex?: number } = {}
): Promise<CaseResult> {
  const start = Date.now();
  try {
    // Precedence: --real (useRealAgent) OVERRIDES any recorded mock_response,
    // so `npm run evals -- --real` exercises the real model even on cases that
    // ship a mock for CI. Before, `mock_response !== undefined` short-circuited
    // first, so --real silently re-scored the hand-written mock and never hit a
    // real model. Mock is the fallback when real is not enabled.
    const invocation: AgentInvocation = options.useRealAgent
      ? await invokeRealAgent(testCase)
      : {
          answer:
            testCase.mock_response !== undefined
              ? testCase.mock_response
              : "", // no mock, real not enabled — return empty (operator chose this)
        };
    const response = invocation.answer;

    const specs = testCase.assertions as Assertion[];
    const assertions = runAllAssertions(response, specs);

    // Judge assertions are async (LLM call) — score them here under --real,
    // overwriting the SKIPPED slots the sync pass left. In mock mode they stay
    // skipped (no token cost in CI).
    if (options.useRealAgent && specs.some((a) => a.type === "judge")) {
      const { judgeResponse } = await import("./judge");
      const { scoreJudgeAssertion } = await import("./assertions");
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        if (spec.type === "judge") {
          assertions[i] = await scoreJudgeAssertion(response, spec, i, judgeResponse);
        }
      }
    }

    // A skipped assertion (judge in mock mode) does not count against the case.
    const passed = assertions.every((a) => a.skipped || a.passed);
    // F3 — a case whose assertions ALL skipped (judge-only, mock mode) "passes"
    // without verifying anything. Flag it so the CLI can surface the vacuous pass
    // instead of it hiding as green.
    const vacuous = assertions.length > 0 && assertions.every((a) => a.skipped);
    // An empty real-agent response is a DELIVERY failure (no answer), NOT a
    // reasoning failure — flag it so A/B analysis separates the two. Scoring an
    // empty as a plain FAIL once produced a false swarm-vs-single capability Δ
    // that was really a delivery-reliability difference.
    const noAnswer = !!options.useRealAgent && response.trim() === "";

    // Continuous score: fraction of SCORABLE assertions satisfied. Skipped
    // assertions (judge in mock mode) leave the denominator, so a vacuous case
    // scores 0 rather than a misleading 1.
    const scorable = assertions.filter((a) => !a.skipped);
    const constraintsPassed = scorable.filter((a) => a.passed).length;
    const constraintsTotal = scorable.length;

    return {
      id: testCase.id,
      description: testCase.description,
      tags: testCase.tags ?? [],
      passed,
      durationMs: Date.now() - start,
      response,
      assertions,
      score: constraintsTotal === 0 ? 0 : constraintsPassed / constraintsTotal,
      constraintsPassed,
      constraintsTotal,
      ...(options.repeatIndex ? { repeatIndex: options.repeatIndex } : {}),
      ...(vacuous ? { vacuous: true } : {}),
      ...(noAnswer ? { noAnswer: true } : {}),
      ...(invocation.swarm ? { swarm: summarizeSwarm(invocation.swarm, specs) } : {}),
      ...(invocation.ttftMs !== undefined ? { ttftMs: invocation.ttftMs } : {}),
      ...(invocation.costUsd !== undefined
        ? {
            costUsd: invocation.costUsd,
            costFullyPriced: invocation.costFullyPriced,
            promptTokens: invocation.promptTokens,
            completionTokens: invocation.completionTokens,
          }
        : {}),
    };
  } catch (err) {
    return {
      id: testCase.id,
      description: testCase.description,
      tags: testCase.tags ?? [],
      passed: false,
      durationMs: Date.now() - start,
      response: "",
      assertions: [],
      score: 0,
      constraintsPassed: 0,
      constraintsTotal: 0,
      ...(options.repeatIndex ? { repeatIndex: options.repeatIndex } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Score each proposer draft with the case's OWN assertions and summarize the
 * ensemble.
 *
 * Scoring the drafts is the whole point of the disagreement experiment: the
 * final answer alone cannot distinguish "the proposers were right and agreed"
 * from "they were wrong and agreed", and those have opposite implications for
 * whether disagreement is worth routing on.
 */
export function summarizeSwarm(
  telemetry: import("@/lib/agent/eval-arms").EvalSwarmTelemetry,
  specs: Assertion[]
): NonNullable<CaseResult["swarm"]> {
  const drafts = telemetry.drafts.map((d) => {
    const results = runAllAssertions(d.text, specs);
    const scorable = results.filter((r) => !r.skipped);
    const passed = scorable.filter((r) => r.passed).length;
    return {
      proposerId: d.proposerId,
      role: d.role,
      provider: d.provider,
      model: d.model,
      tier: d.tier,
      latencyMs: d.latencyMs,
      score: scorable.length === 0 ? 0 : passed / scorable.length,
      correct: scorable.length > 0 && passed === scorable.length,
      chars: d.text.length,
    };
  });
  return {
    disagreementDetected: telemetry.disagreement.detected,
    disagreementMaxDistance: telemetry.disagreement.maxDistance,
    disagreementAverageDistance: telemetry.disagreement.averageDistance,
    disagreementPairCount: telemetry.disagreement.pairCount,
    disagreementThreshold: telemetry.disagreement.threshold,
    disagreementRan: telemetry.disagreement.ranSuccessfully,
    distinctModels: new Set(drafts.map((d) => `${d.provider}/${d.model}`)).size,
    drafts,
  };
}

/**
 * Run every loaded case. Optional `filter` lets the CLI restrict by
 * tag or substring on id. Optional `useRealAgent` controls whether
 * cases without `mock_response` actually call the LLM (the default
 * is false so accidental `npm test` runs don't burn tokens).
 */
export async function runSuite(
  cases: EvalCase[],
  options: {
    useRealAgent?: boolean;
    filter?: { tag?: string; idPrefix?: string };
    /**
     * Run each case N times (default 1). Repeats are the only defence against
     * the run-to-run variance that dominated every earlier A/B — two runs of
     * the SAME build scored 5/6 and 3/6. Without repeats a single number is
     * indistinguishable from noise.
     */
    repeat?: number;
    /** Called after each run so a long real-agent suite reports progress live. */
    onResult?: (result: CaseResult, index: number, total: number) => void;
  } = {}
): Promise<EvalSuiteResult> {
  const startedAt = new Date().toISOString();
  const repeats = Math.max(1, Math.floor(options.repeat ?? 1));
  const filtered = cases.filter((c) => {
    if (options.filter?.tag && !(c.tags ?? []).includes(options.filter.tag)) {
      return false;
    }
    if (options.filter?.idPrefix && !c.id.startsWith(options.filter.idPrefix)) {
      return false;
    }
    return true;
  });

  const results: CaseResult[] = [];
  const total = filtered.length * repeats;
  // Repeat-major order (all cases once, then again): an interleaved schedule
  // spreads each case's repeats across the run, so a mid-run change in upstream
  // conditions (rate limiting, a throttled endpoint warming up) hits every case
  // rather than concentrating in whichever case happened to run then.
  for (let r = 1; r <= repeats; r++) {
    for (const c of filtered) {
      const result = await runCase(c, {
        useRealAgent: options.useRealAgent,
        ...(repeats > 1 ? { repeatIndex: r } : {}),
      });
      results.push(result);
      options.onResult?.(result, results.length, total);
    }
  }

  const withTtft = results.filter((r) => typeof r.ttftMs === "number");
  const priced = results.filter((r) => typeof r.costUsd === "number");

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    totalCases: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed && !r.error).length,
    errored: results.filter((r) => !!r.error).length,
    vacuous: results.filter((r) => r.vacuous).length,
    noAnswer: results.filter((r) => r.noAnswer).length,
    meanScore: mean(results.map((r) => r.score)),
    repeats,
    arms: describeActiveEvalArms(),
    totalCostUsd: priced.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    costFullyPriced: priced.every((r) => r.costFullyPriced !== false),
    meanDurationMs: mean(results.map((r) => r.durationMs)),
    meanTtftMs: withTtft.length === 0 ? null : mean(withTtft.map((r) => r.ttftMs!)),
    cases: results,
    aggregates: aggregateByCase(results),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Collapse every repeat of a case into one row. `scores` is kept verbatim so a
 * paired bootstrap across arms can be run offline from the results JSON —
 * the aggregate means alone would not support a paired test.
 */
export function aggregateByCase(results: CaseResult[]): CaseAggregate[] {
  const byId = new Map<string, CaseResult[]>();
  for (const r of results) {
    const bucket = byId.get(r.id);
    if (bucket) bucket.push(r);
    else byId.set(r.id, [r]);
  }
  return [...byId.entries()].map(([id, runs]) => ({
    id,
    runs: runs.length,
    meanScore: mean(runs.map((r) => r.score)),
    scores: runs.map((r) => r.score),
    passRate: runs.filter((r) => r.passed).length / runs.length,
    meanDurationMs: mean(runs.map((r) => r.durationMs)),
    noAnswerCount: runs.filter((r) => r.noAnswer).length,
  }));
}
