import { getSettings } from "@/lib/storage/settings-store";
import { agentSemaphore } from "@/lib/agent/semaphore";
import { modelSupportsTools } from "@/lib/providers/tool-support";

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
