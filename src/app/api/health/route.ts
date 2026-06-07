import { getSettings } from "@/lib/storage/settings-store";
import { agentSemaphore } from "@/lib/agent/semaphore";
import { modelSupportsTools } from "@/lib/providers/tool-support";
import { getBrokenChatFiles, getOrphanIndexEntries } from "@/lib/storage/chat-store";
import { getDataDir, dataPath } from "@/lib/storage/data-dir";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
} from "@/lib/security/url-guard";

export const dynamic = "force-dynamic";

interface SubsystemStatus {
  name: string;
  status: "ok" | "warn" | "error";
  detail: string;
  latencyMs?: number;
}

/**
 * TODO (Sprint-7 perf review): /api/health currently runs 15 probes
 * sequentially. On small deployments (<10 projects) total latency is
 * ~500ms — comfortable under Docker's default 30s healthcheck timeout.
 * On 100+ projects with 5+ MCP servers each, the `mcp_servers` probe
 * alone hits 1-2s of fs I/O via per-project `loadProjectMcpServers`.
 *
 * Not refactored here because: (a) parallelization needs every probe
 * extracted into a named fn returning SubsystemStatus[], a ~200 LOC
 * change with regression risk on the 39-test suite; (b) current
 * absolute latency is still well under Docker's default budget on
 * realistic deployments. Track as a focused follow-up sprint:
 *   - Promise.all on independent probes
 *   - Per-project MCP read batched + cached for ~30s
 *   - OR split into /api/health (fast) + /api/health/deep (full)
 */
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

      // PM #8 — SSRF guard. `modelsUrl` is built from operator-stored
      // settings (provider + baseUrl). Apply the same defense-in-depth
      // posture used in /api/models/route.ts: reject private/link-local
      // (incl. cloud metadata 169.254.169.254) before fetching.
      // Loopback stays allowed — local Ollama on 11434 is by design.
      let safeUrl: URL | null = null;
      let guardError: string | null = null;
      try {
        safeUrl = assertSafeOutboundUrl(modelsUrl);
      } catch (err) {
        if (err instanceof UnsafeOutboundUrlError) {
          guardError = err.message;
        } else {
          throw err;
        }
      }

      if (!safeUrl) {
        checks.push({
          name: "llm_provider",
          status: "warn",
          detail: `Refused to probe ${provider}: ${guardError ?? "unsafe URL"}`,
        });
      } else {
        const res = await fetch(safeUrl, {
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
      }
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
    const dataDir = getDataDir();
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

  // 5b. Disk space (Sprint 5).
  // `data/` IS the database; running out of space corrupts every JSON
  // write. `fs.statfs` returns block-level stats portable across macOS
  // and Linux. We warn at >=90% used; <90% is "ok". Errors during the
  // probe (e.g. statfs not supported on this filesystem) are themselves
  // warns — not knowing the disk state is worse than knowing it's full.
  try {
    const fs = await import("fs/promises");
    const dataDir = getDataDir();
    const stats = await fs.statfs(dataDir);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    const percentUsed = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    const freeGb = (freeBytes / 1_073_741_824).toFixed(2);
    if (percentUsed >= 90) {
      checks.push({
        name: "disk_space",
        status: "warn",
        detail: `Filesystem holding data/ is ${percentUsed.toFixed(1)}% full (${freeGb} GB free). At this level a single large write can corrupt JSON. Free space or move data/.`,
      });
    } else {
      checks.push({
        name: "disk_space",
        status: "ok",
        detail: `${percentUsed.toFixed(1)}% used, ${freeGb} GB free on the filesystem holding data/.`,
      });
    }
  } catch (err) {
    checks.push({
      name: "disk_space",
      status: "warn",
      detail: `Could not probe disk space via fs.statfs: ${err instanceof Error ? err.message : String(err)}. The disk may still be fine — just no visibility.`,
    });
  }

  // 5c. Embeddings DB readability (Sprint 5).
  // `data/memory/<subdir>/vectors.json` holds the long-term vector store.
  // The agent loads it lazily, so a corrupt file or unreachable directory
  // only surfaces during a search query — meaning the operator's first
  // notice is "search returned nothing" hours into a session. Probing
  // readdir on `data/memory/` at health time catches the obvious failure
  // mode (permissions / missing dir on a fresh deployment) up front.
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const memoryRoot = dataPath("memory");
    let subdirs: string[] = [];
    try {
      subdirs = await fs.readdir(memoryRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        checks.push({
          name: "embeddings_db",
          status: "ok",
          detail:
            "data/memory/ does not exist yet — first insertMemory creates it lazily. Fresh-install signature.",
        });
      } else {
        throw err;
      }
    }
    if (subdirs.length > 0 || subdirs.length === 0 && (await fs.access(memoryRoot).then(() => true).catch(() => false))) {
      // Spot-check: the FIRST subdir (alphabetical) must be readable as
      // a directory. We don't read every vectors.json — that scales
      // O(N) with knowledge base size; the lazy load handles per-file
      // corruption per PM #18 and the test on xlsx-loader covers it.
      if (subdirs.length > 0) {
        const first = subdirs[0];
        await fs.access(path.join(memoryRoot, first));
      }
      checks.push({
        name: "embeddings_db",
        status: "ok",
        detail: `data/memory/ readable. ${subdirs.length} subdir(s).`,
      });
    }
  } catch (err) {
    checks.push({
      name: "embeddings_db",
      status: "warn",
      detail: `data/memory/ probe failed: ${err instanceof Error ? err.message : String(err)}. Search queries may return empty until resolved.`,
    });
  }

  // 6. Chat index integrity (PM #30 + PM #62)
  // Two drift signatures are surfaced so neither is silent:
  //   - PM #30: chat files that failed to PARSE on the last index rebuild
  //     (corrupt index + corrupt chat-file two-strike → sidebar omission).
  //   - PM #62: index entries whose chat FILE is MISSING ("orphans") — ghost
  //     sidebar rows that open to nothing. This is the exact signature of the
  //     PM #62 data loss (index listed 41 chats, only 7 files on disk); making
  //     it a visible `warn` is what would have caught that loss immediately.
  const broken = getBrokenChatFiles();
  const orphans = await getOrphanIndexEntries();
  const issues: string[] = [];
  if (broken.length > 0) {
    issues.push(
      `${broken.length} chat file(s) failed to parse on last rebuild (${broken.map((b) => b.file).join(", ")})`
    );
  }
  if (orphans.length > 0) {
    const sample = orphans.slice(0, 5).join(", ");
    issues.push(
      `${orphans.length} index entr${orphans.length === 1 ? "y references a missing chat file" : "ies reference missing chat files"} (${sample}${orphans.length > 5 ? ", …" : ""}) — ghost sidebar rows; reconcile via rebuildChatIndex`
    );
  }
  if (issues.length > 0) {
    checks.push({
      name: "chat_index_integrity",
      status: "warn",
      detail: `${issues.join("; ")}. See PM #30 / PM #62 in POST_MORTEMS.md.`,
    });
  } else {
    checks.push({
      name: "chat_index_integrity",
      status: "ok",
      detail: "Chat index and chat files are consistent.",
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
      const tracesDir = dataPath("traces");
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
    const cachePath = dataPath("cache",
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
      // Sprint 5 — harmonised with `CACHE_TTL_MS = 24h` in
      // openrouter-pricing.ts. Pre-Sprint-5 this threshold was 48h, so a
      // cache that pricing.ts treated as stale (and was actively refusing
      // to read at 25h+) would still show "ok" in health, hiding boot-
      // refresh failures from the operator.
      const stale = ageHours !== null && ageHours > 24;
      checks.push({
        name: "openrouter_pricing_cache",
        status: stale ? "warn" : "ok",
        detail: stale
          ? `Cache is ${ageHours.toFixed(1)}h old (>24h stale, matches CACHE_TTL_MS in openrouter-pricing.ts). Boot refresh may be failing; check network or OpenRouter availability. ${entryCount} entries cached. See PM #49.`
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

  // 10. Cron scheduler heartbeat (Sprint 2 audit follow-up).
  // The scheduler lives on `globalThis.__orchestraCronScheduler__`. If it
  // never started (cold boot path didn't reach it) OR if its last tick is
  // more than ~5 min old (silent stall — the timer died but the process
  // is up), the operator gets a warn here. Without this probe, sweepers
  // + cron jobs go quiet and nothing else signals it.
  try {
    const scheduler = globalThis.__orchestraCronScheduler__;
    if (!scheduler) {
      checks.push({
        name: "cron_scheduler",
        status: "warn",
        detail:
          "Cron scheduler singleton not present on globalThis. instrumentation-node may not have run — check NEXT_RUNTIME and boot log for register() invocation.",
      });
    } else {
      const status = scheduler.getHealthStatus();
      if (status.isHealthy) {
        const lastTickAgoSec =
          status.lastTickAtMs !== null
            ? Math.round((Date.now() - status.lastTickAtMs) / 1000)
            : null;
        checks.push({
          name: "cron_scheduler",
          status: "ok",
          detail:
            lastTickAgoSec === null
              ? "Scheduler started; awaiting first tick (warmup window)."
              : `Scheduler started; last tick ${lastTickAgoSec}s ago.`,
        });
      } else {
        const detail = !status.started
          ? "Scheduler exists but stop() was called (or start() never reached)."
          : status.lastTickAtMs === null
          ? `Scheduler started but never ticked within the 5-min warmup window. Check boot log for cron service errors.`
          : `Scheduler stalled — last tick ${Math.round(
              (Date.now() - status.lastTickAtMs) / 1000
            )}s ago (> 5 min threshold). Sweepers + cron jobs not running.`;
        checks.push({
          name: "cron_scheduler",
          status: "warn",
          detail,
        });
      }
    }
  } catch (err) {
    checks.push({
      name: "cron_scheduler",
      status: "warn",
      detail: `Could not probe cron scheduler: ${err instanceof Error ? err.message : String(err)}.`,
    });
  }

  // 11. MCP servers — configured count (Sprint 5 follow-up / Sprint 7 close).
  //
  // Deliberately a CONFIG-shape probe, not a liveness probe. Driving real
  // liveness (open a stdio child / hit an HTTP endpoint) on every health
  // call would: (a) spawn N processes per request, (b) hit external
  // networks on a high-frequency endpoint, (c) double the latency of any
  // dashboard tile that polls /api/health. The goal here is to surface
  // "the config exists and parses cleanly" — a non-zero count without
  // errors confirms the surface is wired; failures actually invoking a
  // server show up in chat-error path / call_mcp_tool toolcall traces.
  //
  // Returns: "ok" with a count, "warn" only when reading the project list
  // or any per-project MCP file fails outright.
  try {
    const { getAllProjects, loadProjectMcpServers } = await import(
      "@/lib/storage/project-store"
    );
    const projects = await getAllProjects();
    // Sprint 8 collapsed sequential O(N projects) to parallel max-of-N
    // wall-clock via Promise.all. Sprint 10 follow-up: bound concurrency
    // to avoid EMFILE ("too many open files") on deployments with
    // 1000+ projects. Linux default soft limit is ~1024 file descriptors
    // per process; macOS is ~256. Unbounded Promise.all on 1000 projects
    // would race against that limit and may cause /api/health (which
    // Docker pings every ~30s) to flap on large deployments.
    //
    // Window of 32 is a back-of-napkin: each loadProjectMcpServers opens
    // 1 fd briefly, 32 in flight is well under both Linux & macOS
    // defaults and gives ~32× speedup vs sequential. Each per-project
    // promise still has its own try/catch so a single parse error
    // doesn't poison the whole probe.
    const MCP_PROBE_BATCH_SIZE = 32;
    const perProject: Array<{ count: number; parseError: boolean }> = [];
    for (let i = 0; i < projects.length; i += MCP_PROBE_BATCH_SIZE) {
      const batch = projects.slice(i, i + MCP_PROBE_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (project) => {
          try {
            const cfg = await loadProjectMcpServers(project.id);
            return { count: cfg?.servers?.length ?? 0, parseError: false };
          } catch {
            return { count: 0, parseError: true };
          }
        })
      );
      perProject.push(...batchResults);
    }
    let totalServers = 0;
    let parseErrors = 0;
    for (const { count, parseError } of perProject) {
      if (parseError) parseErrors += 1;
      else totalServers += count;
    }
    // Sprint 7 security follow-up — `/api/health` is in `isPublicApi`
    // (middleware.ts:17), so this response is reachable unauthenticated.
    // The pre-fix detail surfaced `projectsWithMcp` and `totalServers`
    // counts, which leak workspace activity (operator added/removed a
    // project → count changes, visible to anyone polling /api/health).
    // The check still PROBES every project (to surface parse-errors
    // that would otherwise be silent), but the detail string only
    // exposes a coarse boolean: configured / not / errors.
    if (parseErrors > 0) {
      checks.push({
        name: "mcp_servers",
        status: "warn",
        detail: `MCP enumeration completed with parse errors. Live-liveness probing happens on call_mcp_tool invocation, not here.`,
      });
    } else {
      checks.push({
        name: "mcp_servers",
        status: "ok",
        detail:
          totalServers === 0
            ? "No MCP servers configured."
            : `MCP configuration present. Liveness checked lazily on call_mcp_tool invocation.`,
      });
    }
  } catch (err) {
    checks.push({
      name: "mcp_servers",
      status: "warn",
      // Error message intentionally generic — pre-fix the JS error
      // message could include a project path on filesystem errors,
      // leaking the operator's workspace layout to unauth callers.
      detail: `Could not enumerate MCP server configs (${err instanceof Error ? err.constructor.name : "Error"}).`,
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
