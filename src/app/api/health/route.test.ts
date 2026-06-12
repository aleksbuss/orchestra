/**
 * Tests for GET /api/health — the structured-probe endpoint that the
 * Docker healthcheck and the MCP server's `orchestra_health` tool both
 * depend on.
 *
 * The probe runs 7 subsystem checks and aggregates an overall status:
 *   - settings        — chat model is configured
 *   - llm_provider    — provider's /models endpoint reachable (real fetch)
 *   - daemon          — auto-pilot subsystem alive (no-op check)
 *   - event_bus       — SSE bus available (no-op check)
 *   - chat_model_tools (PM #17) — model permits tool calls
 *   - resource_guard  — agent semaphore has free permits
 *   - data_directory  — data/ accessible
 *
 * Pinned invariants:
 *   - `status: "healthy"` when all subsystems "ok".
 *   - `status: "degraded"` if any "warn".
 *   - `status: "unhealthy"` if any "error" (an "error" wins over "warn").
 *   - Includes `timestamp` (ISO), `totalLatencyMs`, `version`, `product`.
 *   - The PM #17 chat_model_tools subsystem flags `warn` for gemma/mistral/
 *     phi families on OpenRouter — the very first thing the operator sees
 *     when their model is misconfigured.
 *   - data_directory check FAILS hard (status: "error") on missing dir —
 *     a missing data dir means the JSON-on-disk DB is broken, which
 *     unlike a misconfigured model is a P0 fault.
 *   - llm_provider unreachability degrades the system (status: "error")
 *     so the Docker healthcheck can mark the container unhealthy and
 *     cycle it.
 *   - subsystems are reported in a stable order so dashboards parsing
 *     them by name don't break on reorders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import pkg from "../../../../package.json";

// disk_space probes the REAL filesystem via fs.statfs — on a developer
// machine that is >=90% full the happy-path test would flake (PM #62
// spirit: tests must not depend on live machine state). Partial mock:
// statfs returns a healthy 50%-used disk; every other fs API stays real.
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    default: actual,
    statfs: vi.fn(async () => ({
      blocks: 250_000_000,
      bsize: 4096,
      bavail: 125_000_000,
    })),
  };
});

vi.mock("@/lib/storage/settings-store", () => ({
  getSettings: vi.fn(),
}));

vi.mock("@/lib/agent/semaphore", () => ({
  agentSemaphore: {
    getTotalPermits: vi.fn(() => 4),
    getPermits: vi.fn(() => 4),
  },
}));

import { GET } from "./route";
import { getSettings } from "@/lib/storage/settings-store";
import { agentSemaphore } from "@/lib/agent/semaphore";

const mockedSettings = vi.mocked(getSettings);
const mockedTotal = vi.mocked(agentSemaphore.getTotalPermits);
const mockedAvailable = vi.mocked(agentSemaphore.getPermits);

let tmpRoot: string;
let cwdSpy: any;
let fetchSpy: any;

const fakeSettings = (override: Partial<{
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}> = {}) => ({
  chatModel: {
    provider: override.provider ?? "openrouter",
    model: override.model ?? "anthropic/claude-3-5-haiku",
    baseUrl: override.baseUrl,
    apiKey: override.apiKey ?? "test-key",
  },
} as any);

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-health-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);

  // Plant a data/ dir so the data_directory probe passes by default.
  await fs.mkdir(path.join(tmpRoot, "data"), { recursive: true });

  // Default fetch: provider says it's healthy (200).
  fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
    new Response("{}", { status: 200 })
  );

  mockedSettings.mockResolvedValue(fakeSettings());
  mockedTotal.mockReturnValue(4);
  mockedAvailable.mockReturnValue(4);

  // Sprint 2 — plant a healthy cron scheduler singleton so the new
  // `cron_scheduler` probe defaults to `ok`. Individual tests that need
  // to exercise the warn/error paths overwrite this directly.
  (globalThis as any).__orchestraCronScheduler__ = {
    getHealthStatus: () => ({
      started: true,
      startedAtMs: Date.now() - 1000,
      lastTickAtMs: Date.now() - 100,
      isHealthy: true,
    }),
  };
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  fetchSpy?.mockRestore();
  delete (globalThis as any).__orchestraCronScheduler__;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function callHealth(): Promise<{ status: string; subsystems: Array<{ name: string; status: string; detail: string }> }> {
  const res = await GET();
  return res.json();
}

describe("GET /api/health — happy path", () => {
  it("returns 'healthy' when every subsystem is ok", async () => {
    const body = await callHealth();
    expect(body.status).toBe("healthy");
  });

  it("includes top-level metadata: timestamp, totalLatencyMs, version, product", async () => {
    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(typeof body.timestamp).toBe("string");
    expect(new Date(body.timestamp as string).toISOString()).toBe(body.timestamp);
    expect(typeof body.totalLatencyMs).toBe("number");
    expect((body.totalLatencyMs as number) >= 0).toBe(true);
    expect(body.version).toBe(pkg.version); // single source of truth: package.json
    expect(body.product).toBe("Orchestra");
  });

  it("reports all 15 subsystems by name in a stable order", async () => {
    const body = await callHealth();
    const names = body.subsystems.map((s) => s.name);
    expect(names).toEqual([
      "settings",
      "llm_provider",
      "daemon",
      "event_bus",
      "chat_model_tools",
      "resource_guard",
      "data_directory",
      // Sprint 5 — disk space + embeddings DB live next to data_directory
      // because they're all about whether the storage backbone is intact.
      "disk_space",
      "embeddings_db",
      // PM #30 — chat-file parse integrity surfaced through /api/health so the
      // operator sees "N chats failed to parse on rebuild" instead of silent
      // disappearance from the sidebar.
      "chat_index_integrity",
      // PM #53 — operator visibility for v3/v4 features. Surface aggregator
      // mode (PM #52), trace-memory pool state (PM #51), and OpenRouter
      // pricing-cache freshness (PM #49) without grepping data/.
      "aggregator_mode",
      "trace_memory",
      "openrouter_pricing_cache",
      // Sprint 2 — cron scheduler heartbeat. Stalled scheduler = sweepers
      // + cron jobs silently stop running. Probe reads the singleton's
      // getHealthStatus() (lastTickAtMs vs 5-min freshness threshold).
      "cron_scheduler",
      // Sprint 7 close — MCP servers configured-count probe. Config-shape
      // only; live liveness happens on call_mcp_tool invocation. Probing
      // every health call would spawn N processes / hit external networks.
      "mcp_servers",
    ]);
  });
});

describe("GET /api/health — chat_index_integrity orphan detection (PM #62)", () => {
  it("warns when the index references a chat file that is missing", async () => {
    // The exact PM #62 signature: an index entry with no chat file on disk.
    await fs.mkdir(path.join(tmpRoot, "data", "chats"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "data", "chat-index.json"),
      JSON.stringify([{ id: "ghost-chat", title: "gone", updatedAt: "2026-01-01" }])
    );

    const body = await callHealth();
    const check = body.subsystems.find((s) => s.name === "chat_index_integrity");
    expect(check).toBeDefined();
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/ghost-chat|missing chat file/i);
  });

  it("stays 'ok' when every index entry has a matching file", async () => {
    await fs.mkdir(path.join(tmpRoot, "data", "chats"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "data", "chats", "real.json"), "{}");
    await fs.writeFile(
      path.join(tmpRoot, "data", "chat-index.json"),
      JSON.stringify([{ id: "real", title: "here", updatedAt: "2026-01-01" }])
    );

    const body = await callHealth();
    const check = body.subsystems.find((s) => s.name === "chat_index_integrity");
    expect(check?.status).toBe("ok");
  });
});

describe("GET /api/health — disk_space + embeddings_db (Sprint 5)", () => {
  it("disk_space reports 'ok' with usage percentage under 90%", async () => {
    const body = await callHealth();
    const disk = body.subsystems.find((s) => s.name === "disk_space");
    expect(disk).toBeDefined();
    // statfs is mocked to a healthy 50%-used disk (see top-of-file mock),
    // so this is deterministic regardless of the machine the suite runs on.
    expect(disk?.status).toBe("ok");
    expect(disk?.detail).toMatch(/% (used|full)/i);
    expect(disk?.detail).toMatch(/GB free/);
  });

  it("embeddings_db reports 'ok' with subdir count (fresh tmpRoot = 0)", async () => {
    const body = await callHealth();
    const emb = body.subsystems.find((s) => s.name === "embeddings_db");
    expect(emb?.status).toBe("ok");
    // tmpRoot has no data/memory/ subdir yet → fresh-install branch.
    expect(emb?.detail).toMatch(/fresh-install|0 subdir|readable/i);
  });

  it("embeddings_db reports 'ok' with count when data/memory/ has subdirs", async () => {
    await fs.mkdir(path.join(tmpRoot, "data", "memory", "proj-a"), {
      recursive: true,
    });
    const body = await callHealth();
    const emb = body.subsystems.find((s) => s.name === "embeddings_db");
    expect(emb?.status).toBe("ok");
    expect(emb?.detail).toMatch(/1 subdir/);
  });
});

describe("GET /api/health — cron_scheduler subsystem (Sprint 2)", () => {
  it("returns 'ok' when the scheduler reports healthy + recent tick", async () => {
    const body = await callHealth();
    const check = body.subsystems.find((s) => s.name === "cron_scheduler");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toMatch(/last tick/i);
  });

  it("returns 'warn' when the singleton is missing on globalThis", async () => {
    delete (globalThis as any).__orchestraCronScheduler__;
    const body = await callHealth();
    const check = body.subsystems.find((s) => s.name === "cron_scheduler");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/instrumentation-node/i);
  });

  it("returns 'warn' when the scheduler stalled (no recent tick)", async () => {
    (globalThis as any).__orchestraCronScheduler__ = {
      getHealthStatus: () => ({
        started: true,
        startedAtMs: Date.now() - 60 * 60 * 1000,
        lastTickAtMs: Date.now() - 10 * 60 * 1000,
        isHealthy: false,
      }),
    };
    const body = await callHealth();
    const check = body.subsystems.find((s) => s.name === "cron_scheduler");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/stalled/i);
  });

  it("returns 'warn' when scheduler.start() never ran", async () => {
    (globalThis as any).__orchestraCronScheduler__ = {
      getHealthStatus: () => ({
        started: false,
        startedAtMs: null,
        lastTickAtMs: null,
        isHealthy: false,
      }),
    };
    const body = await callHealth();
    const check = body.subsystems.find((s) => s.name === "cron_scheduler");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/stop\(\) was called|never reached/i);
  });
});

describe("GET /api/health — settings subsystem", () => {
  it("warns when settings has no chatModel.provider/model", async () => {
    mockedSettings.mockResolvedValue({ chatModel: {} } as any);
    const body = await callHealth();
    const settingsCheck = body.subsystems.find((s) => s.name === "settings");
    expect(settingsCheck?.status).toBe("warn");
    expect(settingsCheck?.detail).toMatch(/not fully configured/i);
  });

  it("errors when getSettings throws (e.g., corrupt settings.json)", async () => {
    mockedSettings.mockRejectedValue(new Error("settings JSON corrupt"));
    const body = await callHealth();
    const settingsCheck = body.subsystems.find((s) => s.name === "settings");
    expect(settingsCheck?.status).toBe("error");
    expect(body.status).toBe("unhealthy");
  });
});

describe("GET /api/health — llm_provider subsystem", () => {
  it("hits the documented OpenRouter /models endpoint with bearer auth", async () => {
    mockedSettings.mockResolvedValue(
      fakeSettings({ provider: "openrouter", apiKey: "sk-test" })
    );
    await GET();

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/models");
    expect((init as any).headers.Authorization).toBe("Bearer sk-test");
  });

  it("hits OpenAI /models for the openai provider", async () => {
    mockedSettings.mockResolvedValue(fakeSettings({ provider: "openai" }));
    await GET();
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/models");
  });

  it("uses Ollama base URL (default localhost) for the ollama provider", async () => {
    mockedSettings.mockResolvedValue(
      fakeSettings({
        provider: "ollama",
        baseUrl: "http://my-ollama:11434/v1",
      })
    );
    await GET();
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://my-ollama:11434/v1/models");
  });

  it("warns when the provider returns non-OK status", async () => {
    fetchSpy.mockResolvedValue(new Response("upstream broken", { status: 503 }));
    const body = await callHealth();
    const llm = body.subsystems.find((s) => s.name === "llm_provider");
    expect(llm?.status).toBe("warn");
    expect(llm?.detail).toMatch(/HTTP 503/);
    // 'warn' degrades the overall status.
    expect(body.status).toBe("degraded");
  });

  it("errors when the provider is unreachable (fetch throws)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const body = await callHealth();
    const llm = body.subsystems.find((s) => s.name === "llm_provider");
    expect(llm?.status).toBe("error");
    expect(body.status).toBe("unhealthy");
  });

  it("uses a 5-second AbortSignal timeout (does not hang the healthcheck)", async () => {
    // We can't deterministically test wall-clock timeout in unit tests,
    // but we verify that fetch is called with an `AbortSignal` — the
    // production timeout is 5s, set via `AbortSignal.timeout(5000)`.
    await GET();
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("GET /api/health — chat_model_tools (PM #17 probe)", () => {
  it("warns when configured model matches NO_TOOL_PATTERNS (gemma family)", async () => {
    mockedSettings.mockResolvedValue(
      fakeSettings({ provider: "openrouter", model: "google/gemma-4-31b-it" })
    );
    const body = await callHealth();
    const tools = body.subsystems.find((s) => s.name === "chat_model_tools");
    expect(tools?.status).toBe("warn");
    expect(tools?.detail).toMatch(/NO_TOOL_PATTERNS/);
    expect(tools?.detail).toMatch(/PM #17/);
    expect(body.status).toBe("degraded");
  });

  it("ok for tool-capable models (claude-3-5-haiku via openrouter)", async () => {
    mockedSettings.mockResolvedValue(
      fakeSettings({ provider: "openrouter", model: "anthropic/claude-3-5-haiku" })
    );
    const body = await callHealth();
    const tools = body.subsystems.find((s) => s.name === "chat_model_tools");
    expect(tools?.status).toBe("ok");
    expect(tools?.detail).toMatch(/permits tool calls/);
  });

  it("ok for gpt-4o-mini via openai direct", async () => {
    mockedSettings.mockResolvedValue(
      fakeSettings({ provider: "openai", model: "gpt-4o-mini" })
    );
    const body = await callHealth();
    const tools = body.subsystems.find((s) => s.name === "chat_model_tools");
    expect(tools?.status).toBe("ok");
  });
});

describe("GET /api/health — resource_guard subsystem", () => {
  it("ok when permits are available", async () => {
    mockedAvailable.mockReturnValue(3);
    mockedTotal.mockReturnValue(4);
    const body = await callHealth();
    const guard = body.subsystems.find((s) => s.name === "resource_guard");
    expect(guard?.status).toBe("ok");
    expect(guard?.detail).toMatch(/Concurrency limit: 4/);
    expect(guard?.detail).toMatch(/Available permits: 3/);
  });

  it("warns when ALL permits are exhausted (semaphore is throttling)", async () => {
    mockedAvailable.mockReturnValue(0);
    mockedTotal.mockReturnValue(4);
    const body = await callHealth();
    const guard = body.subsystems.find((s) => s.name === "resource_guard");
    expect(guard?.status).toBe("warn");
  });
});

describe("GET /api/health — data_directory subsystem", () => {
  it("ok with a list of data subdirs", async () => {
    await fs.mkdir(path.join(tmpRoot, "data", "chats"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "data", "projects"), { recursive: true });
    const body = await callHealth();
    const dd = body.subsystems.find((s) => s.name === "data_directory");
    expect(dd?.status).toBe("ok");
    expect(dd?.detail).toMatch(/Data dir accessible/);
    expect(dd?.detail).toMatch(/chats/);
    expect(dd?.detail).toMatch(/projects/);
  });

  it("errors when the data directory does not exist (P0 fault)", async () => {
    await fs.rm(path.join(tmpRoot, "data"), { recursive: true });
    const body = await callHealth();
    const dd = body.subsystems.find((s) => s.name === "data_directory");
    expect(dd?.status).toBe("error");
    expect(body.status).toBe("unhealthy");
  });
});

describe("GET /api/health — overall status precedence", () => {
  it("'error' wins over 'warn' (data dir down + provider warn → unhealthy)", async () => {
    await fs.rm(path.join(tmpRoot, "data"), { recursive: true });
    fetchSpy.mockResolvedValue(new Response("", { status: 503 })); // would warn
    const body = await callHealth();
    expect(body.status).toBe("unhealthy");
  });

  it("'warn' wins over 'ok' (just one warn → degraded)", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 503 }));
    const body = await callHealth();
    expect(body.status).toBe("degraded");
  });
});

// PM #56 — closing the audit gap: when getSettings throws (corrupt
// settings.json) the three PM #53 probes used to silently disappear
// from the response. Now they MUST appear with status: "warn" so the
// operator sees the probe failure instead of missing rows.
describe("PM #56 — PM #53 probes never silently disappear on settings failure", () => {
  it("getSettings throws → aggregator_mode + trace_memory still appear as warn", async () => {
    mockedSettings.mockRejectedValue(new Error("settings JSON corrupt"));
    const body = await callHealth();

    const agg = body.subsystems.find((s) => s.name === "aggregator_mode");
    expect(agg).toBeDefined();
    expect(agg?.status).toBe("warn");
    expect(agg?.detail).toMatch(/Could not read settings/i);

    const tm = body.subsystems.find((s) => s.name === "trace_memory");
    expect(tm).toBeDefined();
    expect(tm?.status).toBe("warn");
    expect(tm?.detail).toMatch(/Could not probe/i);
  });

  it("subsystem order remains stable under settings failure", async () => {
    mockedSettings.mockRejectedValue(new Error("boom"));
    const body = await callHealth();
    const names = body.subsystems.map((s) => s.name);
    // The 11 named subsystems still appear in their canonical order.
    expect(names).toContain("aggregator_mode");
    expect(names).toContain("trace_memory");
    expect(names).toContain("openrouter_pricing_cache");
    // Indexes preserve order — aggregator_mode before trace_memory
    // before openrouter_pricing_cache.
    expect(names.indexOf("aggregator_mode")).toBeLessThan(
      names.indexOf("trace_memory")
    );
    expect(names.indexOf("trace_memory")).toBeLessThan(
      names.indexOf("openrouter_pricing_cache")
    );
  });

  it("overall status degrades to unhealthy (settings error wins) but probes still surfaced", async () => {
    mockedSettings.mockRejectedValue(new Error("boom"));
    const body = await callHealth();
    expect(body.status).toBe("unhealthy"); // settings error
    // But the warn-rows must still be present so a dashboard can show
    // them.
    const warns = body.subsystems.filter((s) => s.status === "warn");
    const warnNames = warns.map((s) => s.name);
    expect(warnNames).toContain("aggregator_mode");
    expect(warnNames).toContain("trace_memory");
  });
});

// PM #53 — operator visibility checks for v3/v4 features.
describe("GET /api/health — aggregator_mode subsystem (PM #53/52)", () => {
  it("default settings → 'synthesis mode' detail", async () => {
    const body = await callHealth();
    const agg = body.subsystems.find((s) => s.name === "aggregator_mode");
    expect(agg?.status).toBe("ok");
    expect(agg?.detail).toMatch(/synthesis mode/i);
  });

  it("tournament mode → judge count in detail", async () => {
    mockedSettings.mockResolvedValue({
      ...fakeSettings(),
      aggregator: { mode: "tournament", tournamentJudgeCount: 3 },
    } as any);
    const body = await callHealth();
    const agg = body.subsystems.find((s) => s.name === "aggregator_mode");
    expect(agg?.status).toBe("ok");
    expect(agg?.detail).toMatch(/Tournament mode active.*K=3 judges/i);
  });

  it("tournament mode K=1 → singular 'judge'", async () => {
    mockedSettings.mockResolvedValue({
      ...fakeSettings(),
      aggregator: { mode: "tournament", tournamentJudgeCount: 1 },
    } as any);
    const body = await callHealth();
    const agg = body.subsystems.find((s) => s.name === "aggregator_mode");
    expect(agg?.detail).toMatch(/K=1 judge\b/);
  });
});

describe("GET /api/health — trace_memory subsystem (PM #53/51)", () => {
  it("disabled → ok with enable hint", async () => {
    const body = await callHealth();
    const tm = body.subsystems.find((s) => s.name === "trace_memory");
    expect(tm?.status).toBe("ok");
    expect(tm?.detail).toMatch(/Trace memory is off/i);
  });

  it("enabled + no traces yet → empty-pool detail", async () => {
    mockedSettings.mockResolvedValue({
      ...fakeSettings(),
      traceMemory: { enabled: true },
    } as any);
    const body = await callHealth();
    const tm = body.subsystems.find((s) => s.name === "trace_memory");
    expect(tm?.status).toBe("ok");
    expect(tm?.detail).toMatch(/pool empty/i);
  });

  it("enabled + traces on disk → reports count", async () => {
    await fs.mkdir(path.join(tmpRoot, "data", "traces"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "data", "traces", "abc.json"),
      "{}"
    );
    await fs.writeFile(
      path.join(tmpRoot, "data", "traces", "def.json"),
      "{}"
    );
    mockedSettings.mockResolvedValue({
      ...fakeSettings(),
      traceMemory: { enabled: true },
    } as any);
    const body = await callHealth();
    const tm = body.subsystems.find((s) => s.name === "trace_memory");
    expect(tm?.detail).toMatch(/Pool size: 2 trace\(s\)/);
  });
});

describe("GET /api/health — openrouter_pricing_cache subsystem (PM #53/49)", () => {
  it("no cache file → ok with boot-refresh hint", async () => {
    const body = await callHealth();
    const cache = body.subsystems.find(
      (s) => s.name === "openrouter_pricing_cache"
    );
    expect(cache?.status).toBe("ok");
    expect(cache?.detail).toMatch(/No cache yet/i);
  });

  it("fresh cache → ok with age + entry count", async () => {
    await fs.mkdir(path.join(tmpRoot, "data", "cache"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "data", "cache", "openrouter-pricing.json"),
      JSON.stringify({
        fetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h old
        entries: [
          { id: "a/b", inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          { id: "c/d", inputUsdPerMillion: 3, outputUsdPerMillion: 4 },
        ],
      })
    );
    const body = await callHealth();
    const cache = body.subsystems.find(
      (s) => s.name === "openrouter_pricing_cache"
    );
    expect(cache?.status).toBe("ok");
    expect(cache?.detail).toMatch(/Cache fresh.*2 models/);
  });

  it("stale cache (>48h) → warn", async () => {
    await fs.mkdir(path.join(tmpRoot, "data", "cache"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "data", "cache", "openrouter-pricing.json"),
      JSON.stringify({
        fetchedAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(), // 72h
        entries: [],
      })
    );
    const body = await callHealth();
    const cache = body.subsystems.find(
      (s) => s.name === "openrouter_pricing_cache"
    );
    expect(cache?.status).toBe("warn");
    expect(cache?.detail).toMatch(/stale/i);
  });
});
