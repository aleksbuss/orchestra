import type { ToolSet, ToolExecutionOptions } from "ai";
import { asRecord } from "@/lib/agent/agent-response";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { capToolResultSize } from "@/lib/agent/token-governor";

/**
 * Tool loop guard + self-healing recovery machinery (CLAUDE.md §4, §10).
 * Extracted from agent.ts so it can be shared WITHOUT an import cycle: agent.ts
 * AND moa.ts both wrap their ToolSets through this single guard. Every code path
 * that builds a ToolSet for generateText/streamText MUST pipe it through
 * applyGlobalToolLoopGuard before the call (the contract: a wrapped tool returns
 * { success: false, error } on failure instead of throwing, which would kill the
 * run; the A3 per-tool output cap also lives here, applied at the return).
 */

const POLL_NO_PROGRESS_BLOCK_THRESHOLD = 16;
const POLL_BACKOFF_SCHEDULE_MS = [5000, 10000, 30000, 60000] as const;

/**
 * Universal repeat guard (Sprint 1 — tool-loop fix). Independent of
 * success/failure: an agent that issues the SAME (tool + args) call
 * ≥ REPEAT_BLOCK_THRESHOLD times within the last REPEAT_WINDOW calls is in a
 * loop. This is the gap the old guard missed — `lastDeterministicFailure` only
 * blocks an IMMEDIATELY-consecutive identical FAILURE, and a successful leg
 * resets it to null. So `write(success) → execute(error) → write(success) →
 * execute(error)` (the success-leg loop) AND identical success spam both
 * escaped. Keyed on `stableSerialize(args)`, so a legitimate fix-loop that
 * CHANGES the arguments each pass is NOT flagged. Poll-like calls are exempt —
 * they own the separate no-progress backoff above (threshold 16, not 3).
 */
const REPEAT_WINDOW = 8;
const REPEAT_BLOCK_THRESHOLD = 3;

function toStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toStableValue(item));
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = toStableValue(record[key]);
      return acc;
    }, {});
}

function stableSerialize(value: unknown): string {
  try {
    return JSON.stringify(toStableValue(value));
  } catch {
    return String(value);
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function getOutputTextForRecovery(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  const record = asRecord(output);
  if (!record) {
    return "";
  }
  const out = typeof record.output === "string" ? record.output : "";
  const err = typeof record.error === "string" ? record.error : "";
  return [out, err].filter(Boolean).join("\n");
}

function extractNodeMissingModule(text: string): string | null {
  const match = text.match(/Cannot find module ['"]([^'"\n]+)['"]/i);
  const mod = match?.[1]?.trim();
  return mod ? mod : null;
}

function extractPythonMissingModule(text: string): string | null {
  const match = text.match(/ModuleNotFoundError:\s*No module named ['"]([^'"\n]+)['"]/i);
  const mod = match?.[1]?.trim();
  return mod ? mod : null;
}

function extractMissingCommand(text: string): string | null {
  const shellMatch = text.match(/(?:^|\n)(?:\/bin\/sh:\s*\d+:\s*)?([a-zA-Z0-9._-]+):\s*not found(?:\n|$)/i);
  if (shellMatch?.[1]) {
    return shellMatch[1];
  }
  const spawnMatch = text.match(/spawn\s+([a-zA-Z0-9._/-]+)\s+ENOENT/i);
  if (spawnMatch?.[1]) {
    const command = spawnMatch[1].split("/").pop();
    return command ?? null;
  }
  return null;
}

function buildAutoRecoveryHint(toolName: string, output: unknown): string | null {
  if (toolName !== "code_execution" && toolName !== "process") {
    return null;
  }

  const text = getOutputTextForRecovery(output);
  if (!text) {
    return null;
  }

  if (
    /Need to install the following packages/i.test(text) &&
    /Ok to proceed\?/i.test(text)
  ) {
    return [
      "Recoverable blocker detected: interactive npx prompt is waiting for confirmation.",
      "Next action: rerun with non-interactive form using `npx -y ...`, then continue polling/retrying in this turn.",
      "Do not stop on this blocker.",
    ].join("\n");
  }

  if (
    /npm error could not determine executable to run/i.test(text) &&
    /playwright-cli/i.test(text)
  ) {
    return [
      "Recoverable blocker detected: deprecated `playwright-cli` npm package does not expose an executable.",
      "Next action: run the command with `npx -y @playwright/cli ...` (or install `@playwright/cli` via install_packages and retry).",
      "Do not stop on this blocker.",
    ].join("\n");
  }

  if (text.includes("Host system is missing dependencies to run browsers")) {
    return [
      "Recoverable blocker detected: Playwright browser system dependencies are missing.",
      "Next action: run install_packages with kind=\"apt\" for the required libs (or run `npx playwright install-deps` in terminal runtime), then retry the same Playwright command in this turn.",
      "Do not stop and do not ask the user to run commands manually unless installation keeps failing after corrected retries.",
    ].join("\n");
  }

  const missingNodeModule = extractNodeMissingModule(text);
  if (missingNodeModule) {
    return [
      `Recoverable blocker detected: missing Node module "${missingNodeModule}".`,
      `Next action: call install_packages with kind="node" and packages=["${missingNodeModule}"], then retry the same command in this turn.`,
      "Do not stop after this error.",
    ].join("\n");
  }

  const missingPythonModule = extractPythonMissingModule(text);
  if (missingPythonModule) {
    return [
      `Recoverable blocker detected: missing Python module "${missingPythonModule}".`,
      `Next action: call install_packages with kind="python" and packages=["${missingPythonModule}"], then retry the same command in this turn.`,
      "Do not stop after this error.",
    ].join("\n");
  }

  if (/playwright-cli:\s*not found/i.test(text)) {
    return [
      "Recoverable blocker detected: playwright-cli is not installed/in PATH.",
      "Next action: first try running the same command via `npx -y @playwright/cli ...`.",
      "If npx path is unavailable, call install_packages with kind=\"node\" and packages=[\"@playwright/cli\"], then retry in this turn.",
      "Do not end the turn on this error.",
    ].join("\n");
  }

  const missingCommand = extractMissingCommand(text);
  if (missingCommand && missingCommand !== "node" && missingCommand !== "python3") {
    return [
      `Recoverable blocker detected: command "${missingCommand}" is missing.`,
      `Next action: install it via install_packages (kind depends on ecosystem, e.g. apt for system commands), then retry the original command in this turn.`,
      "Only report blocker after corrected install attempts fail.",
    ].join("\n");
  }

  return null;
}

function appendRecoveryHint(output: unknown, hint: string | null): unknown {
  if (!hint) {
    return output;
  }

  const block = `\n\n[Auto-recovery hint]\n${hint}`;
  if (typeof output === "string") {
    return `${output}${block}`;
  }

  const record = asRecord(output);
  if (!record) {
    return output;
  }

  const current = typeof record.output === "string" ? record.output : "";
  return {
    ...record,
    output: current ? `${current}${block}` : block.trim(),
    recoverable: true,
    recoveryHint: hint,
  };
}

function extractDeterministicFailureSignature(output: unknown): string | null {
  const outputRecord = asRecord(output);
  if (outputRecord && outputRecord.success === false) {
    const errorText =
      typeof outputRecord.error === "string"
        ? outputRecord.error
        : "Tool returned success=false";
    const codeText = typeof outputRecord.code === "string" ? outputRecord.code : "";
    return [errorText, codeText].filter(Boolean).join(" | ");
  }

  if (typeof output !== "string") {
    return null;
  }

  const trimmed = output.trim();
  const parsed = parseJsonObject(trimmed);
  if (parsed && parsed.success === false) {
    const errorText =
      typeof parsed.error === "string" ? parsed.error : "Tool returned success=false";
    const codeText = typeof parsed.code === "string" ? parsed.code : "";
    return [errorText, codeText].filter(Boolean).join(" | ");
  }

  const isExplicitFailure =
    trimmed.startsWith("[MCP tool error]") ||
    trimmed.startsWith("[Preflight error]") ||
    trimmed.startsWith("[Loop guard]") ||
    trimmed.includes("Process error:") ||
    trimmed.includes("[Process killed after timeout]") ||
    /Exit code:\s*-?[1-9]\d*/.test(trimmed) ||
    /^Failed\b/i.test(trimmed) ||
    /^Skill ".+" not found\./i.test(trimmed) ||
    (/\bnot found\b/i.test(trimmed) &&
      !/No relevant memories found\./i.test(trimmed));

  if (!isExplicitFailure) {
    return null;
  }

  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
}

function isPollLikeCall(toolName: string, input: unknown): boolean {
  if (toolName !== "process") {
    return false;
  }
  const record = asRecord(input);
  if (!record) {
    return false;
  }
  const action = typeof record.action === "string" ? record.action : "";
  return action === "poll" || action === "log";
}

function normalizeNoProgressValue(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}...` : trimmed;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => normalizeNoProgressValue(item));
  }

  const record = asRecord(value);
  if (!record) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (key === "output" && typeof raw === "string") {
      out[key] = raw.length > 1000 ? `${raw.slice(0, 1000)}...` : raw;
      continue;
    }
    if (key === "attempts" && Array.isArray(raw)) {
      out[key] = raw.slice(0, 3).map((item) => normalizeNoProgressValue(item));
      continue;
    }
    out[key] = normalizeNoProgressValue(raw);
  }

  return out;
}

export function applyGlobalToolLoopGuard(tools: ToolSet, dagContext?: { chatId: string; parentNodeId?: string }): ToolSet {
  let lastDeterministicFailure: { callKey: string; signature: string } | null = null;
  const noProgressByCall = new Map<string, { hash: string; count: number }>();
  // Bounded ring of recent (tool+args) call keys for the universal repeat guard.
  const recentCallKeys: string[] = [];
  const wrappedTools: ToolSet = {};

  for (const [toolName, toolDef] of Object.entries(tools)) {
    if (toolName === "response" || typeof toolDef.execute !== "function") {
      wrappedTools[toolName] = toolDef;
      continue;
    }

    wrappedTools[toolName] = {
      ...toolDef,
      execute: async (input: unknown, options: ToolExecutionOptions) => {
        const callKey = `${toolName}:${stableSerialize(input)}`;

        // Universal repeat guard (Sprint 1): block when the SAME (tool+args)
        // call recurs ≥ threshold within the recent window — catches identical
        // success spam AND A→B→A→B loops the success-leg reset let escape. Poll
        // is exempt (it owns the no-progress backoff below). Record the attempt
        // first so the count reflects everything the model tried this turn,
        // including calls a more specific guard blocks afterward.
        if (!isPollLikeCall(toolName, input)) {
          recentCallKeys.push(callKey);
          if (recentCallKeys.length > REPEAT_WINDOW) recentCallKeys.shift();
          const repeatCount = recentCallKeys.filter((k) => k === callKey).length;
          if (repeatCount >= REPEAT_BLOCK_THRESHOLD) {
            return (
              `[Loop guard] CRITICAL: you have issued this exact call ("${toolName}" with identical arguments) ${repeatCount} times within the last ${recentCallKeys.length} tool calls. ` +
              `Repeating it will NOT change the result — this is a loop. This call was NOT executed.\n` +
              `Stop and do ONE of: (a) use the result you already obtained, (b) change the arguments, or (c) take a different approach to the task.`
            );
          }
        }

        const previousNoProgress = noProgressByCall.get(callKey);
        if (
          previousNoProgress &&
          previousNoProgress.count >= POLL_NO_PROGRESS_BLOCK_THRESHOLD &&
          isPollLikeCall(toolName, input)
        ) {
          const scheduleIdx = Math.min(
            previousNoProgress.count - POLL_NO_PROGRESS_BLOCK_THRESHOLD,
            POLL_BACKOFF_SCHEDULE_MS.length - 1
          );
          const retryInMs = POLL_BACKOFF_SCHEDULE_MS[scheduleIdx] ?? 60000;
          return (
            `[Loop guard] Detected no-progress polling loop for "${toolName}".\n` +
            `Repeated identical result ${previousNoProgress.count} times.\n` +
            `Back off for ~${retryInMs}ms or report the background task as stuck.`
          );
        }

        if (lastDeterministicFailure?.callKey === callKey) {
          return (
            `[Loop guard] Blocked repeated tool call "${toolName}" with identical arguments.\n` +
            `Previous deterministic error: ${lastDeterministicFailure.signature}\n` +
            "Change arguments based on the tool error before retrying."
          );
        }

        // DAG: publish tool_node start event
        const toolNodeId = dagContext ? crypto.randomUUID() : undefined;
        if (dagContext && toolName !== "call_agent" && toolName !== "process") {
          const inputRecord = asRecord(input);
          const summary = inputRecord
            ? (typeof inputRecord.code === "string" ? inputRecord.code.slice(0, 80) : typeof inputRecord.query === "string" ? inputRecord.query.slice(0, 80) : typeof inputRecord.message === "string" ? inputRecord.message.slice(0, 80) : toolName)
            : toolName;
          publishUiSyncEvent({
            topic: "chat",
            chatId: dagContext.chatId,
            nodeType: "tool_node",
            swarmNode: {
              nodeId: toolNodeId!,
              parentNodeId: dagContext.parentNodeId,
              role: "tool",
              taskSummary: summary,
              status: "running",
              startedAt: new Date().toISOString(),
              toolName,
            },
          });
        }

        let outputWithHint: unknown;
        let isError = false;

        try {
          const output = await toolDef.execute!(input as never, options as never);
          const recoveryHint = buildAutoRecoveryHint(toolName, output);
          outputWithHint = appendRecoveryHint(output, recoveryHint);
        } catch (err) {
          isError = true;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[agent:Self-Healing] Tool ${toolName} failed:`, errMsg);
          outputWithHint = `[Tool Execution Failed]: ${errMsg}\n[Self-Healing Prompt]: Your previous tool call crashed. Check your arguments (e.g. missing required fields, wrong enums, syntax errors) and try calling the tool again correctly. Do not repeat the exact same mistake.`;
        }

        const failureSignature = extractDeterministicFailureSignature(outputWithHint);
        const finalStatus = (isError || failureSignature) ? "error" : "completed";

        // DAG: publish tool_node completion or error
        if (dagContext && toolNodeId) {
          publishUiSyncEvent({
            topic: "chat",
            chatId: dagContext.chatId,
            nodeType: "tool_node",
            swarmNode: {
              nodeId: toolNodeId,
              parentNodeId: dagContext.parentNodeId,
              role: "tool",
              taskSummary: toolName,
              status: finalStatus,
              completedAt: new Date().toISOString(),
              toolName,
            },
          });
        }

        if (failureSignature) {
          lastDeterministicFailure = {
            callKey,
            signature: failureSignature,
          };
        } else {
          lastDeterministicFailure = null;
        }

        if (isPollLikeCall(toolName, input)) {
          const outputHash = stableSerialize(normalizeNoProgressValue(outputWithHint));
          const previous = noProgressByCall.get(callKey);
          if (previous && previous.hash === outputHash) {
            noProgressByCall.set(callKey, {
              hash: outputHash,
              count: previous.count + 1,
            });
          } else {
            noProgressByCall.set(callKey, {
              hash: outputHash,
              count: 1,
            });
          }
        } else {
          noProgressByCall.delete(callKey);
        }

        // A3: cap an oversized result AFTER loop-guard bookkeeping (signature /
        // no-progress hashing run on the full output above).
        return capToolResultSize(outputWithHint);
      },
    } as typeof toolDef;
  }

  return wrappedTools;
}
