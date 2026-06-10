/**
 * fetch_webpage (PM #73) — the security contracts are the point of this tool,
 * so they are what's pinned: SSRF refusal BEFORE any network call, the
 * <UNTRUSTED_WEBPAGE> wrapper (prompt-injection sandbox), graceful error
 * strings (loop-guard §4), and the HTML→text strip.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createFetchWebpageTool, htmlToText, wrapUntrustedWebpage } from "./fetch-webpage";

const webTool = createFetchWebpageTool();
// The AI SDK tool's execute signature is (args, ctx); we only need abortSignal.
const run = (url: string): Promise<string> =>
  (webTool.execute as (a: { url: string }, c: { abortSignal?: AbortSignal }) => Promise<string>)(
    { url },
    { abortSignal: undefined }
  );

afterEach(() => vi.restoreAllMocks());

describe("fetch_webpage — SSRF guard (refuses BEFORE fetching)", () => {
  it("refuses cloud-metadata / link-local without ever calling fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const out = await run("http://169.254.169.254/latest/meta-data/");
    expect(out).toMatch(/refused/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses RFC-1918 private IPs", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await run("http://10.0.0.5/admin")).toMatch(/refused/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses non-http(s) protocols", async () => {
    expect(await run("file:///etc/passwd")).toMatch(/refused|invalid/i);
  });
});

describe("fetch_webpage — happy path", () => {
  it("strips scripts/tags and wraps the result in <UNTRUSTED_WEBPAGE>", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "<html><body><script>steal()</script><h1>Born 1962</h1><p>Visible text</p></body></html>",
        { headers: { "content-type": "text/html" } }
      )
    );
    const out = await run("https://example.com/profile");
    expect(out).toContain("<UNTRUSTED_WEBPAGE");
    expect(out).toContain("</UNTRUSTED_WEBPAGE>");
    expect(out).toContain("Born 1962");
    expect(out).toContain("Visible text");
    expect(out).not.toContain("steal()"); // script body stripped
  });

  it("returns an error STRING on HTTP failure (never throws)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 404, statusText: "Not Found" })
    );
    await expect(run("https://example.com/missing")).resolves.toMatch(/HTTP 404/);
  });

  it("rejects non-text content types (e.g. images)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("BINARY", { headers: { "content-type": "image/png" } })
    );
    expect(await run("https://example.com/pic.png")).toMatch(/not a text/i);
  });

  it("returns a JS-rendered hint when no text is extractable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><head></head><body><div id='root'></div></body></html>", {
        headers: { "content-type": "text/html" },
      })
    );
    const out = await run("https://spa.example.com");
    expect(out).toContain("<UNTRUSTED_WEBPAGE");
    expect(out).toMatch(/JavaScript-rendered|web_task/i);
  });
});

describe("htmlToText + wrapper helpers", () => {
  it("strips script/style/tags and decodes entities", () => {
    expect(htmlToText("<style>x{}</style><p>A &amp; B &lt;3</p>")).toBe("A & B <3");
  });
  it("wrapper carries the url and the marker name", () => {
    const w = wrapUntrustedWebpage("https://x.com", "hi");
    expect(w).toContain('<UNTRUSTED_WEBPAGE url="https://x.com">');
    expect(w).toContain("hi");
    expect(w.endsWith("</UNTRUSTED_WEBPAGE>")).toBe(true);
  });
});

describe("fetch_webpage — SSRF-safe redirects (PM #73 audit fix)", () => {
  it("re-validates each redirect hop and REFUSES a redirect to an internal IP", async () => {
    // A public URL that 302-redirects to cloud metadata — redirect:'follow'
    // would have chased it; we must re-check and refuse.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 302,
      ok: false,
      headers: new Headers({ location: "http://169.254.169.254/latest/" }),
      body: { cancel: async () => {} },
    } as unknown as Response);
    expect(await run("https://safe.example.com/go")).toMatch(/refused redirect/i);
  });
});

describe("fetch_webpage — charset (PM #73 audit fix)", () => {
  it("decodes windows-1251 Cyrillic, not as UTF-8 mojibake", async () => {
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет"
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(cp1251, { headers: { "content-type": "text/html; charset=windows-1251" } })
    );
    const out = await run("https://ru.example.com/p");
    expect(out).toContain("Привет");
  });
});
