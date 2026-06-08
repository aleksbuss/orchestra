import {
  streamText,
  generateText,
  stepCountIs,
  hasToolCall,
  type ModelMessage,
  type ToolExecutionOptions,
  type ToolSet,
} from "ai";
import { createModel, isLocalProvider } from "@/lib/providers/llm-provider";
import { modelSupportsTools } from "@/lib/providers/tool-support";
import { foldTurnUsage } from "@/lib/cost/accumulator";
import type { ModelConfig } from "@/lib/types";
import {
  classifyModelError,
  pickFallbackModel,
  describeFallback,
} from "@/lib/providers/model-fallback";
import { publishChatErrorEvent } from "@/lib/realtime/event-bus";
import { saveSettings } from "@/lib/storage/settings-store";
import { classifyChatError } from "@/lib/observability/classify-error";
import { getCurrentTraceId, log } from "@/lib/observability/logger";
import { dumpPostmortem } from "@/lib/observability/postmortem";
import { buildSystemPrompt, PLAIN_CHAT_TOOL_OVERRIDE } from "@/lib/agent/prompts";
import { getSettings } from "@/lib/storage/settings-store";
import { getChat, updateChat } from "@/lib/storage/chat-store";
import { createAgentTools } from "@/lib/tools/tool";
import { getProjectMcpTools } from "@/lib/mcp/client";
import { agentSemaphore } from "./semaphore";
import type { AgentContext } from "@/lib/agent/types";
import { History, mergeConsecutiveSameRole } from "@/lib/agent/history";
import { truncateToolOutputForHistory } from "@/lib/tools/output-truncate";
import type { ChatMessage, AppSettings } from "@/lib/types";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { createCallAgentTool } from "@/lib/swarm/tools";
import { getSwarmSystemPrompt } from "@/lib/swarm/prompts";
import type { SwarmRole } from "@/lib/swarm/types";
import { compressChatHistory, estimateTokenCount } from "@/lib/agent/compressor";
import { getBrainConfig, type PresetTier } from "@/lib/agent/presets";
import { runMoAEnsemble } from "@/lib/agent/moa";
import { insertMemory, searchMemory } from "@/lib/memory/memory";
import { resolveWorkDirForProject } from "@/lib/storage/project-store";

const LLM_LOG_BORDER = "═".repeat(60);
const MAX_TOOL_STEPS_PER_TURN = 30;
const MAX_TOOL_STEPS_SUBORDINATE = 15;
const POLL_NO_PROGRESS_BLOCK_THRESHOLD = 16;
const POLL_BACKOFF_SCHEDULE_MS = [5000, 10000, 30000, 60000] as const;

// ── Swarm DAG Completion Guard ────────────────────────────────────────────────
// Guarantees that the orchestrator node always transitions out of "running"
// even when the SSE stream disconnects mid-response or onFinish throws.
function publishOrchestratorFinished(
  chatId: string,
  projectId: string | null | undefined,
  status: "completed" | "error",
  reason?: string
) {
  publishUiSyncEvent({
    topic: "chat",
    projectId: projectId ?? null,
    chatId,
    reason: reason ?? "agent_turn_finished",
  });
  publishUiSyncEvent({
    topic: "chat",
    projectId: projectId ?? null,
    chatId,
    nodeType: "agent_node",
    swarmNode: {
      nodeId: chatId,
      role: "orchestrator",
      taskSummary: status === "completed" ? "Finished." : "Error.",
      status,
      completedAt: new Date().toISOString(),
    },
  });
}

function resolveModelProviderOptions(provider: string) {
  if (provider === "codex-cli") {
    return {
      openai: {
        store: false as const,
        instructions: "You are Orchestra, an AI coding assistant.",
      },
    };
  }
  return undefined;
}

/**
 * Auto-fallback on model failures. Called from the streamText `onError`
 * handler (and the MoA equivalent, see runMoAEnsemble). If the error
 * shape matches "model is unavailable" or "model doesn't support tools",
 * we pick a replacement model from the same provider, persist it as the
 * new default in settings, and surface a `model_fallback` notification
 * so the user knows what happened.
 *
 * Intentionally NOT a retry of the current turn — that would mean
 * double LLM cost and risk of double tool execution. The user's next
 * message uses the new model automatically.
 *
 * Fire-and-forget — never throws. Any internal failure is logged but
 * not surfaced; the caller is expected to ALSO publish the original
 * error event so the UI sees the immediate failure regardless of
 * whether fallback succeeds.
 */
async function attemptModelFallback(
  error: unknown,
  settings: AppSettings,
  chatId: string,
  projectId: string | null | undefined
): Promise<void> {
  try {
    const failureKind = classifyModelError(error);
    if (failureKind !== "model_not_found" && failureKind !== "no_tool_support" && failureKind !== "unknown_4xx") {
      // Not a model-availability problem — let the existing error path
      // surface to the user without auto-switching providers.
      return;
    }

    const chatModel = settings.chatModel;
    if (!chatModel?.provider || !chatModel?.model) {
      return;
    }

    const result = await pickFallbackModel({
      provider: chatModel.provider,
      failedModel: chatModel.model,
      apiKey: chatModel.apiKey || undefined,
      baseUrl: (chatModel as { baseUrl?: string }).baseUrl,
    });

    if (!result.modelId) {
      log.info("agent_fallback_no_candidate", {
        chatId,
        provider: chatModel.provider,
        failedModel: chatModel.model,
        failureKind,
      });
      return;
    }

    // Persist the new model so subsequent turns don't re-fail. We only
    // change `chatModel.model`; everything else (provider, api key,
    // baseUrl) stays intact.
    await saveSettings({
      chatModel: { ...chatModel, model: result.modelId },
    });

    const details = {
      originalModel: chatModel.model,
      newModel: result.modelId,
      provider: chatModel.provider,
      source: result.source,
      reason: failureKind === "no_tool_support"
        ? "no_tool_support" as const
        : failureKind === "model_not_found"
          ? "model_not_found" as const
          : "unknown_4xx" as const,
      pricing: result.pricing,
    };
    const { message, hint } = describeFallback(details);

    log.info("agent_fallback_applied", {
      chatId,
      provider: chatModel.provider,
      from: chatModel.model,
      to: result.modelId,
      source: result.source,
      isFree: result.pricing?.isFree ?? false,
    });

    publishChatErrorEvent({
      chatId,
      projectId,
      payload: {
        kind: "model_fallback",
        message,
        hint,
        recoverable: true,
        modelFallback: details,
        traceId: getCurrentTraceId(),
      },
    });
  } catch (fallbackErr) {
    // Never throw out of fallback — that would compound the original
    // error and possibly mask the user-visible PM #17 banner.
    log.warn("agent_fallback_failed", {
      chatId,
      err: fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)),
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

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

function applyGlobalToolLoopGuard(tools: ToolSet, dagContext?: { chatId: string; parentNodeId?: string }): ToolSet {
  let lastDeterministicFailure: { callKey: string; signature: string } | null = null;
  const noProgressByCall = new Map<string, { hash: string; count: number }>();
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

        return outputWithHint;
      },
    } as typeof toolDef;
  }

  return wrappedTools;
}

/**
 * Convert stored ChatMessages to AI SDK ModelMessage format
 */
function convertChatMessagesToModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  let systemArchiveCount = 0;

  for (const m of messages) {
    if (m.role === "system") {
      // System messages include compressed memory archives and MCP instructions.
      // These MUST be forwarded to the model as user-role context so the agent
      // retains knowledge from earlier in the conversation.
      result.push({
        role: "user",
        content: `[System Context — Conversation Memory]\n${m.content}`,
      });
      systemArchiveCount++;
    } else if (m.role === "tool") {
      // Tool result message - AI SDK uses 'output' not 'result'
      result.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.toolCallId!,
          toolName: m.toolName!,
          output: { type: "json", value: m.toolResult as import("@ai-sdk/provider").JSONValue },
        }],
      });
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // Assistant message with tool calls - AI SDK uses 'input' not 'args'
      const content: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];
      if (m.content) {
        content.push({ type: "text", text: m.content });
      }
      for (const tc of m.toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.args,
        });
      }
      result.push({ role: "assistant", content });
    } else if (m.role === "user" || m.role === "assistant") {
      // Regular user or assistant message
      result.push({ role: m.role, content: m.content });
    }
  }

  if (systemArchiveCount > 0) {
    console.log(`[Memory] Loaded ${systemArchiveCount} compressed memory archive(s) into context.`);
  }

  return result;
}

/**
 * Strip thinking block from text to prevent leaking it to the user UI
 */
function stripThinkingTags(text: string): string {
  if (!text) return text;
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/**
 * Convert AI SDK ModelMessage to our ChatMessage format for storage.
 * Tool messages can contain multiple tool results, so this returns an array.
 */
/**
 * PM #61 — Models frequently emit the final `response` tool call as TEXT (a
 * JSON code block like `{"call":"response","arguments":{"message":"..."}}`)
 * instead of a native tool call — especially under heavy context (MoA) or on
 * mid-tier models. Orchestra has no parser for that, so the real answer gets
 * persisted as a raw JSON blob and the UI renders "no answer". This unwraps
 * that shape and returns the inner message; non-matching text passes through
 * unchanged (conservative — only unwraps when the WHOLE text is the call).
 */
export function unwrapSerializedResponseCall(text: string): string {
  if (!text || !text.includes("response")) return text;
  let body = text.trim();
  // Strip a single surrounding ```json ... ``` (or bare ```) fence.
  const fence = body.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text;
  }
  const rec = asRecord(parsed);
  if (!rec) return text;
  const toolName = rec.call ?? rec.name ?? rec.tool ?? rec.function;
  if (toolName !== "response") return text;
  const args =
    asRecord(rec.arguments) ?? asRecord(rec.input) ?? asRecord(rec.parameters) ?? rec;
  const message =
    typeof args.message === "string"
      ? args.message
      : typeof args.text === "string"
        ? args.text
        : typeof args.answer === "string"
          ? args.answer
          : null;
  return message && message.trim() ? message : text;
}

function convertModelMessageToChatMessages(msg: ModelMessage, now: string): ChatMessage[] {
  if (msg.role === "tool") {
    // Tool result - AI SDK may include multiple tool-result parts in one message.
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolMessages: ChatMessage[] = [];

    for (const part of content) {
      if (!(typeof part === "object" && part !== null && "type" in part && part.type === "tool-result")) {
        continue;
      }

      const tr = part as {
        toolCallId: string;
        toolName: string;
        output?: { type: string; value: unknown } | unknown;
        result?: unknown;
      };

      const outputContainer = tr.output ?? tr.result;
      const outputValue =
        typeof outputContainer === "object" &&
        outputContainer !== null &&
        "value" in outputContainer
          ? (outputContainer as { value: unknown }).value
          : outputContainer;

      // Cap chat-persisted tool output to prevent the chat-store
      // re-serialization storm and runaway prompt growth on the next turn.
      // The full output was already visible to the agent during execution;
      // only the chat archive is bounded.
      const truncated = truncateToolOutputForHistory(outputValue);
      const persistedResult = truncated.truncated
        ? truncated.content
        : outputValue;

      toolMessages.push({
        id: crypto.randomUUID(),
        role: "tool",
        content: truncated.content,
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        toolResult: persistedResult,
        createdAt: now,
      });
    }

    return toolMessages;
  }

  if (msg.role === "assistant") {
    const content = msg.content;
    if (Array.isArray(content)) {
      // Extract text and tool calls - AI SDK uses 'input' not 'args'
      let textContent = "";
      const toolCalls: ChatMessage["toolCalls"] = [];

      for (const part of content) {
        if (typeof part === "object" && part !== null) {
          if ("type" in part && part.type === "text" && "text" in part) {
            textContent += (part as { text: string }).text;
          } else if ("type" in part && part.type === "tool-call") {
            const tc = part as { toolCallId: string; toolName: string; input: unknown };
            toolCalls.push({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.input as Record<string, unknown>,
            });
          }
        }
      }

      return [{
        id: crypto.randomUUID(),
        role: "assistant",
        content: stripThinkingTags(unwrapSerializedResponseCall(textContent)),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        createdAt: now,
      }];
    }
    // String content
    return [{
      id: crypto.randomUUID(),
      role: "assistant",
      content: typeof content === "string" ? stripThinkingTags(unwrapSerializedResponseCall(content)) : "",
      createdAt: now,
    }];
  }

  // User or other
  return [{
    id: crypto.randomUUID(),
    role: msg.role as "user" | "assistant" | "system" | "tool",
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    createdAt: now,
  }];
}

function logLLMRequest(options: {
  model: string;
  system: string;
  messages: ModelMessage[];
  toolNames: string[];
  temperature?: number;
  maxTokens?: number;
  label?: string;
}) {
  const { model, system, messages, toolNames, temperature, maxTokens, label = "LLM Request" } = options;
  console.log(`\n${LLM_LOG_BORDER}`);
  console.log(`  ${label}`);
  console.log(LLM_LOG_BORDER);
  console.log(`  Model: ${model}`);
  console.log(`  Temperature: ${temperature ?? "default"}`);
  console.log(`  Max tokens: ${maxTokens ?? "default"}`);
  console.log(`  Tools: ${toolNames.length ? toolNames.join(", ") : "none"}`);
  console.log(`  Messages: ${messages.length}`);
  console.log(LLM_LOG_BORDER);
  console.log("  --- SYSTEM ---\n");
  console.log(system);
  console.log("\n  --- MESSAGES ---");
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m.role.toUpperCase();
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const preview = content.length > 500 ? content.slice(0, 500) + "…" : content;
    console.log(`  [${i + 1}] ${role}:\n${preview}`);
  }
  console.log(`\n${LLM_LOG_BORDER}\n`);
}

function extractAssistantText(msg: ModelMessage): string {
  if (msg.role !== "assistant") return "";
  const content = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      text += (part as { text: string }).text;
    }
  }
  return text;
}

function getLastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractAssistantText(msg).trim();
    if (text) return text;
  }
  return "";
}

function extractToolResultOutputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  const record = asRecord(output);
  if (!record) {
    if (output === null || output === undefined) {
      return "";
    }
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  const value = "value" in record ? record.value : undefined;
  if (typeof value === "string") {
    return value;
  }
  if (value !== undefined) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (typeof record.message === "string") {
    return record.message;
  }

  try {
    return JSON.stringify(record);
  } catch {
    return String(record);
  }
}

function getLastResponseToolText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];

    if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j -= 1) {
        const part = msg.content[j];
        if (!(typeof part === "object" && part !== null)) continue;
        if (!("type" in part) || part.type !== "tool-result") continue;
        const toolName =
          "toolName" in part && typeof (part as { toolName?: unknown }).toolName === "string"
            ? ((part as { toolName: string }).toolName as string)
            : "";
        if (toolName !== "response") continue;

        const output =
          "output" in part ? (part as { output?: unknown }).output : (part as { result?: unknown }).result;
        const text = extractToolResultOutputText(output).trim();
        if (text) return text;
      }
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j -= 1) {
        const part = msg.content[j];
        if (!(typeof part === "object" && part !== null)) continue;
        if (!("type" in part) || part.type !== "tool-call") continue;
        const toolName =
          "toolName" in part && typeof (part as { toolName?: unknown }).toolName === "string"
            ? ((part as { toolName: string }).toolName as string)
            : "";
        if (toolName !== "response") continue;
        const input =
          "input" in part ? (part as { input?: unknown }).input : undefined;
        const inputRecord = asRecord(input);
        const message = typeof inputRecord?.message === "string" ? inputRecord.message.trim() : "";
        if (message) return message;
      }
    }
  }
  return "";
}

function shouldAutoContinueAssistant(
  text: string,
  finishReason?: string
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const reason = (finishReason || "").toLowerCase();
  if (reason === "length" || reason === "max_tokens") {
    return true;
  }

  // Common abrupt cutoff pattern from prompt-generation turns.
  if (/(?:here is (?:the )?prompt|вот (?:твой )?(?:промпт|prompt))[:：]?\s*$/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * PM #69 — did this turn actually deliver an answer to the user? An answer
 * arrives either as a `response` tool call (the primary mechanism) or as plain
 * assistant text. A turn that ends with only tool calls + results — e.g. the
 * model called `search_web` and the loop stopped on a flaky
 * `finishReason: "other"` without a follow-up answer — delivered NOTHING, and
 * the caller must force a final-answer generation so the user always gets a
 * reply. Assistant text is checked AFTER `stripThinkingTags`: a turn whose only
 * text was a `<thinking>` block is persisted as empty, so it is not deliverable.
 */
export function turnHasDeliverableAnswer(messages: ModelMessage[]): boolean {
  if (getLastResponseToolText(messages).trim()) return true;
  return Boolean(stripThinkingTags(getLastAssistantText(messages)).trim());
}

export interface TurnContinuationResult {
  /** Extra assistant text to append (continuation tail or forced answer); "" when none needed. */
  text: string;
  usage?: import("@/lib/cost/accumulator").RawUsage;
  /** Non-fatal operator notice (a continuation/force attempt failed); caller publishes it. */
  uiNotice?: string;
}

/**
 * PM #36 (truncation continuation) + PM #69 (forced final answer) — given a
 * finished turn, decide whether an EXTRA generation is needed and produce its
 * text + usage:
 *   - the reply was truncated (`shouldAutoContinueAssistant`) → continue from
 *     where it stopped (capped at 1200 tokens);
 *   - NO answer was delivered at all (`turnHasDeliverableAnswer` === false, the
 *     PM #69 failure) → force ONE tool-less final answer so the user always gets
 *     a reply. Tool-less ⇒ it can only emit text, never another tool call ⇒ no
 *     loop.
 * Returns `{ text: "" }` when the turn already delivered a complete answer.
 * Self-contained (only `generateText` + pure helpers) so it is unit-testable
 * with a mock model — see `final-answer-guard.test.ts`.
 */
export async function resolveTurnContinuation(args: {
  responseMessages: ModelMessage[];
  finishReason: string | undefined;
  model: Parameters<typeof generateText>[0]["model"];
  systemPrompt: string;
  baseMessages: ModelMessage[];
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
  settings: AppSettings;
  abortSignal?: AbortSignal;
}): Promise<TurnContinuationResult> {
  const {
    responseMessages,
    finishReason,
    model,
    systemPrompt,
    baseMessages,
    providerOptions,
    settings,
    abortSignal,
  } = args;
  const lastAssistantText = getLastAssistantText(responseMessages);
  const readUsage = (r: unknown) =>
    (r as { usage?: import("@/lib/cost/accumulator").RawUsage }).usage ?? undefined;

  if (shouldAutoContinueAssistant(lastAssistantText, finishReason)) {
    try {
      const continuation = await generateText({
        model,
        system: systemPrompt,
        messages: mergeConsecutiveSameRole([
          ...baseMessages,
          ...responseMessages,
          {
            role: "user",
            content:
              "Continue your previous answer from exactly where it stopped. " +
              "Output only the continuation text, without repeating earlier content.",
          },
        ]),
        providerOptions,
        temperature: settings.chatModel.temperature ?? 0.7,
        maxOutputTokens: Math.min(settings.chatModel.maxTokens ?? 4096, 1200),
        abortSignal,
      });
      return { text: (continuation.text || "").trim(), usage: readUsage(continuation) };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn("Auto-continuation failed:", error);
      return {
        text: "",
        uiNotice: `[Agent] Auto-continuation failed (truncated reply will ship as-is): ${errMsg}`,
      };
    }
  }

  if (!turnHasDeliverableAnswer(responseMessages)) {
    try {
      const forced = await generateText({
        model,
        system: systemPrompt,
        messages: mergeConsecutiveSameRole([
          ...baseMessages,
          ...responseMessages,
          {
            role: "user",
            content:
              "You have everything you need from the steps above. Write your " +
              "final answer to the user now, in plain prose. Do not call any tools.",
          },
        ]),
        providerOptions,
        temperature: settings.chatModel.temperature ?? 0.7,
        maxOutputTokens: settings.chatModel.maxTokens ?? 4096,
        abortSignal,
      });
      const text = unwrapSerializedResponseCall((forced.text || "").trim());
      if (text) {
        console.log(
          `[Agent] PM #69 — forced final answer after a no-delivery turn (finishReason=${finishReason}).`
        );
      }
      return { text, usage: readUsage(forced) };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn("[Agent] PM #69 forced final answer failed:", error);
      return {
        text: "",
        uiNotice: `[Agent] Could not produce a final answer for this turn: ${errMsg}`,
      };
    }
  }

  return { text: "" };
}

/**
 * Executes a subsidiary agent with a specialized role (Swarm).
 */
async function runSubAgent(
  role: SwarmRole,
  taskDescription: string,
  extraContext: string | undefined,
  parentContext: AgentContext,
  settings: AppSettings,
  providerOptions: any,
  model: any, // Pass the actual resolved model instance from Orchestrator!
  abortSignal?: AbortSignal
): Promise<string> {
  const nodeId = crypto.randomUUID();

  const baseTools = createAgentTools(parentContext, settings);
  let tools = baseTools;
  if (parentContext.projectId) {
    const mcp = await getProjectMcpTools(parentContext.projectId);
    if (mcp) {
      tools = { ...baseTools, ...mcp.tools };
    }
  }

  // --- Swarm Tool Pruning (Scoping) ---
  // Read-only tools safe for all sub-agent roles
  const readOnlyMatch = (key: string) =>
    key.includes("search") || key.includes("read") || key.includes("list") ||
    key.includes("view") || key.includes("blackboard") || key === "knowledge_query" ||
    key === "memory_load" || key === "response";

  if (role === "researcher") {
    const filteredTools: Record<string, any> = {};
    for (const key of Object.keys(tools)) {
      if (readOnlyMatch(key)) {
        filteredTools[key] = tools[key];
      }
    }
    tools = filteredTools;
  } else if (role === "reviewer") {
    const filteredTools: Record<string, any> = {};
    for (const key of Object.keys(tools)) {
      if (readOnlyMatch(key) || key.includes("grep")) {
        filteredTools[key] = tools[key];
      }
    }
    tools = filteredTools;
  }
  // "coder" retains all structural and OS execution tools.
  // ------------------------------------
  tools = applyGlobalToolLoopGuard(tools, { chatId: parentContext.chatId, parentNodeId: nodeId });

  const systemPrompt = getSwarmSystemPrompt(role) + "\n\nYou must return a concise, accurate response when your work is completely done.";
  const promptText = extraContext 
    ? `Task:\n${taskDescription}\n\nContext/Constraints:\n${extraContext}` 
    : `Task:\n${taskDescription}`;

  // DAG: publish agent_node start
  publishUiSyncEvent({
    topic: "chat",
    chatId: parentContext.chatId,
    reason: `[Swarm] Orchestrator delegated task to specialized agent "${role}": ${taskDescription}`,
    parentId: parentContext.chatId,
    nodeType: "agent_node",
    swarmNode: {
      nodeId,
      parentNodeId: parentContext.chatId,
      role,
      taskSummary: taskDescription.slice(0, 120),
      status: "running",
      startedAt: new Date().toISOString(),
    },
  });

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      providerOptions,
      messages: [{ role: "user", content: promptText }],
      tools,
      maxRetries: 3,
      stopWhen: [stepCountIs(MAX_TOOL_STEPS_SUBORDINATE), hasToolCall("response")],
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: settings.chatModel.maxTokens ?? 4096,
      abortSignal,
    });
    // PM #61 — unwrap a serialized `response` call if the model emitted it as
    // text (JSON/`<call:>`); no-op on clean text. Applies to the swarm-agent
    // result returned into the parent's context.
    const responseText = unwrapSerializedResponseCall(
      getLastResponseToolText(result.response.messages) || result.text
    );
    const outputText = responseText.trim() || "Agent finished but returned no text.";

    // DAG: publish agent_node completed
    publishUiSyncEvent({
      topic: "chat",
      chatId: parentContext.chatId,
      reason: `[Swarm] Agent "${role}" completed its task.`,
      parentId: parentContext.chatId,
      nodeType: "agent_node",
      swarmNode: {
        nodeId,
        role,
        taskSummary: taskDescription.slice(0, 120),
        status: "completed",
        completedAt: new Date().toISOString(),
      },
    });

    return outputText;
  } catch (err) {
    // DAG: publish agent_node error
    publishUiSyncEvent({
      topic: "chat",
      chatId: parentContext.chatId,
      nodeType: "agent_node",
      swarmNode: {
        nodeId,
        role,
        taskSummary: taskDescription.slice(0, 120),
        status: "error",
        completedAt: new Date().toISOString(),
      },
    });
    console.error(`[Swarm] Sub-agent "${role}" error:`, err instanceof Error ? err.message : err);
    return `[Swarm] Sub-agent Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Run the agent for a given chat context and return a streamable result.
 * Uses Vercel AI SDK's streamText with stopWhen for automatic tool loop.
 */
export interface RunAgentOptions {
  chatId: string;
  userMessage: string;
  projectId?: string;
  currentPath?: string;
  agentNumber?: number;
  swarmEnabled?: boolean;
  /**
   * Bypass the MoA Router's `requiresSwarm` classification. When `true`, the
   * full proposer fan-out runs regardless of the Router's verdict. Plumbed
   * straight through to `runMoAEnsemble`; has no effect when
   * `swarmEnabled === false`.
   */
  forceSwarm?: boolean;
  isBackground?: boolean;
  abortSignal?: AbortSignal;
  preset?: PresetTier;
}

/**
 * PM #47 — Privacy Mode runtime guard. Throws when the operator has
 * enabled `settings.privacyMode.enabled` but any of `chatModel`,
 * `utilityModel`, or `embeddingsModel` resolves to a non-local backend.
 * Exported so the runtime check has its own focused test suite
 * (`agent-privacy.test.ts`) without booting the full runAgent path.
 */
export function assertPrivacyModeAllowsSettings(
  settings: AppSettings
): void {
  if (!settings.privacyMode?.enabled) return;
  const violations: string[] = [];
  if (!isLocalProvider(settings.chatModel)) {
    violations.push(
      `chatModel = ${settings.chatModel.provider}/${settings.chatModel.model}`
    );
  }
  // utilityModel is used by the Router + reflection critic. If it's
  // not local, the swarm leaks the user prompt to a vendor regardless
  // of whether the chatModel is local.
  if (
    settings.utilityModel?.model &&
    !isLocalProvider(settings.utilityModel)
  ) {
    violations.push(
      `utilityModel = ${settings.utilityModel.provider}/${settings.utilityModel.model}`
    );
  }
  // embeddingsModel is used by Blackboard + PM #39 disagreement
  // detection + PM #46 convergence. Same threat — text leaves the box.
  // Note: the embeddingsModel union includes "mock", which is non-network.
  if (
    settings.embeddingsModel?.provider &&
    settings.embeddingsModel.provider !== "mock" &&
    !isLocalProvider({
      provider: settings.embeddingsModel.provider as ModelConfig["provider"],
      model: settings.embeddingsModel.model,
      baseUrl: settings.embeddingsModel.baseUrl,
    })
  ) {
    violations.push(
      `embeddingsModel = ${settings.embeddingsModel.provider}/${settings.embeddingsModel.model}`
    );
  }
  // PM #48 — proposerTiers also leak the user prompt if any configured
  // tier resolves to a non-local backend. The MoA dispatch path uses
  // `resolveProposerModelConfig` which falls back to `chatModel`/worker
  // when a tier is unset, so we only check tiers the operator actually
  // configured (has a `model` set).
  const tiers = settings.proposerTiers;
  if (tiers) {
    for (const tierName of ["fast", "balanced", "frontier"] as const) {
      const tierCfg = tiers[tierName];
      if (tierCfg?.model && !isLocalProvider(tierCfg)) {
        violations.push(
          `proposerTiers.${tierName} = ${tierCfg.provider}/${tierCfg.model}`
        );
      }
    }
  }
  // PM #54 — `settings.aggregator.tournamentJudgeModel` (PM #52) was the
  // last LLM call path that bypassed the Privacy Mode guard. When the
  // operator picks tournament mode + a cloud judge model, every MoA call
  // shipped the user prompt + every draft to that judge provider — the
  // exact air-gap violation PM #47 was supposed to prevent. Closing the
  // hole here makes the threat model honest: ALL LLM call paths reachable
  // from runAgent are now gated by this single guard.
  const judgeCfg = settings.aggregator?.tournamentJudgeModel;
  if (judgeCfg?.model && !isLocalProvider(judgeCfg)) {
    violations.push(
      `aggregator.tournamentJudgeModel = ${judgeCfg.provider}/${judgeCfg.model}`
    );
  }
  if (violations.length > 0) {
    throw new Error(
      `Privacy Mode is enabled, but these models target a non-local backend:\n  ` +
        violations.map((v) => `• ${v}`).join("\n  ") +
        `\n\nTo proceed, either: (a) disable Privacy Mode in Settings, or ` +
        `(b) switch the violating models to a local backend (ollama, ` +
        `sglang, vllm, or custom with a loopback baseUrl).`
    );
  }
}

export async function runAgent(options: RunAgentOptions) {
  const settings = await getSettings();

  // PM #47 — Privacy Mode enforcement. Fail fast before any LLM call so
  // the operator/sharing-friends see the error in the chat UI rather
  // than a partial run with cloud telemetry already in flight.
  assertPrivacyModeAllowsSettings(settings);

  // Resolve model config: if a preset is active, use its brain config;
  // otherwise fall back to the user's manual settings.
  const resolvedModelConfig = options.preset
    ? getBrainConfig(options.preset, settings.chatModel)
    : settings.chatModel;

  // Smart API key resolution for presets:
  // 1. If the preset itself has a key → use it (shouldn't happen, presets don't store keys)
  // 2. If there's a key in the provider-specific vault → use it
  // 3. If the user's chatModel uses the SAME provider → inherit its key
  // 4. Fall through to env vars (handled by createModel)
  if (options.preset && options.preset !== "custom" && !resolvedModelConfig.apiKey) {
    const provider = resolvedModelConfig.provider;
    const vaultKey = settings.providerApiKeys?.[provider];
    if (vaultKey) {
      resolvedModelConfig.apiKey = vaultKey;
      console.log(`[KeyResolver] ${provider}: using vault key`);
    } else if (settings.chatModel.provider === provider && settings.chatModel.apiKey) {
      resolvedModelConfig.apiKey = settings.chatModel.apiKey;
      console.log(`[KeyResolver] ${provider}: inherited from chatModel`);
    } else {
      console.warn(`[KeyResolver] ${provider}: no key found in vault or chatModel`);
    }
  }

  const providerOptions = resolveModelProviderOptions(resolvedModelConfig.provider);
  const model = createModel(resolvedModelConfig, {
    projectId: options.projectId,
    currentPath: options.currentPath,
  });

  console.log(`[Agent] provider=${resolvedModelConfig.provider} model=${resolvedModelConfig.model} preset=${options.preset ?? "custom"} hasKey=${!!resolvedModelConfig.apiKey}`);

  // Build context. workDir resolves the project's effective filesystem root
  // (linked projects honor `absoluteRoot`; sandbox projects fall back to
  // `data/projects/<id>/`). Pre-resolving here avoids an async lookup on
  // every tool call inside resolveContextCwd.
  const workDir = await resolveWorkDirForProject(options.projectId);
  const context: AgentContext = {
    chatId: options.chatId,
    projectId: options.projectId,
    currentPath: options.currentPath,
    workDir,
    memorySubdir: options.projectId
      ? `${options.projectId}`
      : "main",
    knowledgeSubdirs: options.projectId
      ? [`${options.projectId}`, "main"]
      : ["main"],
    history: [],
    agentNumber: options.agentNumber ?? 0,
    data: {
      currentUserMessage: options.userMessage,
    },
  };

  // Immediate Persistence: Save the user message BEFORE starting the LLM stream.
  // This ensures the chat history is consistent even if the network fails mid-turn.
  await updateChat(options.chatId, (c) => {
    const alreadyExists = c.messages.some(m => m.role === "user" && m.content === options.userMessage && (Date.now() - new Date(m.createdAt).getTime() < 5000));
    if (!alreadyExists) {
      c.messages.push({
        id: crypto.randomUUID(),
        role: "user",
        content: options.userMessage,
        createdAt: new Date().toISOString(),
      });
    }
    return c;
  });

  // Load existing chat history
  let chat = await getChat(options.chatId);
  if (chat) {
    const rawModelMessages = convertChatMessagesToModelMessages(chat.messages);
    const estimatedTokens = estimateTokenCount(rawModelMessages);
    
    // Semantic Context Compaction threshold — raised to 12000 tokens for modern
    // long-context models (Gemini 3 Flash, 2.5 Pro, etc.). This gives the agent
    // much more room before compression kicks in.

    // Phase 1: Dynamic Thresholds
    const modelIdForLimits = resolvedModelConfig.model?.toLowerCase() ?? "";
    let contextLimit = 8000; // safe default for unknown/small models
    if (modelIdForLimits.includes("gpt-4") || modelIdForLimits.includes("claude-3") || modelIdForLimits.includes("gemini") || modelIdForLimits.includes("128k") || modelIdForLimits.includes("qwen2.5-coder-32b")) {
      contextLimit = 100000; // Giant context models
    } else if (modelIdForLimits.includes("32k")) {
      contextLimit = 30000;
    } else if (modelIdForLimits.includes("8b") || modelIdForLimits.includes("7b") || modelIdForLimits.includes("llama3") || modelIdForLimits.includes("gemma")) {
      contextLimit = 6000; // conservative for small local models to prevent hallucination collapses
    }

    if (estimatedTokens > contextLimit && chat.messages.length > 12) {
      console.log(`[Memory] Context reached ${estimatedTokens} tokens (limit ${contextLimit}). Deep-archiving history...`);
      publishUiSyncEvent({
        topic: "chat",
        chatId: options.chatId,
        projectId: options.projectId ?? null,
        reason: "[System] Context memory reached dynamic limit. Deep-archiving history into RAG...",
      });

      const cutoff = chat.messages.length - 8; // keep last 8 fresh for better continuity
      const olderMessages = chat.messages.slice(0, cutoff);
      const newerMessages = chat.messages.slice(cutoff);

      const summary = await compressChatHistory(olderMessages, settings, options.projectId);
      
      // Phase 2: RAG Vector Database Archival
      const memorySubdir = options.projectId ? `${options.projectId}` : "main";
      try {
        await insertMemory(`Archived Chat History [${new Date().toISOString()}]:\n${summary}`, "Auto-Archive", memorySubdir, settings);
        console.log(`[Memory] History successfully vector-archived.`);
      } catch (err) {
        console.error(`[Memory] Failed to vector-archive history:`, err);
      }

      const updated = await updateChat(options.chatId, (c) => {
        c.messages = newerMessages;
        return c;
      });
      if (updated) chat = updated;
    }

    const allMessages = convertChatMessagesToModelMessages(chat.messages);
    const history = new History(80);
    history.addMany(allMessages);
    context.history = history.getAll();
    console.log(`[Memory] Agent context loaded: ${context.history.length} messages (from ${chat.messages.length} stored).`);
  }

  // Build tools: base + optional MCP tools from project .meta/mcp
  const baseTools = createAgentTools(context, settings);
  let mcpCleanup: (() => Promise<void>) | undefined;
  let tools = baseTools;
  if (options.projectId) {
    const mcp = await getProjectMcpTools(options.projectId);
    if (mcp) {
      tools = { ...baseTools, ...mcp.tools };
      mcpCleanup = mcp.cleanup;
    }
  }
  const orchestratorNodeId = options.chatId;
  const dagContext = options.swarmEnabled !== false
    ? { chatId: options.chatId, parentNodeId: orchestratorNodeId }
    : undefined;
  tools = applyGlobalToolLoopGuard(tools, dagContext);

  // Inject Swarm P2P call_agent tool if swarm is enabled
  if (options.swarmEnabled !== false) {
    // ── Swarm Reset: Clear stale UI nodes from previous turns ──────────
    publishUiSyncEvent({
      topic: "chat",
      chatId: options.chatId,
      projectId: options.projectId ?? null,
      reason: "swarm_reset",
    });

    // DAG: publish orchestrator node
    publishUiSyncEvent({
      topic: "chat",
      chatId: options.chatId,
      nodeType: "agent_node",
      swarmNode: {
        nodeId: orchestratorNodeId,
        role: "orchestrator",
        taskSummary: options.userMessage.slice(0, 120),
        status: "running",
        startedAt: new Date().toISOString(),
      },
    });

    tools.call_agent = createCallAgentTool((role, desc, extra) => {
      publishUiSyncEvent({
        topic: "chat",
        chatId: options.chatId,
        projectId: options.projectId ?? null,
        reason: `[Swarm] Queued delegation for specialized agent "${role}" (Waiting for GPU...)`,
        nodeType: "agent_node",
        swarmNode: {
          nodeId: crypto.randomUUID(),
          parentNodeId: orchestratorNodeId,
          role,
          taskSummary: desc.slice(0, 120),
          status: "queued",
        },
      });

      return agentSemaphore.run(() =>
        runSubAgent(role, desc, extra, context, settings, providerOptions, model, options.abortSignal)
      );
    });
  }

  const toolNames = Object.keys(tools);

  // Build system prompt
  let systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    chatId: options.chatId,
    agentNumber: options.agentNumber,
    tools: toolNames,
  });

  // Phase 3: "Deep Memory" System Prompt Injection
  try {
    const memorySubdir = options.projectId ? `${options.projectId}` : "main";
      const similarityThreshold = settings.memory?.similarityThreshold ?? 0.7;
      const ragResults = await searchMemory(options.userMessage, 3, similarityThreshold, memorySubdir, settings);
      
      if (ragResults && ragResults.length > 0) {
        const ragFormatted = ragResults.map((r) => `[Relevance Score: ${r.score.toFixed(2)}] (Area: ${r.metadata.area})\n${r.text}`).join("\n\n");
        systemPrompt += `\n\n<deep_memory_recall>\nYou have subconscious access to past archived conversations and vectors matching the user's current query. Use this to maintain perfect context continuity:\n\n${ragFormatted}\n</deep_memory_recall>`;
        console.log(`[RAG] Deep Memory Recall injected (${ragResults.length} chunks).`);
      }
    } catch (err) {
      console.warn(`[RAG] Failed to extract deep memory:`, err);
    }

  // Append user message to history.
  // mergeConsecutiveSameRole prevents POST_MORTEM #2 (Gemma 4 / strict-role
  // providers reject consecutive same-role messages — easy to trigger by a
  // double Send before the assistant has replied).
  const messages: ModelMessage[] = mergeConsecutiveSameRole([
    ...context.history,
    { role: "user", content: options.userMessage },
  ]);

  // ── MoA Ensemble: Collective Intelligence Layer ───────────────────────
  // The UI toggle (`swarmEnabled`) is the single source of truth here.
  // When the user enabled Swarm, we ALWAYS run the MoA flow — the Router
  // inside `runMoAEnsemble` decides whether to actually spin up 3–5 expert
  // proposers (`requiresSwarm: true`) or do a direct single-model answer
  // (`requiresSwarm: false`) based on the prompt complexity.
  //
  // Historical note: an earlier `queryNeedsMoA` regex acted as a second gate
  // here and silently overrode the UI for messages whose verbs weren't on a
  // hard-coded list ("ищи", "нашёл", "сделай", "помоги" — all rejected). It
  // defied the explicit user intent expressed by the toggle. Removed in the
  // 2026-05 fix tracked as PM #9. Routing decisions belong to the Router,
  // not to a brittle regex on the entry path.
  // PM #36 — track every LLM call's usage so the soft budget banner reflects
  // total tokens + cost across MoA + main stream. The MoA bundle bubbles up
  // its own running sum via `moaResult.cumulativeUsage`; we hold it here and
  // merge it with the streamText `onFinish` usage at save time.
  let turnExtraUsage: import("@/lib/types").ChatUsage | undefined = undefined;

  if (options.swarmEnabled !== false) {
    try {
      console.log(`[MoA] Ensemble mode active — running parallel expert consultation...`);
      const moaResult = await runMoAEnsemble({
        chatId: options.chatId,
        userMessage: options.userMessage,
        projectId: options.projectId,
        currentPath: options.currentPath,
        preset: options.preset,
        history: context.history,
        settings,
        abortSignal: options.abortSignal,
        forceSwarm: options.forceSwarm,
      });
      turnExtraUsage = moaResult.cumulativeUsage;

      if (moaResult.text && !moaResult.text.startsWith("All MoA proposer agents failed")) {
        const truncatedConsensus = moaResult.text.length > 5000
          ? moaResult.text.substring(0, 5000) + "\n\n...[TRUNCATED FOR CONTEXT LIMITS]..."
          : moaResult.text;

        systemPrompt += `\n\n## Expert Consensus (MoA)
You have access to a pre-computed consensus from ${moaResult.drafts.length} expert agents who analyzed this request in parallel.
Use this as high-quality reference material. You may adopt, modify, or override their recommendations based on your own judgment and tool results.

<expert_consensus>
${truncatedConsensus}
</expert_consensus>

Total MoA latency: ${moaResult.totalLatencyMs}ms (proposers: ${moaResult.drafts.map(d => `${d.proposerId}=${d.latencyMs}ms`).join(', ')}; aggregation: ${moaResult.aggregationLatencyMs}ms)`;

        console.log(`[MoA] Consensus injected (${truncatedConsensus.length} chars, ${moaResult.totalLatencyMs}ms total)`);
      }
    } catch (err) {
      console.warn(`[MoA] Ensemble failed, continuing with single-agent mode:`, err);
      // Tell the UI that the Swarm toggle was honored but the ensemble
      // crashed — without this event the user sees a single-agent answer
      // and assumes Swarm just decided to skip. This is observability for
      // a silent fallback path that was previously invisible.
      publishUiSyncEvent({
        topic: "chat",
        chatId: options.chatId,
        projectId: options.projectId ?? null,
        reason: `[MoA] Ensemble failed (${err instanceof Error ? err.message : "unknown error"}); continuing with single-agent mode.`,
      });
    }
  }

  logLLMRequest({
    model: `${settings.chatModel.provider}/${settings.chatModel.model}`,
    system: systemPrompt,
    messages,
    toolNames,
    temperature: settings.chatModel.temperature,
    maxTokens: settings.chatModel.maxTokens,
    label: "LLM Request (stream)",
  });

  // ── Tool Capability Detection ─────────────────────────────────────────
  // Some models (deepseek-r1, gemma3, phi4, etc.) don't support tool calling.
  // Detect this and fall back to plain chat mode gracefully.
  //
  // PM #17 — Before the audit, the OpenRouter branch only checked for
  // `deepseek-r1` while the Ollama branch consulted the broader pattern
  // list. A user picking `google/gemma-4-31b-it` via OpenRouter got 63
  // tools forwarded → 404 from OpenRouter → agent died silently after MoA
  // had already succeeded. The shared `modelSupportsTools` helper
  // (`@/lib/providers/tool-support`) is now the single source of truth for
  // every non-Ollama provider; the Ollama branch keeps its live `/api/show`
  // probe and falls back to the same helper on probe failure.
  const isOllamaProvider = resolvedModelConfig.provider === "ollama";

  let supportsTools: boolean;
  if (isOllamaProvider) {
    let detectedFromTemplate: boolean | null = null;
    try {
      const ollamaBase = (resolvedModelConfig.baseUrl || "http://localhost:11434").replace(/\/v1\/?$/, "");
      const showRes = await fetch(`${ollamaBase}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: resolvedModelConfig.model }),
        signal: AbortSignal.timeout(3000),
      });
      if (showRes.ok) {
        const showData = await showRes.json() as { template?: string };
        const template = showData.template || "";
        detectedFromTemplate = template.toLowerCase().includes("tools") || template.includes(".Tools");
      }
    } catch {
      // probe failed — fall through to the shared pattern list below.
    }
    supportsTools = detectedFromTemplate ?? modelSupportsTools(
      resolvedModelConfig.provider,
      resolvedModelConfig.model ?? ""
    );
  } else {
    supportsTools = modelSupportsTools(
      resolvedModelConfig.provider,
      resolvedModelConfig.model ?? ""
    );
  }

  // Apply tool mode decision
  const useTools = supportsTools;
  const effectiveTools = useTools ? tools : {};

  if (!useTools) {
    console.log(`[Agent] ⚠ Model "${resolvedModelConfig.model}" does not support tools → running in plain chat mode`);
    // PM #61 — the system prompt is built for TOOL mode (it mandates the
    // `response` tool, describes tool usage, goal trees, self-healing loops).
    // In plain-chat mode NO tools are forwarded, but the model still receives
    // that prompt. Tool-trained models (e.g. google/gemma-4-31b-it) then emit
    // literal `<call:tool .../>` text instead of an answer — which Orchestra
    // has no parser for, so it ships to the chat as garbage and the user sees
    // "no answer". Override the tool mandate so the model replies in prose.
    systemPrompt += PLAIN_CHAT_TOOL_OVERRIDE;
  } else {
    console.log(`[Agent] Tools enabled: ${Object.keys(tools).length} tools registered`);
  }

  try {
    // Run the agent with streaming
    const result = streamText({
    model,
    system: systemPrompt,
    messages,
    providerOptions,
    tools: effectiveTools,
    maxRetries: 3,
    ...(useTools
      ? { 
          maxSteps: MAX_TOOL_STEPS_PER_TURN,
          stopWhen: [stepCountIs(MAX_TOOL_STEPS_PER_TURN), hasToolCall("response")] 
        }
      : {}),
    temperature: settings.chatModel.temperature ?? 0.7,
    maxOutputTokens: settings.chatModel.maxTokens ?? 4096,
    abortSignal: options.abortSignal,
    onFinish: async (event) => {
      // ── Guaranteed DAG completion — even if this callback itself throws ──
      // This is the single source of truth for "agent turn done". All paths
      // (normal finish, tool-call finish, length truncation) converge here.
      let dagFinalized = false;
      const finalizeDag = (status: "completed" | "error") => {
        if (dagFinalized) return;
        dagFinalized = true;
        publishOrchestratorFinished(
          options.chatId,
          options.projectId,
          status,
          status === "completed" ? "agent_turn_finished" : "agent_turn_error"
        );
        publishUiSyncEvent({
          topic: "files",
          projectId: options.projectId ?? null,
          reason: "agent_turn_finished",
        });
      };

      try {
        const finishReason =
          typeof (event as unknown as { finishReason?: unknown }).finishReason === "string"
            ? ((event as unknown as { finishReason?: string }).finishReason as string)
            : undefined;

        const responseMessages = event.response.messages;
        // PM #36 (truncation continuation) + PM #69 (forced final answer) are
        // both decided by resolveTurnContinuation — self-contained and
        // unit-tested (final-answer-guard.test.ts). We publish any non-fatal
        // operator notice it returns and bill its usage alongside streamUsage.
        const turnExtra = await resolveTurnContinuation({
          responseMessages,
          finishReason,
          model,
          systemPrompt,
          baseMessages: messages,
          providerOptions,
          settings,
          abortSignal: options.abortSignal,
        });
        const continuationText = turnExtra.text;
        const continuationUsage = turnExtra.usage;
        if (turnExtra.uiNotice) {
          publishUiSyncEvent({
            topic: "chat",
            chatId: options.chatId,
            projectId: options.projectId ?? null,
            reason: turnExtra.uiNotice,
          });
        }

        if (mcpCleanup) {
          try { await mcpCleanup(); } catch { /* non-critical */ }
        }

        // PM #36 — collect the main streamText turn's usage. Vercel AI SDK
        // returns this in the onFinish event regardless of whether the turn
        // ended via tool-call, stop, or length. May be undefined for some
        // providers; the accumulator handles that as a zero-add.
        const streamUsage =
          (event as unknown as { usage?: import("@/lib/cost/accumulator").RawUsage })
            .usage ?? undefined;

        try {
          await updateChat(options.chatId, (chat) => {
            const now = new Date().toISOString();
            for (const msg of responseMessages) {
              chat.messages.push(...convertModelMessageToChatMessages(msg, now));
            }
            if (continuationText) {
              chat.messages.push({
                id: crypto.randomUUID(),
                role: "assistant",
                content: stripThinkingTags(continuationText),
                createdAt: now,
              });
            }
            chat.updatedAt = now;
            const userMessageCount = chat.messages.filter(m => m.role === "user").length;
            if (userMessageCount === 1 && chat.title === "New Chat") {
              chat.title =
                options.userMessage.slice(0, 60) +
                (options.userMessage.length > 60 ? "..." : "");
            }
            // PM #36 — fold ALL of this turn's billing surfaces (main stream
            // + auto-continuation + MoA bundle) into the running per-chat
            // cumulative via the single accounting helper. Resolved chat-model
            // identity comes from `resolvedModelConfig`; the continuation reuses
            // the same model handle, so the pricing lookup is unambiguous.
            chat.cumulativeUsage = foldTurnUsage(
              chat.cumulativeUsage,
              resolvedModelConfig.provider,
              resolvedModelConfig.model,
              { streamUsage, continuationUsage, turnExtraUsage }
            );
            return chat;
          });
        } catch (saveErr) {
          console.error("[Agent] Failed to save chat after turn:", saveErr);
          // Non-critical: don't block DAG finalization
        }

        finalizeDag("completed");
      } catch (onFinishErr) {
        // onFinish itself crashed — still must finalize the DAG
        console.error("[Agent] onFinish error:", onFinishErr);
        finalizeDag("error");
      }
    },
    onError: ({ error }) => {
      // Called when the stream itself errors (network cut, provider timeout, etc.)
      // This fires even when SSE disconnects mid-stream, so we guarantee DAG cleanup.
      //
      // PM #17 / Sprint 3 — this is the path that previously left the user
      // staring at a blank chat pane. The Vercel SDK's `streamText` swallowed
      // the upstream 404 (no endpoints support tool use) into the stream
      // and the frontend never rendered anything. Now we ALSO publish a
      // structured `chat-error` event so the UI knows what happened.
      //
      // 2026-05 — added auto-fallback: when the failure shape matches
      // "model deprecated / no tool support", try to pick a replacement
      // model from the same provider, persist it to settings, and
      // surface a friendly `model_fallback` notification instead of a
      // hard error. The user's next message uses the new model
      // automatically. We intentionally do NOT retry the current turn
      // (would mean double LLM cost and complex stream replay).
      const payload = classifyChatError(error, getCurrentTraceId());
      log.error("agent_stream_error", {
        chatId: options.chatId,
        projectId: options.projectId,
        kind: payload.kind,
        message: payload.message,
        err: error instanceof Error ? error : new Error(String(error)),
      });

      // Fire-and-forget — we want the rest of onError to run synchronously
      // (DAG cleanup, postmortem dump, sync events) while the fallback
      // lookup happens in the background. If fallback succeeds, it
      // publishes its own `model_fallback` chat-error event AFTER the
      // PM #17 error event, so the UI sees both: "something failed" and
      // then "we switched models for next time".
      void attemptModelFallback(error, settings, options.chatId, options.projectId);

      publishChatErrorEvent({
        chatId: options.chatId,
        projectId: options.projectId,
        payload,
      });
      // Sprint 5 — durable forensic snapshot. Best-effort, never throws.
      // The .catch is belt-and-braces around a function whose own contract
      // already guarantees no-throw; we keep it so a regression in the
      // contract can't poison the SSE stream's onError path.
      const traceId = getCurrentTraceId();
      if (traceId) {
        void dumpPostmortem({
          traceId,
          chatId: options.chatId,
          projectId: options.projectId,
          request: {
            userMessage: options.userMessage,
            swarmEnabled: options.swarmEnabled !== false,
            preset: options.preset,
            currentPath: options.currentPath,
          },
          settings,
          errorClassification: payload,
          err: error,
        }).catch(() => undefined);
      }
      publishOrchestratorFinished(
        options.chatId,
        options.projectId,
        "error",
        "agent_stream_error"
      );
      publishUiSyncEvent({
        topic: "files",
        projectId: options.projectId ?? null,
        reason: "agent_turn_finished",
      });
    },
  });

  return result;

  } catch (error) {
    // PM #17 / Sprint 3 — same surface contract as the `onError` path above:
    // (1) structured log line carrying the trace-id, (2) structured chat
    // error event so the UI shows something actionable, (3) DAG cleanup,
    // (4) re-throw so the route handler can return a non-200.
    const payload = classifyChatError(error, getCurrentTraceId());
    log.error("agent_fatal_error", {
      chatId: options.chatId,
      projectId: options.projectId,
      kind: payload.kind,
      message: payload.message,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    publishChatErrorEvent({
      chatId: options.chatId,
      projectId: options.projectId,
      payload,
    });
    // Sprint 5 — durable forensic snapshot for the fatal-catch path.
    // Awaited (not fire-and-forget) here because we're inside a regular
    // try/catch and the `await` cannot prevent the rethrow below.
    const fatalTraceId = getCurrentTraceId();
    if (fatalTraceId) {
      try {
        await dumpPostmortem({
          traceId: fatalTraceId,
          chatId: options.chatId,
          projectId: options.projectId,
          request: {
            userMessage: options.userMessage,
            swarmEnabled: options.swarmEnabled !== false,
            preset: options.preset,
            currentPath: options.currentPath,
          },
          settings,
          errorClassification: payload,
          err: error,
        });
      } catch {
        // dumpPostmortem already swallows internally; this catch is the
        // outer belt-and-braces against a future regression of that
        // contract.
      }
    }

    if (mcpCleanup) {
      try { await mcpCleanup(); } catch { /* non-critical */ }
    }

    if (options.swarmEnabled !== false) {
      publishUiSyncEvent({
        topic: "chat",
        chatId: options.chatId,
        nodeType: "agent_node",
        swarmNode: {
          nodeId: options.chatId,
          role: "orchestrator",
          status: "error",
          taskSummary: `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
          completedAt: new Date().toISOString(),
        },
      });
    }

    throw error;
  }
}

/**
 * Non-streaming agent turn for background tasks (cron/scheduler).
 */
export async function runAgentText(options: {
  chatId: string;
  userMessage: string;
  projectId?: string;
  currentPath?: string;
  agentNumber?: number;
  runtimeData?: Record<string, unknown>;
  /**
   * PM #23 follow-up — non-interactive entry path. Caller (cron runtime, the
   * Telegram-relay external-message handler, etc.) owns the lifetime of the
   * AbortController. Pass `undefined` for fire-and-forget background jobs.
   * The signal is plumbed straight into the inner `generateText` call so a
   * cancelled cron tick or a disconnected Telegram webhook actually stops
   * the upstream LLM stream instead of completing and silently billing.
   */
  abortSignal?: AbortSignal;
}): Promise<string> {
  const settings = await getSettings();
  // PM #47 — Privacy Mode air-gap must hold on EVERY LLM entry point, not
  // just the interactive `runAgent`. This is the cron + Telegram-relay path
  // (the Telegram webhook is unauthenticated); without the guard a cloud
  // `chatModel` would silently ship user data off-box while the UI shows
  // Privacy Mode ON.
  assertPrivacyModeAllowsSettings(settings);
  const providerOptions = resolveModelProviderOptions(settings.chatModel.provider);
  const model = createModel(settings.chatModel, {
    projectId: options.projectId,
    currentPath: options.currentPath,
  });

  const workDir = await resolveWorkDirForProject(options.projectId);
  const context: AgentContext = {
    chatId: options.chatId,
    projectId: options.projectId,
    currentPath: options.currentPath,
    workDir,
    memorySubdir: options.projectId ? `${options.projectId}` : "main",
    knowledgeSubdirs: options.projectId ? [`${options.projectId}`, "main"] : ["main"],
    history: [],
    agentNumber: options.agentNumber ?? 0,
    data: {
      ...(options.runtimeData ?? {}),
      currentUserMessage: options.userMessage,
    },
  };

  const chat = await getChat(options.chatId);
  if (chat) {
    const allMessages = convertChatMessagesToModelMessages(chat.messages);
    const history = new History(80);
    history.addMany(allMessages);
    context.history = history.getAll();
  }

  const baseTools = createAgentTools(context, settings);
  let mcpCleanup: (() => Promise<void>) | undefined;
  let tools = baseTools;
  if (options.projectId) {
    const mcp = await getProjectMcpTools(options.projectId);
    if (mcp) {
      tools = { ...baseTools, ...mcp.tools };
      mcpCleanup = mcp.cleanup;
    }
  }
  tools = applyGlobalToolLoopGuard(tools);
  const toolNames = Object.keys(tools);

  const systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    chatId: options.chatId,
    agentNumber: options.agentNumber,
    tools: toolNames,
  });

  const messages: ModelMessage[] = mergeConsecutiveSameRole([
    ...context.history,
    { role: "user", content: options.userMessage },
  ]);

  logLLMRequest({
    model: `${settings.chatModel.provider}/${settings.chatModel.model}`,
    system: systemPrompt,
    messages,
    toolNames,
    temperature: settings.chatModel.temperature,
    maxTokens: settings.chatModel.maxTokens,
    label: "LLM Request (non-stream)",
  });

  try {
    const generated = await generateText({
      model,
      system: systemPrompt,
      messages,
      providerOptions,
      tools,
      maxRetries: 3,
      stopWhen: [stepCountIs(MAX_TOOL_STEPS_PER_TURN), hasToolCall("response")],
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: settings.chatModel.maxTokens ?? 4096,
      abortSignal: options.abortSignal,
    });

    const responseMessages = (
      generated as unknown as { response?: { messages?: ModelMessage[] } }
    ).response?.messages;

    const text = generated.text ?? "";
    const fallbackReply =
      Array.isArray(responseMessages) && responseMessages.length > 0
        ? getLastResponseToolText(responseMessages) || getLastAssistantText(responseMessages)
        : "";
    // PM #61 — runAgentText powers cron + the Telegram reply; unwrap a
    // serialized `response` call so those channels never ship a raw JSON blob.
    const finalText = unwrapSerializedResponseCall(text.trim() ? text : fallbackReply);

    try {
      await updateChat(options.chatId, (latest) => {
        const now = new Date().toISOString();
        latest.messages.push({
          id: crypto.randomUUID(),
          role: "user",
          content: options.userMessage,
          createdAt: now,
        });

        if (Array.isArray(responseMessages) && responseMessages.length > 0) {
          for (const msg of responseMessages) {
            latest.messages.push(...convertModelMessageToChatMessages(msg, now));
          }
        } else {
          latest.messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: stripThinkingTags(finalText),
            createdAt: now,
          });
        }

        latest.updatedAt = now;
        return latest;
      });
    } catch {
      // Non-critical for background runs.
    }

    publishUiSyncEvent({
      topic: "files",
      projectId: options.projectId ?? null,
      reason: "agent_turn_finished",
    });

    return finalText;
  } finally {
    if (mcpCleanup) {
      try {
        await mcpCleanup();
      } catch {
        // non-critical
      }
    }
  }
}

/**
 * Run agent for subordinate delegation (non-streaming, returns result)
 */
export interface SubordinateResult {
  /** The trimmed text response to surface back to the parent agent. */
  text: string;
  /**
   * Sprint 8 — billing-correctness fix. Pre-Sprint-8 the subordinate's
   * generateText `usage` was THROWN AWAY, so subordinate token spend
   * never reached `parent.cumulativeUsage` and the per-chat USD cap was
   * blind to it. Returning it here lets `callSubordinate` accumulate
   * the spend back into the parent chat via `addUsageToCumulative`.
   *
   * `undefined` only on the rare path where `generateText` doesn't
   * surface a usage object (e.g. provider didn't include it).
   */
  usage?: import("@/lib/cost/accumulator").RawUsage;
  /**
   * Resolved model identity (provider + model) for the subordinate's
   * generateText call. Needed by the accumulator to look up per-token
   * pricing — different providers price the same token count differently.
   */
  provider: string;
  model: string;
}

export async function runSubordinateAgent(options: {
  task: string;
  projectId?: string;
  parentAgentNumber: number;
  parentHistory: ModelMessage[];
  /**
   * PM #23 — the parent agent's `req.signal`, plumbed through the
   * `call_subordinate` tool. When the user cancels the parent chat, the
   * subordinate's inner generateText call must abort too — otherwise the
   * subordinate keeps streaming tokens while no one's listening.
   */
  abortSignal?: AbortSignal;
  /**
   * Sprint 9 — the REAL parent chat id (top-level chat that originated
   * the agent run). Required for the recursive-subordinate path:
   *   - level 0 (top): runs in `context.chatId = realChatId`
   *   - level 1 (subordinate): if absent here, used to construct a
   *     synthetic `subordinate-${Date.now()}` for context.chatId →
   *     budget-check + spend bubble-up would target a phantom chat
   *     that doesn't exist on disk → `updateChat` silent no-op
   *     → REAL parent's `cumulativeUsage` never sees the spend.
   *   - level 2 (subordinate of subordinate): same problem, doubly so.
   *
   * Sprint 8 closed the LEVEL-1 leak by accumulating in
   * `callSubordinate`. Sprint 9 closes the LEVEL-2+ leak by propagating
   * the real parent id ALL THE WAY DOWN. Now every level's
   * `enforceChatBudget` + spend bubble-up targets the same real chat.
   *
   * Backwards-compat: optional + falls back to the synthetic id (the
   * pre-Sprint-9 behavior). Production callers (`callSubordinate`)
   * always pass it now.
   */
  parentChatId?: string;
}): Promise<SubordinateResult> {
  const settings = await getSettings();
  // PM #47 — defense-in-depth: the subordinate is normally entered via a
  // parent `runAgent` that already enforced the air-gap, but the recursive
  // path (Sprint 9) and any future direct caller must not be able to reach
  // a cloud provider with Privacy Mode ON. One line, settings already in scope.
  assertPrivacyModeAllowsSettings(settings);
  const providerOptions = resolveModelProviderOptions(settings.chatModel.provider);
  const model = createModel(settings.chatModel, {
    projectId: options.projectId,
  });

  const workDir = await resolveWorkDirForProject(options.projectId);
  const context: AgentContext = {
    // Sprint 9 — use the REAL parent chat id so deeper-level recursive
    // subordinates also see the real chat for budget + bubble-up.
    // Fallback synthetic id retained for the unusual case of a caller
    // that doesn't pass parentChatId (no production caller; defensive).
    chatId: options.parentChatId ?? `subordinate-${Date.now()}`,
    projectId: options.projectId,
    workDir,
    memorySubdir: options.projectId
      ? `projects/${options.projectId}`
      : "main",
    knowledgeSubdirs: options.projectId
      ? [`projects/${options.projectId}`, "main"]
      : ["main"],
    history: [],
    agentNumber: options.parentAgentNumber + 1,
    data: {},
  };

  let tools = createAgentTools(context, settings);
  let mcpCleanupSub: (() => Promise<void>) | undefined;
  if (options.projectId) {
    const mcp = await getProjectMcpTools(options.projectId);
    if (mcp) {
      tools = { ...tools, ...mcp.tools };
      mcpCleanupSub = mcp.cleanup;
    }
  }
  tools = applyGlobalToolLoopGuard(tools);
  const toolNames = Object.keys(tools);

  const systemPrompt = await buildSystemPrompt({
    projectId: options.projectId,
    agentNumber: context.agentNumber,
    tools: toolNames,
  });

  // Include relevant parent history for context
  const relevantHistory = options.parentHistory.slice(-6);

  const messages: ModelMessage[] = mergeConsecutiveSameRole([
    ...relevantHistory,
    {
      role: "user",
      content: `You are a subordinate agent. Complete this task and report back:\n\n${options.task}`,
    },
  ]);

  logLLMRequest({
    model: `${settings.chatModel.provider}/${settings.chatModel.model}`,
    system: systemPrompt,
    messages,
    toolNames,
    temperature: settings.chatModel.temperature,
    maxTokens: settings.chatModel.maxTokens,
    label: "LLM Request (subordinate)",
  });

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages,
      providerOptions,
      tools,
      maxRetries: 3,
      stopWhen: [stepCountIs(MAX_TOOL_STEPS_SUBORDINATE), hasToolCall("response")],
      temperature: settings.chatModel.temperature ?? 0.7,
      maxOutputTokens: settings.chatModel.maxTokens ?? 4096,
      abortSignal: options.abortSignal,
    });
    const responseMessages = (
      result as unknown as { response?: { messages?: ModelMessage[] } }
    ).response?.messages;

    // PM #61 — unwrap a text-serialized `response` call before the subordinate
    // result flows back into the parent agent's context.
    const responseText = unwrapSerializedResponseCall(
      (Array.isArray(responseMessages) && responseMessages.length > 0)
        ? getLastResponseToolText(responseMessages) || result.text
        : result.text
    );

    const text =
      responseText.trim() || "Subordinate agent finished but returned no text.";

    return {
      text,
      // Vercel AI SDK's GenerateTextResult exposes `usage` as the
      // top-level token tally; we forward it verbatim so the parent
      // chat's `addUsageToCumulative` can apply provider pricing.
      usage: (result as unknown as { usage?: import("@/lib/cost/accumulator").RawUsage }).usage,
      provider: settings.chatModel.provider,
      model: settings.chatModel.model,
    };
  } finally {
    if (mcpCleanupSub) {
      try {
        await mcpCleanupSub();
      } catch {
        // non-critical
      }
    }
  }
}
