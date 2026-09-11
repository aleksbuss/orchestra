/**
 * Comprehensive verification script for Orchestra failover & recovery hardening.
 *
 * Runs each scenario, captures logs, inspects disk and memory state,
 * and asserts that every component behaves as designed.
 */

import fsSync from "fs";
import {
  resetModelHealth,
  recordModelFailure,
  isModelCircuitOpen,
  getModelHealthCachePath,
  setModelHealthHydrated,
  getModelHealthSnapshot,
  persistModelHealth,
} from "../src/lib/agent/model-health";
import {
  stitchContinuation,
  PARTIAL_TEXT_REPLACEMENT_THRESHOLD_CHARS,
} from "../src/lib/agent/primary-stream-recovery";
import {
  fallbackAttemptDeadlineMs,
  cascadeBudgetMs,
} from "../src/lib/agent/final-answer-failover";
import { toolRetryDeadlineMs } from "../src/lib/agent/tool-capable-retry";
import {
  isGeneralChatModel,
  isHarnessGatedModel,
  selectFreeModels,
} from "../src/lib/agent/free-mode";

interface CheckResult {
  step: string;
  passed: boolean;
  details: string;
}

const results: CheckResult[] = [];

function check(step: string, condition: boolean, details: string) {
  results.push({ step, passed: condition, details });
  const icon = condition ? "✅ PASS" : "❌ FAIL";
  console.log(`${icon} | ${step}: ${details}`);
  if (!condition) {
    throw new Error(`Verification failed at step: "${step}" — ${details}`);
  }
}

async function run() {
  console.log("================================================================================");
  console.log("🚀 STARTING ORCHESTRA FAILOVER & RECOVERY HARDENING VERIFICATION");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. Model Health: Disk Persistence & Trailing Flush Loop
  // ---------------------------------------------------------------------------
  console.log("--- 1. Testing Model Health: Disk Persistence & Trailing Flush ---");
  resetModelHealth();
  const cachePath = getModelHealthCachePath();
  check("Clean state", !fsSync.existsSync(cachePath), "Cache file does not exist after reset");

  // Simulate rapid-fire failures
  const testProvider = "openrouter";
  const testModel = "vendor/rapid-fail:free";

  console.log("Recording 3 consecutive failures in rapid succession...");
  recordModelFailure(testProvider, testModel, "throttle");
  recordModelFailure(testProvider, testModel, "throttle");
  recordModelFailure(testProvider, testModel, "throttle");

  check("Circuit Tripped in Memory", isModelCircuitOpen(testProvider, testModel), "Circuit is OPEN after 3 failures");

  // Give trailing flush loop time to settle to disk
  await new Promise((r) => setTimeout(r, 200));

  check("Disk File Created", fsSync.existsSync(cachePath), `File exists at ${cachePath}`);
  const diskData = JSON.parse(fsSync.readFileSync(cachePath, "utf-8"));
  const entryKey = `${testProvider}/${testModel}`;
  const diskEntry = diskData.entries[entryKey];

  check(
    "Disk State Integrity",
    diskEntry && diskEntry.consecutiveFailures === 3 && diskEntry.openedAt !== null,
    `Persisted consecutiveFailures=${diskEntry?.consecutiveFailures}, openedAt=${diskEntry?.openedAt}`
  );

  // ---------------------------------------------------------------------------
  // 2. Sub-Threshold Failure Preservation Across Cold Boot
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Testing Sub-Threshold Failure Preservation (Cold Boot) ---");
  const subModel = "vendor/sub-threshold:free";
  // Record 2 failures (threshold is 3)
  recordModelFailure(testProvider, subModel, "empty");
  recordModelFailure(testProvider, subModel, "empty");

  check("Sub-threshold Circuit Closed", !isModelCircuitOpen(testProvider, subModel), "Circuit is CLOSED at 2/3 failures");

  // Flush to disk
  await persistModelHealth();

  // Simulate process death / cold restart by clearing in-memory globalThis state
  console.log("Simulating server cold restart (clearing memory)...");
  const g = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>;
  g[Symbol.for("orchestra.model-health.store")]?.clear();
  setModelHealthHydrated(false);

  // Read back - lazy re-hydration on access
  console.log("Accessing store on cold boot to trigger disk hydration...");
  const snapshotBefore3rd = getModelHealthSnapshot().find((e) => e.model === subModel);
  check(
    "Sub-threshold Preserved",
    snapshotBefore3rd !== undefined && snapshotBefore3rd.consecutiveFailures === 2,
    `Hydrated consecutiveFailures=${snapshotBefore3rd?.consecutiveFailures} (expected 2)`
  );

  // 3rd failure arrives after restart
  console.log("Recording 3rd failure after restart...");
  recordModelFailure(testProvider, subModel, "empty");

  check(
    "Circuit Trips on 3rd Failure",
    isModelCircuitOpen(testProvider, subModel),
    "Circuit is now OPEN on the 3rd failure (no amnesia!)"
  );

  // ---------------------------------------------------------------------------
  // 3. Markdown Fence Boundary & Code Stitching
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Testing Markdown Continuation Stitching ---");
  check(
    "Threshold Constant",
    PARTIAL_TEXT_REPLACEMENT_THRESHOLD_CHARS === 150,
    `Threshold is ${PARTIAL_TEXT_REPLACEMENT_THRESHOLD_CHARS} chars`
  );

  // Scenario A: Code block interrupted mid-function, continuation starts with fence
  const partialCode =
    "Here is the TypeScript implementation:\n```typescript\nfunction sum(a: number, b: number): number {\n  return a + b;";
  const contCodeWithFence = "```typescript\n}\nconsole.log(sum(1, 2));\n```\nAll done!";

  const stitchedA = stitchContinuation(partialCode, contCodeWithFence);
  check(
    "No Code Fence Collision",
    !stitchedA.includes("```\n\n```") && !stitchedA.includes("```\n```"),
    "Stitched output does not contain duplicate fence collision"
  );
  check(
    "Code Block Preserved",
    stitchedA.includes("return a + b;") && stitchedA.includes("console.log(sum(1, 2));"),
    "Both partial code and continuation code are seamlessly present"
  );

  // Scenario B: Mid-word cut
  const partialWord = "The calculation result was forty-s";
  const contWord = "even units.";
  const stitchedWord = stitchContinuation(partialWord, contWord);
  check(
    "Mid-word Cut Preserved",
    stitchedWord === "The calculation result was forty-seven units.",
    `Stitched mid-word: "${stitchedWord}"`
  );

  // Scenario C: Sentence boundary
  const partialSent = "First sentence completed.";
  const contSent = "Second sentence begins.";
  const stitchedSent = stitchContinuation(partialSent, contSent);
  check(
    "Sentence Boundary Spacing",
    stitchedSent === "First sentence completed.\n\nSecond sentence begins.",
    "Sentence boundary uses double-newline separator"
  );

  // ---------------------------------------------------------------------------
  // 4. Fast-Fail Timers & Budget Clamping
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Testing Fast-Fail Timers & Clamping ---");
  delete process.env.ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS;
  delete process.env.ORCHESTRA_FINAL_ANSWER_ATTEMPT_DEADLINE_MS;
  delete process.env.ORCHESTRA_TOOL_RETRY_DEADLINE_MS;

  check("Default Attempt Deadline", fallbackAttemptDeadlineMs() === 25_000, `Default attempt deadline is ${fallbackAttemptDeadlineMs()}ms (25s)`);
  check("Default Cascade Budget", cascadeBudgetMs() === 50_000, `Default cascade budget is ${cascadeBudgetMs()}ms (50s)`);
  check("Default Tool Retry Deadline", toolRetryDeadlineMs() === 60_000, `Default tool retry deadline is ${toolRetryDeadlineMs()}ms (60s)`);

  // Test clamp: if budget is 40s and attempt is configured as 35s -> clamp to budget / 2 = 20s
  process.env.ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS = "40000";
  process.env.ORCHESTRA_FINAL_ANSWER_ATTEMPT_DEADLINE_MS = "35000";
  const clampedAttempt = fallbackAttemptDeadlineMs();
  check(
    "Attempt Deadline Clamped to Budget / 2",
    clampedAttempt === 20_000,
    `Attempt deadline clamped from 35s to ${clampedAttempt}ms (budget 40s / 2 = 20s)`
  );

  // Test invalid / garbage env in tool retry
  process.env.ORCHESTRA_TOOL_RETRY_DEADLINE_MS = "invalid-nan";
  check(
    "Tool Retry NaN Protection",
    toolRetryDeadlineMs() === 60_000,
    `Fallback on invalid env is ${toolRetryDeadlineMs()}ms`
  );

  delete process.env.ORCHESTRA_FALLBACK_CASCADE_BUDGET_MS;
  delete process.env.ORCHESTRA_FINAL_ANSWER_ATTEMPT_DEADLINE_MS;
  delete process.env.ORCHESTRA_TOOL_RETRY_DEADLINE_MS;

  // ---------------------------------------------------------------------------
  // 5. Free Mode Gated Model Filtering
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Testing Free Mode & Gated Filter ---");
  check(
    "Thinking Machines Gated Excluded",
    isHarnessGatedModel("thinkingmachines/inkling-small:free") &&
      !isGeneralChatModel("thinkingmachines/inkling-small:free"),
    "thinkingmachines/inkling-small:free is rejected"
  );
  check(
    "Content Safety Excluded",
    !isGeneralChatModel("nvidia/nemotron-3.5-content-safety:free"),
    "Content safety classifier is rejected from chat"
  );

  const freeSelection = selectFreeModels();
  const selectedModels = [
    freeSelection.chatModel.model,
    freeSelection.utilityModel.model,
    freeSelection.proposerTiers.fast.model,
    freeSelection.proposerTiers.balanced.model,
    freeSelection.proposerTiers.frontier.model,
  ];

  const hasGated = selectedModels.some((id) => isHarnessGatedModel(id));
  check(
    "No Gated Models Selected",
    !hasGated,
    `Selected models [${selectedModels.join(", ")}] have 0 harness-gated models`
  );
  console.log(`Selected Free Mode Models: ${selectedModels.join(", ")}`);

  // Cleanup test artifacts
  resetModelHealth();

  console.log("\n================================================================================");
  console.log(`🎉 ALL ${results.length} END-TO-END VERIFICATION CHECKS PASSED PERFECTLY!`);
  console.log("================================================================================");
}

run().catch((err) => {
  console.error("FATAL VERIFICATION ERROR:", err);
  process.exit(1);
});
