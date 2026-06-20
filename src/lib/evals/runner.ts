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
  CaseResult,
  EvalCase,
  EvalSuiteResult,
} from "./types";
import { runAllAssertions } from "./assertions";

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
async function invokeRealAgent(testCase: EvalCase): Promise<string> {
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

  try {
    const result = await runAgent({
      chatId,
      userMessage: testCase.input.message,
      swarmEnabled: testCase.input.swarmEnabled ?? false,
      forceSwarm: testCase.input.forceSwarm ?? false,
    });

    // Drain the stream by consuming the response. We only need the
    // final assistant text — which lands on disk via the agent's
    // onFinish hook before the stream closes.
    const response = result.toUIMessageStreamResponse({});
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Make sure the debounced chat-store write has flushed before we read.
    await flushAllPendingChats();

    const chat = await getChat(chatId);
    if (!chat) {
      throw new Error(`Chat ${chatId} disappeared after runAgent`);
    }
    // Last assistant message wins. Concatenate text content.
    const lastAssistant = [...chat.messages].reverse().find(
      (m) => m.role === "assistant"
    );
    return typeof lastAssistant?.content === "string" ? lastAssistant.content : "";
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
 * Run a single case. Either uses `mock_response` (deterministic, no LLM
 * cost) or invokes the real agent. Returns a structured result with
 * per-assertion outcomes and a duration.
 */
export async function runCase(
  testCase: EvalCase,
  options: { useRealAgent?: boolean } = {}
): Promise<CaseResult> {
  const start = Date.now();
  try {
    const response = testCase.mock_response !== undefined
      ? testCase.mock_response
      : options.useRealAgent
        ? await invokeRealAgent(testCase)
        : ""; // no mock, real not enabled — return empty (operator chose this)

    const assertions = runAllAssertions(response, testCase.assertions as Assertion[]);
    const passed = assertions.every((a) => a.passed);

    return {
      id: testCase.id,
      description: testCase.description,
      tags: testCase.tags ?? [],
      passed,
      durationMs: Date.now() - start,
      response,
      assertions,
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
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
  } = {}
): Promise<EvalSuiteResult> {
  const startedAt = new Date().toISOString();
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
  for (const c of filtered) {
    results.push(await runCase(c, { useRealAgent: options.useRealAgent }));
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    totalCases: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed && !r.error).length,
    errored: results.filter((r) => !!r.error).length,
    cases: results,
  };
}
