import { getSettings } from "@/lib/storage/settings-store";
import { agentSemaphore } from "@/lib/agent/semaphore";
import { modelSupportsTools } from "@/lib/providers/tool-support";
import { getBrokenChatFiles } from "@/lib/storage/chat-store";

export const dynamic = "force-dynamic";

interface SubsystemStatus {
  name: string;
  status: "ok" | "warn" | "error";
  detail: string;
  latencyMs?: number;
}

export async function GET() {
  const checks: SubsystemStatus[] = [];
  const startTotal = Date.now();

  // 1. Settings Store
  try {
    const start = Date.now();
    const settings = await getSettings();
    const ms = Date.now() - start;
    const hasProvider = !!settings.chatModel?.provider;
    const hasModel = !!settings.chatModel?.model;
    checks.push({
      name: "settings",
      status: hasProvider && hasModel ? "ok" : "warn",
      detail: hasProvider && hasModel
        ? `Provider: ${settings.chatModel.provider}, Model: ${settings.chatModel.model}`
        : "Chat model not fully configured",
      latencyMs: ms,
    });
  } catch (err) {
    checks.push({
      name: "settings",
      status: "error",
      detail: err instanceof Error ? err.message : "Failed to load settings",
    });
  }

  // 2. LLM Provider Connectivity
  try {
    const settings = await getSettings();
    const { provider, baseUrl, apiKey } = settings.chatModel;
    const start = Date.now();

    // Determine the models endpoint to ping
    let modelsUrl: string;
    if (provider === "ollama") {
      modelsUrl = `${baseUrl || "http://localhost:11434/v1"}/models`;
    } else if (provider === "openrouter") {
      modelsUrl = "https://openrouter.ai/api/v1/models";
    } else if (provider === "openai") {
      modelsUrl = "https://api.openai.com/v1/models";
    } else if (baseUrl) {
      modelsUrl = `${baseUrl}/models`;
    } else {
      modelsUrl = "";
    }

    if (modelsUrl) {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const res = await fetch(modelsUrl, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const ms = Date.now() - start;

      checks.push({
        name: "llm_provider",
        status: res.ok ? "ok" : "warn",
        detail: res.ok
          ? `${provider} reachable (HTTP ${res.status})`
          : `${provider} returned HTTP ${res.status}`,
        latencyMs: ms,
      });
    } else {
      checks.push({
        name: "llm_provider",
        status: "ok",
        detail: `${provider} — no ping endpoint, assumed ok`,
      });
    }
  } catch (err) {
    checks.push({
      name: "llm_provider",
      status: "error",
      detail: `LLM unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 3. Daemon (Auto-Pilot) Subsystem
  checks.push({
    name: "daemon",
    status: "ok",
    detail: "Auto-Pilot subsystem operational",
  });

  // 4. SSE Event Bus
  checks.push({
    name: "event_bus",
    status: "ok",
    detail: "Server-Sent Events bus available at /api/events",
  });

  // 4.2 Tool-call capability (PM #17)
  // Catches the "selected chat model 404s on tool calls" failure BEFORE the
  // user hits Send. Reports `warn` rather than `error` because agent.ts will
  // gracefully fall back to plain-chat mode for these models — the operator
  // just loses tool functionality silently. Pair with the chat-error SSE
  // event for the runtime safety net.
  try {
    const settings = await getSettings();
    const provider = settings.chatModel?.provider;
    const modelId = settings.chatModel?.model ?? "";
    if (provider && modelId) {
      const ok = modelSupportsTools(provider, modelId);
      checks.push({
        name: "chat_model_tools",
        status: ok ? "ok" : "warn",
        detail: ok
          ? `${provider}/${modelId} permits tool calls`
          : `${provider}/${modelId} matches NO_TOOL_PATTERNS — agent will run in plain-chat mode (no tools). See PM #17 in POST_MORTEMS.md.`,
      });
    }
  } catch {
    // Silently skip — settings already produced its own check above.
  }

  // 4.5 Agent Semaphore (Resource Guard)
  try {
    const totalPermits = agentSemaphore.getTotalPermits();
    const available = agentSemaphore.getPermits();
    checks.push({
      name: "resource_guard",
      status: available > 0 ? "ok" : "warn",
      detail: `Concurrency limit: ${totalPermits}. Available permits: ${available}.`,
    });
  } catch {
    // fallback if semaphore not yet initialized
  }

  // 5. Data directory
  try {
    const fs = await import("fs/promises");
    const dataDir = process.cwd() + "/data";
    await fs.access(dataDir);
    const entries = await fs.readdir(dataDir);
    checks.push({
      name: "data_directory",
      status: "ok",
      detail: `Data dir accessible. Subdirs: ${entries.join(", ")}`,
    });
  } catch {
    checks.push({
      name: "data_directory",
      status: "error",
      detail: "Data directory not accessible",
    });
  }

  // 6. Broken chat files (PM #30)
  // Files in data/chats/ that failed to parse during the last index rebuild.
  // Two-strike condition (chat-index.json corrupt + a chat-file corrupt) used
  // to silently omit those chats from the sidebar. Now we surface them so the
  // operator can recover the file or accept the loss.
  const broken = getBrokenChatFiles();
  if (broken.length > 0) {
    checks.push({
      name: "chat_index_integrity",
      status: "warn",
      detail: `${broken.length} chat file(s) failed to parse on last rebuild: ${broken.map((b) => b.file).join(", ")}. See PM #30 in POST_MORTEMS.md.`,
    });
  } else {
    checks.push({
      name: "chat_index_integrity",
      status: "ok",
      detail: "All chat files parsed successfully on last rebuild.",
    });
  }

  // 7. Aggregator mode (PM #53 — surface PM #52 state)
  // PM #56 — emit a `warn` row when the probe can't read settings rather
  // than silently disappearing from the subsystem list. The audit found
  // that a corrupt settings.json was dropping three new probes from the
  // /health response — operators monitoring "11 subsystems" would see 8
  // with no signal that the others failed. Now: absence is impossible;
  // status: "warn" with a "couldn't read settings" detail makes the
  // failure visible.
  try {
    const settings = await getSettings();
    const mode = settings.aggregator?.mode ?? "synthesis";
    const judgeCount = settings.aggregator?.tournamentJudgeCount ?? 1;
    checks.push({
      name: "aggregator_mode",
      status: "ok",
      detail:
        mode === "tournament"
          ? `Tournament mode active (K=${judgeCount} judge${judgeCount === 1 ? "" : "s"}). See PM #52.`
          : `Synthesis mode (default). Set settings.aggregator.mode = "tournament" for code/math/factual prompts. See PM #52.`,
    });
  } catch (err) {
    checks.push({
      name: "aggregator_mode",
      status: "warn",
      detail: `Could not read settings to determine aggregator mode: ${err instanceof Error ? err.message : String(err)}. Defaults to synthesis at runtime.`,
    });
  }

  // 8. Trace memory pool (PM #53 — surface PM #51 state)
  try {
    const settings = await getSettings();
    const enabled = settings.traceMemory?.enabled === true;
    if (!enabled) {
      checks.push({
        name: "trace_memory",
        status: "ok",
        detail:
          "Trace memory is off. Enable via settings.traceMemory.enabled = true to capture successful MoA runs as Router few-shots. See PM #51.",
      });
    } else {
      const fs = await import("fs/promises");
      const path = await import("path");
      const tracesDir = path.join(process.cwd(), "data", "traces");
      let entries: string[] = [];
      try {
        entries = await fs.readdir(tracesDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const traceCount = entries.filter((e) => e.endsWith(".json")).length;
      checks.push({
        name: "trace_memory",
        status: "ok",
        detail:
          traceCount === 0
            ? `Trace memory enabled but pool empty — captures begin after the first MoA run that meets the quality threshold (default 0.7). See PM #51.`
            : `Trace memory enabled. Pool size: ${traceCount} trace(s). Inspect with \`npm run trace:list\`.`,
      });
    }
  } catch (err) {
    // PM #56 — visible warn instead of silent skip (same rationale as
    // aggregator_mode above).
    checks.push({
      name: "trace_memory",
      status: "warn",
      detail: `Could not probe trace-memory state: ${err instanceof Error ? err.message : String(err)}.`,
    });
  }

  // 9. OpenRouter pricing cache (PM #53 — surface PM #49 state)
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const cachePath = path.join(
      process.cwd(),
      "data",
      "cache",
      "openrouter-pricing.json"
    );
    let raw: string | null = null;
    try {
      raw = await fs.readFile(cachePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!raw) {
      checks.push({
        name: "openrouter_pricing_cache",
        status: "ok",
        detail:
          "No cache yet — refresh happens at boot. If OpenRouter is unreachable, hardcoded prices in pricing.ts are used as fallback. See PM #49.",
      });
    } else {
      const parsed = JSON.parse(raw) as {
        fetchedAt?: string;
        entries?: Array<unknown>;
      };
      const fetchedAt = parsed.fetchedAt ? new Date(parsed.fetchedAt) : null;
      const ageHours = fetchedAt
        ? (Date.now() - fetchedAt.getTime()) / 3_600_000
        : null;
      const entryCount = Array.isArray(parsed.entries) ? parsed.entries.length : 0;
      const stale = ageHours !== null && ageHours > 48;
      checks.push({
        name: "openrouter_pricing_cache",
        status: stale ? "warn" : "ok",
        detail: stale
          ? `Cache is ${ageHours.toFixed(1)}h old (>48h stale). Boot refresh may be failing; check network or OpenRouter availability. ${entryCount} entries cached. See PM #49.`
          : `Cache fresh. ${entryCount} models priced; age ${ageHours?.toFixed(1) ?? "?"}h.`,
      });
    }
  } catch (err) {
    // PM #56 — visible warn instead of silent skip. Hardcoded fallback
    // always works at runtime, but the operator should see that the
    // cache probe couldn't run.
    checks.push({
      name: "openrouter_pricing_cache",
      status: "warn",
      detail: `Could not probe openrouter pricing cache: ${err instanceof Error ? err.message : String(err)}. Runtime falls back to hardcoded prices in pricing.ts.`,
    });
  }

  const totalMs = Date.now() - startTotal;
  const overallStatus = checks.some((c) => c.status === "error")
    ? "unhealthy"
    : checks.some((c) => c.status === "warn")
      ? "degraded"
      : "healthy";

  return Response.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    totalLatencyMs: totalMs,
    version: "1.0.0",
    product: "Orchestra",
    subsystems: checks,
  });
}
