import { describe, it, expect, vi, afterEach } from "vitest";
import type { ProjectMcpConfig } from "@/lib/types";
import {
  tomlQuote,
  stableCodexServerKey,
  extractCodexUnsupportedParameter,
  buildCodexMcpOverrides,
  resolveCodexMcpOverrides,
  parseCodexOutput,
  createCodexOauthFetch,
  DEFAULT_CODEX_INSTRUCTIONS,
} from "./codex";
import { loadProjectMcpServers } from "@/lib/storage/project-mcp";

vi.mock("@/lib/storage/project-mcp", () => ({
  loadProjectMcpServers: vi.fn(),
}));

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---- tomlQuote --------------------------------------------------------------

describe("tomlQuote", () => {
  it("wraps a plain string in double quotes", () => {
    expect(tomlQuote("hello")).toBe('"hello"');
  });

  it("escapes backslashes and double quotes", () => {
    expect(tomlQuote('a\\b"c')).toBe('"a\\\\b\\"c"');
  });

  it("escapes newline, carriage return, and tab", () => {
    expect(tomlQuote("a\nb\rc\td")).toBe('"a\\nb\\rc\\td"');
  });

  it("quotes the empty string", () => {
    expect(tomlQuote("")).toBe('""');
  });
});

// ---- stableCodexServerKey ---------------------------------------------------

describe("stableCodexServerKey", () => {
  it("lowercases and replaces invalid runs with a single underscore", () => {
    const used = new Set<string>();
    expect(stableCodexServerKey("My Server!!Name", used)).toBe("my_server_name");
  });

  it("keeps valid characters (a-z, 0-9, _, -) intact", () => {
    const used = new Set<string>();
    expect(stableCodexServerKey("srv-1_ok", used)).toBe("srv-1_ok");
  });

  it("falls back to 'mcp' for an id that sanitizes to nothing", () => {
    const used = new Set<string>();
    expect(stableCodexServerKey("!!!", used)).toBe("mcp");
  });

  it("suffixes _2, _3 on collisions and records each key as used", () => {
    const used = new Set<string>();
    expect(stableCodexServerKey("dup", used)).toBe("dup");
    expect(stableCodexServerKey("dup", used)).toBe("dup_2");
    expect(stableCodexServerKey("DUP", used)).toBe("dup_3");
    expect(used).toEqual(new Set(["dup", "dup_2", "dup_3"]));
  });
});

// ---- extractCodexUnsupportedParameter ----------------------------------------

describe("extractCodexUnsupportedParameter", () => {
  it("extracts the parameter name (case-insensitive)", () => {
    expect(
      extractCodexUnsupportedParameter('{"error":"Unsupported parameter: max_output_tokens"}')
    ).toBe("max_output_tokens");
  });

  it("supports dotted and dashed parameter names", () => {
    expect(
      extractCodexUnsupportedParameter("unsupported parameter: text.verbosity-level")
    ).toBe("text.verbosity-level");
  });

  it("returns null when the marker is absent", () => {
    expect(extractCodexUnsupportedParameter("some other error")).toBeNull();
  });
});

// ---- buildCodexMcpOverrides ---------------------------------------------------

describe("buildCodexMcpOverrides", () => {
  it("returns [] for null config or empty server list", () => {
    expect(buildCodexMcpOverrides(null)).toEqual([]);
    expect(buildCodexMcpOverrides({ servers: [] })).toEqual([]);
  });

  it("renders a full stdio server: command, trimmed args, sorted env, cwd", () => {
    const config: ProjectMcpConfig = {
      servers: [
        {
          id: "files",
          transport: "stdio",
          command: " npx ",
          args: [" -y ", "", "@mcp/files"],
          env: { ZED: "z", AAA: "a" },
          cwd: " /tmp/work ",
        },
      ],
    };
    expect(buildCodexMcpOverrides(config)).toEqual([
      'mcp_servers.files.command="npx"',
      'mcp_servers.files.args=["-y", "@mcp/files"]',
      'mcp_servers.files.env={"AAA" = "a", "ZED" = "z"}',
      'mcp_servers.files.cwd="/tmp/work"',
    ]);
  });

  it("skips a stdio server whose command is blank", () => {
    const config: ProjectMcpConfig = {
      servers: [{ id: "ghost", transport: "stdio", command: "   " }],
    };
    expect(buildCodexMcpOverrides(config)).toEqual([]);
  });

  it("renders an http server: url plus sorted headers", () => {
    const config: ProjectMcpConfig = {
      servers: [
        {
          id: "remote",
          transport: "http",
          url: " https://mcp.example.com/sse ",
          headers: { "X-Two": "2", "A-One": "1" },
        },
      ],
    };
    expect(buildCodexMcpOverrides(config)).toEqual([
      'mcp_servers.remote.url="https://mcp.example.com/sse"',
      'mcp_servers.remote.headers={"A-One" = "1", "X-Two" = "2"}',
    ]);
  });

  it("skips an http server whose url is blank", () => {
    const config: ProjectMcpConfig = {
      servers: [{ id: "ghost", transport: "http", url: "  " }],
    };
    expect(buildCodexMcpOverrides(config)).toEqual([]);
  });

  it("disambiguates colliding ids with stable suffixes", () => {
    const config: ProjectMcpConfig = {
      servers: [
        { id: "srv", transport: "stdio", command: "one" },
        { id: "SRV", transport: "stdio", command: "two" },
      ],
    };
    expect(buildCodexMcpOverrides(config)).toEqual([
      'mcp_servers.srv.command="one"',
      'mcp_servers.srv_2.command="two"',
    ]);
  });

  it("TOML-escapes quotes and backslashes in values", () => {
    const config: ProjectMcpConfig = {
      servers: [
        {
          id: "esc",
          transport: "stdio",
          command: 'run "it"',
          env: { PATHY: "C:\\bin" },
        },
      ],
    };
    expect(buildCodexMcpOverrides(config)).toEqual([
      'mcp_servers.esc.command="run \\"it\\""',
      'mcp_servers.esc.env={"PATHY" = "C:\\\\bin"}',
    ]);
  });
});

// ---- resolveCodexMcpOverrides --------------------------------------------------

describe("resolveCodexMcpOverrides", () => {
  it("returns [] without touching the loader when projectId is undefined", async () => {
    await expect(resolveCodexMcpOverrides(undefined)).resolves.toEqual([]);
    expect(loadProjectMcpServers).not.toHaveBeenCalled();
  });

  it("builds overrides from the loaded project config", async () => {
    vi.mocked(loadProjectMcpServers).mockResolvedValueOnce({
      servers: [{ id: "files", transport: "stdio", command: "npx" }],
    });
    await expect(resolveCodexMcpOverrides("proj-1")).resolves.toEqual([
      'mcp_servers.files.command="npx"',
    ]);
    expect(loadProjectMcpServers).toHaveBeenCalledWith("proj-1");
  });

  it("swallows loader errors and returns []", async () => {
    vi.mocked(loadProjectMcpServers).mockRejectedValueOnce(new Error("disk gone"));
    await expect(resolveCodexMcpOverrides("proj-1")).resolves.toEqual([]);
  });
});

// ---- parseCodexOutput -----------------------------------------------------------

describe("parseCodexOutput", () => {
  it("joins agent_message texts with blank lines", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: " first " } }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "hidden" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "second" } }),
    ].join("\n");
    expect(parseCodexOutput(stdout, "")).toBe("first\n\nsecond");
  });

  it("returns the explicit error message when no agent text arrived", () => {
    const stdout = JSON.stringify({ type: "error", message: "quota exhausted" });
    expect(parseCodexOutput(stdout, "noise")).toBe("quota exhausted");
  });

  it("falls back to the error field when message is absent", () => {
    const stdout = JSON.stringify({ type: "error", error: "boom" });
    expect(parseCodexOutput(stdout, "")).toBe("boom");
  });

  it("ignores non-JSON lines and falls back to raw stdout+stderr", () => {
    expect(parseCodexOutput("plain text", "warn")).toBe("plain text\nwarn");
  });

  it("returns the placeholder when everything is empty", () => {
    expect(parseCodexOutput("", "")).toBe("Codex CLI returned no output.");
  });

  it("prefers agent text over a co-occurring error event", () => {
    const stdout = [
      JSON.stringify({ type: "error", message: "transient" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
    ].join("\n");
    expect(parseCodexOutput(stdout, "")).toBe("answer");
  });
});

// ---- createCodexOauthFetch --------------------------------------------------------

describe("createCodexOauthFetch", () => {
  function lastRequest(fetchMock: ReturnType<typeof vi.fn>): Request {
    const calls = fetchMock.mock.calls;
    return calls[calls.length - 1][0] as Request;
  }

  it("injects bearer + accept + account headers on a non-POST passthrough", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const oauthFetch = createCodexOauthFetch({ accessToken: "tok-1", accountId: "acc-9" });
    const res = await oauthFetch("https://chatgpt.com/backend-api/codex/models");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = lastRequest(fetchMock);
    expect(sent.method).toBe("GET");
    expect(sent.headers.get("authorization")).toBe("Bearer tok-1");
    expect(sent.headers.get("accept")).toBe("application/json");
    expect(sent.headers.get("chatgpt-account-id")).toBe("acc-9");
  });

  it("omits the account header when accountId is absent", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const oauthFetch = createCodexOauthFetch({ accessToken: "tok-1" });
    await oauthFetch("https://chatgpt.com/backend-api/codex/models");

    expect(lastRequest(fetchMock).headers.get("chatgpt-account-id")).toBeNull();
  });

  it("rewrites a POST body: forces store=false, defaults instructions, strips max_output_tokens", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const oauthFetch = createCodexOauthFetch({ accessToken: "tok-1" });
    await oauthFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.3-codex", max_output_tokens: 4096 }),
    });

    const body = JSON.parse(await lastRequest(fetchMock).text());
    expect(body.store).toBe(false);
    expect(body.instructions).toBe(DEFAULT_CODEX_INSTRUCTIONS);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.model).toBe("gpt-5.3-codex");
  });

  it("preserves caller-supplied instructions", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const oauthFetch = createCodexOauthFetch({ accessToken: "tok-1" });
    await oauthFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ instructions: "Be terse." }),
    });

    const body = JSON.parse(await lastRequest(fetchMock).text());
    expect(body.instructions).toBe("Be terse.");
  });

  it("retries a 400 once after deleting the parameter the error names", async () => {
    const fetchMock = vi.fn<FetchImpl>();
    fetchMock
      .mockResolvedValueOnce(
        new Response('{"detail":"unsupported parameter: reasoning"}', { status: 400 })
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const oauthFetch = createCodexOauthFetch({ accessToken: "tok-1" });
    const res = await oauthFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "m", reasoning: { effort: "high" } }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retried = JSON.parse(await lastRequest(fetchMock).text());
    expect(retried).not.toHaveProperty("reasoning");
    expect(retried.model).toBe("m");
  });

  it("returns the 400 as-is when the error names no known parameter", async () => {
    const fetchMock = vi.fn<FetchImpl>(
      async () => new Response('{"detail":"bad request"}', { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const oauthFetch = createCodexOauthFetch({ accessToken: "tok-1" });
    const res = await oauthFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "m" }),
    });

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes a non-JSON POST body through verbatim (headers still injected)", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const oauthFetch = createCodexOauthFetch({ accessToken: "tok-1" });
    await oauthFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: "not json at all",
    });

    const sent = lastRequest(fetchMock);
    expect(await sent.text()).toBe("not json at all");
    expect(sent.headers.get("authorization")).toBe("Bearer tok-1");
  });

  it("passes an empty POST body through without rewriting", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const oauthFetch = createCodexOauthFetch({ accessToken: "tok-1" });
    await oauthFetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await lastRequest(fetchMock).text()).toBe("");
  });
});
