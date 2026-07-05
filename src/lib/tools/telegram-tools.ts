import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import type { AgentContext } from "@/lib/agent/types";
import { combineWithTimeout } from "@/lib/util/abort-signal";
import { resolveOutgoingFilePath } from "@/lib/tools/tool-paths";

/**
 * Telegram runtime tool family: telegram_send_file, registered only when the
 * agent context carries Telegram runtime data (bot token + chat id).
 * Extracted verbatim from `tool.ts` (§10 decomposition, PR 2).
 */

const TELEGRAM_SEND_FILE_MAX_BYTES = 45 * 1024 * 1024;

interface TelegramRuntimeData {
  botToken: string;
  chatId: string | number;
}

function getTelegramRuntimeData(context: AgentContext): TelegramRuntimeData | null {
  const raw = context.data?.telegram;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const botToken = typeof record.botToken === "string" ? record.botToken.trim() : "";
  const chatIdRaw = record.chatId;
  const chatId =
    typeof chatIdRaw === "string" || typeof chatIdRaw === "number"
      ? chatIdRaw
      : null;
  if (!botToken || chatId === null) return null;
  return { botToken, chatId };
}

export function createTelegramTools(context: AgentContext): ToolSet {
  const telegramRuntime = getTelegramRuntimeData(context);
  if (!telegramRuntime) {
    return {};
  }

  const tools: ToolSet = {};

  tools.telegram_send_file = tool({
    description:
      "Send a local file to the current Telegram chat as a document. Use this when the user asks to send/download a file in Telegram.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("Absolute path to the file, or path relative to current project cwd."),
      caption: z
        .string()
        .optional()
        .describe("Optional caption to include with the file."),
    }),
    execute: async ({ file_path, caption }, { abortSignal }) => {
      try {
        const resolvedPath = resolveOutgoingFilePath(context, file_path);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return {
            success: false,
            error: `Path is not a file: ${resolvedPath}`,
          };
        }
        if (stat.size > TELEGRAM_SEND_FILE_MAX_BYTES) {
          return {
            success: false,
            error: `File is too large (${stat.size} bytes). Max allowed is ${TELEGRAM_SEND_FILE_MAX_BYTES} bytes.`,
          };
        }

        const fileBuffer = await fs.readFile(resolvedPath);
        const form = new FormData();
        form.append("chat_id", String(telegramRuntime.chatId));
        form.append(
          "document",
          new Blob([fileBuffer]),
          path.basename(resolvedPath)
        );
        const trimmedCaption = caption?.trim();
        if (trimmedCaption) {
          form.append("caption", trimmedCaption);
        }

        // PM #1 residual gap fix: large file uploads on a slow network
        // could otherwise pin the agent indefinitely. `combineWithTimeout`
        // always honors both the caller's abortSignal AND a 60s safety
        // timeout, including on Node 20.0–20.2 where AbortSignal.any is
        // missing (see Defect #5 in the 2026-05 audit).
        const TELEGRAM_UPLOAD_TIMEOUT_MS = 60_000;
        const fetchSignal = combineWithTimeout(abortSignal, TELEGRAM_UPLOAD_TIMEOUT_MS);

        const response = await fetch(
          `https://api.telegram.org/bot${telegramRuntime.botToken}/sendDocument`,
          {
            method: "POST",
            body: form,
            signal: fetchSignal,
          }
        );
        const payload = (await response.json().catch(() => null)) as
          | {
              ok?: boolean;
              description?: string;
              result?: {
                document?: {
                  file_id?: string;
                  file_name?: string;
                  file_size?: number;
                };
              };
            }
          | null;

        if (!response.ok || !payload?.ok) {
          return {
            success: false,
            error: `Telegram sendDocument failed (${response.status})${payload?.description ? `: ${payload.description}` : ""}`,
          };
        }

        return {
          success: true,
          message: "File sent to Telegram successfully.",
          path: resolvedPath,
          name: payload.result?.document?.file_name || path.basename(resolvedPath),
          size: payload.result?.document?.file_size ?? stat.size,
          telegramFileId: payload.result?.document?.file_id ?? null,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to send file to Telegram.",
        };
      }
    },
  });

  return tools;
}
