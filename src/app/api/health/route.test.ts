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
});

afterEach(async () => {
  cwdSpy?.mockRestore();
  fetchSpy?.mockRestore();
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
    expect(body.version).toBe("1.0.0");
    expect(body.product).toBe("Orchestra");
  });

  it("reports all 8 subsystems by name in a stable order", async () => {
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
      // PM #30 — chat-file parse integrity surfaced through /api/health so the
      // operator sees "N chats failed to parse on rebuild" instead of silent
      // disappearance from the sidebar.
      "chat_index_integrity",
    ]);
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
