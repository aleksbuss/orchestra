import {
  classifyModelError,
  pickFallbackModel,
  describeFallback,
} from "@/lib/providers/model-fallback";
import { publishChatErrorEvent, publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { saveSettings } from "@/lib/storage/settings-store";
import { getCurrentTraceId, log } from "@/lib/observability/logger";
import type { AppSettings } from "@/lib/types";

/**
 * §10 agent.ts decomposition — the model auto-fallback seam (PR-1).
 *
 * This is the agent-side ORCHESTRATION of fallback (classify → pick → persist →
 * notify). The provider-side primitives it composes (`classifyModelError`,
 * `pickFallbackModel`, `describeFallback`) live in
 * [`providers/model-fallback.ts`](../providers/model-fallback.ts) and keep their
 * own tests; this file only wires them to settings persistence + the UI event
 * bus. Extracted from `agent.ts` verbatim (behavior-preserving) so the
 * orchestration core shrinks and the fallback path gets a focused unit test
 * ([`agent-fallback.test.ts`](./agent-fallback.test.ts)) instead of only
 * indirect integration coverage. PM #17 lives here — keep the failure-kind
 * branches honest.
 */

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
export async function attemptModelFallback(
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
      await persistNoCandidateNotice(chatId, projectId, chatModel.provider, chatModel.model);
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

/**
 * Leave the user something to read when a turn dies with nowhere to fall back to.
 *
 * `agent_fallback_no_candidate` used to be a log line and nothing else. Measured
 * on 2026-08-25 with Free Mode on and every free endpoint's circuit already
 * OPEN: a 15-turn run produced **15 user messages and zero assistant messages**
 * — the chat simply stayed silent, turn after turn. The system was behaving
 * correctly at every step (it detected the upstream 4xx, tried to fail over,
 * found no healthy substitute, and refused to invent an answer) and the only
 * thing missing was telling the person that.
 *
 * Silence is the worst possible rendering of that state: it is indistinguishable
 * from a hang, and it is exactly what a first-time visitor on the free tier
 * meets when the shared endpoints are exhausted.
 *
 * Written only when the turn delivered NOTHING — if the last message is already
 * an assistant message, some other path (the daemon's own error write, a partial
 * answer, a degradation notice) has spoken and this must not talk over it.
 */
async function persistNoCandidateNotice(
  chatId: string,
  projectId: string | null | undefined,
  provider: string,
  failedModel: string
): Promise<void> {
  try {
    const { getChat, updateChat } = await import("@/lib/storage/chat-store");
    const chat = await getChat(chatId);
    const last = chat?.messages?.[chat.messages.length - 1];
    if (!chat || !last || last.role !== "user") return;

    await updateChat(chatId, (c) => {
      c.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          `**No answer this turn — the model endpoint failed and there was nothing to fall back to.**\n\n` +
          `\`${provider}/${failedModel}\` returned an error, and every alternative endpoint is ` +
          `currently circuit-broken (usually: the free tier is exhausted or rate-limited).\n\n` +
          `Nothing was lost — your message is saved. What helps:\n` +
          `- wait a few minutes for the endpoints to recover, or\n` +
          `- turn Free Mode off and use a model you hold a key for, or\n` +
          `- point the chat model at a different provider in Settings.\n\n` +
          `_Orchestra does not fabricate an answer when it has no model to produce one._`,
        createdAt: new Date().toISOString(),
      });
      return c;
    });

    publishUiSyncEvent({
      topic: "chat",
      chatId,
      projectId: projectId ?? null,
      reason: "[Agent] No fallback candidate — turn produced no answer.",
    });
  } catch (err) {
    // Never let the notice itself break the error path it is reporting on.
    log.warn("agent_fallback_notice_failed", {
      chatId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
