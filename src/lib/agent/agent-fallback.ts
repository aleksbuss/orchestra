import {
  classifyModelError,
  pickFallbackModel,
  describeFallback,
} from "@/lib/providers/model-fallback";
import { publishChatErrorEvent } from "@/lib/realtime/event-bus";
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
