/**
 * Does the turn's chat model actually support tool calling?
 *
 * Extracted from `agent.ts` (rule 25 — that file is the one recorded file-size
 * exception and may not grow). Nothing about the logic changed in the move; the
 * Ollama live probe still lives here rather than in
 * `@/lib/providers/tool-support` because that module is deliberately
 * synchronous and side-effect-free, and this one does I/O.
 *
 * PM #17 — before the audit, the OpenRouter branch checked ONLY for
 * `deepseek-r1` while the Ollama branch consulted the broader pattern list. A
 * user picking `google/gemma-4-31b-it` via OpenRouter got 63 tools forwarded →
 * 404 from OpenRouter → the agent died silently AFTER MoA had already produced
 * a consensus. `modelSupportsTools` is the single source of truth for every
 * non-Ollama provider (rule 17 — never inline a per-provider capability check);
 * the Ollama branch keeps its live `/api/show` probe and falls back to the same
 * helper when the probe fails.
 *
 * PM #98 — this detection was never the bug in the Free Mode hang. It reported
 * "no tools" correctly and loudly; what was missing was anything UPSTREAM that
 * cared. See `free-mode.ts` for the selection-side fix.
 */
import type { ModelConfig } from "@/lib/types";
import { modelSupportsTools } from "@/lib/providers/tool-support";

/** Milliseconds allowed for the Ollama `/api/show` capability probe. */
const OLLAMA_PROBE_TIMEOUT_MS = 3000;

/**
 * Resolve tool support for a chat model, probing Ollama live when applicable.
 *
 * Never throws and never returns `undefined`: a failed probe degrades to the
 * shared pattern list, because refusing the turn over a capability question is
 * worse than running it with the best available guess.
 */
export async function detectToolSupport(config: ModelConfig): Promise<boolean> {
  const modelId = config.model ?? "";

  if (config.provider !== "ollama") {
    return modelSupportsTools(config.provider, modelId);
  }

  // Local Ollama users frequently install tool-capable forks of the same base
  // model, so the live template beats any substring list we could write.
  let detectedFromTemplate: boolean | null = null;
  try {
    const ollamaBase = (config.baseUrl || "http://localhost:11434").replace(/\/v1\/?$/, "");
    const showRes = await fetch(`${ollamaBase}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model }),
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    if (showRes.ok) {
      const showData = (await showRes.json()) as { template?: string };
      const template = showData.template || "";
      detectedFromTemplate =
        template.toLowerCase().includes("tools") || template.includes(".Tools");
    }
  } catch {
    // probe failed (offline, timed out, model not pulled) — fall through.
  }

  return detectedFromTemplate ?? modelSupportsTools(config.provider, modelId);
}
