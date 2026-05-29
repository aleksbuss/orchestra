import { NextRequest } from "next/server";
import { runAgent } from "@/lib/agent/agent";
import { createChat, getChat, saveChat } from "@/lib/storage/chat-store";
import { ensureCronSchedulerStarted } from "@/lib/cron/runtime";
import { dispatchAgentJob } from "@/lib/agent/daemon";
import { log, withLogContext } from "@/lib/observability/logger";
import { getSettings } from "@/lib/storage/settings-store";
import {
  ChatBudgetExceededError,
  assertChatBudget,
} from "@/lib/cost/accumulator";
import type { ChatMessage } from "@/lib/types";
import type { PresetTier } from "@/lib/agent/presets";

export const maxDuration = 300; // 5 min max for long agent runs

export async function POST(req: NextRequest) {
  // PM #17 / Sprint 3 — every chat turn gets a `traceId`. AsyncLocalStorage
  // propagates it down the entire await chain, so any `log.*` from runAgent,
  // moa.ts, tools, etc. is automatically tagged. Reading "what happened in
  // turn X" is `jq 'select(.traceId == "...")' data/logs/*.jsonl`.
  const traceId = crypto.randomUUID();

  return withLogContext({ traceId, module: "chat-api" }, async () => {
    try {
      await ensureCronSchedulerStarted();
      const body = await req.json();
      const { chatId, projectId, currentPath, background, swarmEnabled, forceSwarm } = body;
      const preset: PresetTier | undefined = body.preset;
      let message: string | undefined = body.message;

      // Support AI SDK's DefaultChatTransport format which sends a `messages` array
      if (!message && Array.isArray(body.messages)) {
        const lastUserMsg = [...body.messages]
          .reverse()
          .find((m: Record<string, unknown>) => m.role === "user");
        if (lastUserMsg) {
          if (typeof lastUserMsg.content === "string") {
            message = lastUserMsg.content;
          } else if (Array.isArray(lastUserMsg.parts)) {
            message = lastUserMsg.parts
              .filter((p: Record<string, unknown>) => p.type === "text")
              .map((p: Record<string, string>) => p.text)
              .join("");
          }
        }
      }

      if (!message || typeof message !== "string") {
        return Response.json(
          { error: "Message is required" },
          { status: 400 }
        );
      }

      // Create chat if needed
      let resolvedChatId = chatId;
      if (!resolvedChatId) {
        resolvedChatId = crypto.randomUUID();
        await createChat(resolvedChatId, "New Chat", projectId);
      } else {
        const existing = await getChat(resolvedChatId);
        if (!existing) {
          await createChat(resolvedChatId, "New Chat", projectId);
        }
      }

      // Sprint 2 — per-chat hard USD cap (companion to the PM #36 soft
      // banner). Reads `settings.costGuard.maxUsdPerChat`; if a positive
      // number is set AND the chat's cumulativeUsage.costUsd is already
      // at or above it, refuse the turn with 402 Payment Required.
      // Applies BEFORE the interactive vs background branch so neither
      // path can bypass the cap. No-op when unconfigured (the default).
      try {
        const settings = await getSettings();
        const cap = settings.costGuard?.maxUsdPerChat;
        if (typeof cap === "number" && cap > 0) {
          const current = await getChat(resolvedChatId);
          assertChatBudget(current?.cumulativeUsage, cap);
        }
      } catch (err) {
        if (err instanceof ChatBudgetExceededError) {
          log.warn("chat_budget_exceeded", {
            chatId: resolvedChatId,
            costUsd: err.costUsd,
            maxUsdPerChat: err.maxUsdPerChat,
          });
          return Response.json(
            {
              error: "chat_budget_exceeded",
              message: err.message,
              costUsd: err.costUsd,
              maxUsdPerChat: err.maxUsdPerChat,
            },
            { status: 402 }
          );
        }
        // Settings read failure: don't block the chat. Surface as a log
        // line so the operator can fix the settings.json corruption; the
        // soft budget banner is already a robust fallback if pricing
        // computation fails downstream.
        log.warn("chat_budget_check_failed", {
          chatId: resolvedChatId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      log.info("chat_turn_started", {
        chatId: resolvedChatId,
        projectId,
        background: background === true,
        swarmEnabled: swarmEnabled ?? true,
        preset,
        messageLength: message.length,
      });

      if (background === true) {
        // Background Mode (Phase 3 Daemon)
        const chat = await getChat(resolvedChatId);
        if (chat) {
          const userMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: "user",
            content: message,
            createdAt: new Date().toISOString(),
          };
          chat.messages.push(userMsg);
          await saveChat(chat);
        }

        // Dispatch and forget
        dispatchAgentJob({
          chatId: resolvedChatId,
          userMessage: message,
          projectId,
          currentPath: typeof currentPath === "string" ? currentPath : undefined,
          swarmEnabled: swarmEnabled ?? true,
          // PM #22 follow-up: same override the interactive branch receives at
          // L114. Dropping this here was the silent half of the bug — a user
          // with Force ON who flipped to Auto-Pilot lost their override the
          // moment the Router decided `requiresSwarm: false`.
          forceSwarm: forceSwarm === true,
          preset,
        });

        return Response.json({
          success: true,
          status: "queued",
          chatId: resolvedChatId,
          traceId,
          message: "Background job successfully queued.",
        });
      }

      // Interactive Mode (Stream to UI)
      // Bind req.signal so closing the browser tab aborts the LLM stream
      // (POST_MORTEM #1: zombie streams from missing AbortSignal pass-through).
      const result = await runAgent({
        chatId: resolvedChatId,
        userMessage: message,
        projectId,
        currentPath: typeof currentPath === "string" ? currentPath : undefined,
        swarmEnabled: swarmEnabled ?? true,
        forceSwarm: forceSwarm === true,
        preset,
        abortSignal: req.signal,
      });

      return result.toUIMessageStreamResponse({
        headers: {
          "X-Chat-Id": resolvedChatId,
          // Surface the trace-id to the client. The frontend stamps it on
          // any error toast it renders, so a user reporting "this broke"
          // can copy/paste a single string and we grep `data/logs/*.jsonl`
          // for the full server-side story.
          "X-Trace-Id": traceId,
        },
      });
    } catch (error) {
      log.error("chat_api_unhandled_error", {
        err: error instanceof Error ? error : new Error(String(error)),
      });
      return Response.json(
        {
          error: error instanceof Error ? error.message : "Internal server error",
          traceId,
        },
        { status: 500 }
      );
    }
  });
}
