/**
 * Tests for assertSafeOutboundUrl (PM #8 SSRF guard).
 *
 * Policy under test (see url-guard.ts module docstring):
 *   - http/https only
 *   - Loopback INTENTIONALLY allowed (local Ollama use case)
 *   - RFC 1918, 169.254.x.x, 0.0.0.0/8, IPv6 ULA / link-local REJECTED
 */
import { describe, it, expect } from "vitest";
import {
  assertSafeOutboundUrl,
  isLoopbackHost,
  isLoopbackUrl,
  UnsafeOutboundUrlError,
} from "./url-guard";

describe("assertSafeOutboundUrl — protocol guard", () => {
  it("accepts https", () => {
    expect(assertSafeOutboundUrl("https://api.openai.com/v1/models")).toBeInstanceOf(URL);
  });

  it("accepts http on a public host", () => {
    expect(assertSafeOutboundUrl("http://example.com/api")).toBeInstanceOf(URL);
  });

  it("rejects javascript:", () => {
    expect(() => assertSafeOutboundUrl("javascript:alert(1)")).toThrow(UnsafeOutboundUrlError);
  });

  it("rejects file:", () => {
    expect(() => assertSafeOutboundUrl("file:///etc/passwd")).toThrow(UnsafeOutboundUrlError);
  });

  it("rejects data:", () => {
    expect(() => assertSafeOutboundUrl("data:text/html,<script>alert(1)</script>")).toThrow(
      UnsafeOutboundUrlError
    );
  });

  it("rejects malformed URLs", () => {
    expect(() => assertSafeOutboundUrl("not a url")).toThrow(UnsafeOutboundUrlError);
    expect(() => assertSafeOutboundUrl("")).toThrow(UnsafeOutboundUrlError);
  });
});

describe("assertSafeOutboundUrl — loopback policy (intentionally allowed)", () => {
  it("allows http://localhost:11434 (default Ollama)", () => {
    expect(assertSafeOutboundUrl("http://localhost:11434/api/tags")).toBeInstanceOf(URL);
  });

  it("allows http://127.0.0.1 on any port", () => {
    expect(assertSafeOutboundUrl("http://127.0.0.1:6379")).toBeInstanceOf(URL);
  });

  it("allows http://127.255.255.254 (anywhere in 127/8)", () => {
    expect(assertSafeOutboundUrl("http://127.255.255.254/x")).toBeInstanceOf(URL);
  });
});

describe("assertSafeOutboundUrl — SSRF blocklist", () => {
  it("rejects AWS/GCP/Azure metadata endpoint", () => {
    expect(() => assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
      UnsafeOutboundUrlError
    );
  });

  it("rejects 10.0.0.0/8 (RFC 1918)", () => {
    expect(() => assertSafeOutboundUrl("http://10.0.0.1/x")).toThrow(UnsafeOutboundUrlError);
    expect(() => assertSafeOutboundUrl("http://10.255.255.255/x")).toThrow(UnsafeOutboundUrlError);
  });

  it("rejects 192.168.0.0/16", () => {
    expect(() => assertSafeOutboundUrl("http://192.168.1.1/router")).toThrow(UnsafeOutboundUrlError);
  });

  it("rejects 172.16.0.0/12 (boundaries)", () => {
    expect(() => assertSafeOutboundUrl("http://172.16.0.1/x")).toThrow(UnsafeOutboundUrlError);
    expect(() => assertSafeOutboundUrl("http://172.31.255.255/x")).toThrow(UnsafeOutboundUrlError);
  });

  it("does NOT reject 172.15.x or 172.32.x (just outside RFC 1918)", () => {
    expect(assertSafeOutboundUrl("http://172.15.0.1/x")).toBeInstanceOf(URL);
    expect(assertSafeOutboundUrl("http://172.32.0.1/x")).toBeInstanceOf(URL);
  });

  it("rejects 0.0.0.0/8", () => {
    expect(() => assertSafeOutboundUrl("http://0.0.0.0/x")).toThrow(UnsafeOutboundUrlError);
  });

  it("rejects IPv6 unique-local fc00::/7", () => {
    expect(() => assertSafeOutboundUrl("http://[fc00::1]/x")).toThrow(UnsafeOutboundUrlError);
    expect(() => assertSafeOutboundUrl("http://[fd12:3456:789a::1]/x")).toThrow(
      UnsafeOutboundUrlError
    );
  });

  it("rejects IPv6 link-local fe80::/10", () => {
    expect(() => assertSafeOutboundUrl("http://[fe80::1]/x")).toThrow(UnsafeOutboundUrlError);
  });

  it("rejects the WHOLE fe80::/10 range, not just fe80 (fe9x/feax/febx)", () => {
    // fe80::/10 spans fe80–febf. The guard blocks it via startsWith on
    // "fe8"/"fe9"/"fea"/"feb"; a test that only exercised `fe80::1` left the
    // upper three sub-ranges unverified — a mutation dropping any of those
    // branches survived silently (mutation-testing gap, 2026-07). Pin all four.
    expect(() => assertSafeOutboundUrl("http://[fe90::1]/x")).toThrow(UnsafeOutboundUrlError);
    expect(() => assertSafeOutboundUrl("http://[fea0::1]/x")).toThrow(UnsafeOutboundUrlError);
    expect(() => assertSafeOutboundUrl("http://[febf::1]/x")).toThrow(UnsafeOutboundUrlError);
  });
});

describe("assertSafeOutboundUrl — IPv4-in-IPv6 bypass (PM #8 follow-up)", () => {
  // Without the IPV4_IN_IPV6_RE check, every test in this block previously
  // PASSED through the guard because the IPv4 regex doesn't match colons
  // and the IPv6 prefix list (fc/fd/fe8…) doesn't include `::`.
  // These are the cases off-the-shelf SSRF scanners try.

  it("rejects ::ffff: form pointing at AWS/GCP/Azure metadata", () => {
    expect(() =>
      assertSafeOutboundUrl("http://[::ffff:169.254.169.254]/latest/meta-data/")
    ).toThrow(UnsafeOutboundUrlError);
  });

  it("rejects ::ffff: form pointing at RFC 1918 10/8", () => {
    expect(() => assertSafeOutboundUrl("http://[::ffff:10.0.0.1]/x")).toThrow(
      UnsafeOutboundUrlError
    );
  });

  it("rejects ::ffff: form pointing at RFC 1918 192.168/16", () => {
    expect(() => assertSafeOutboundUrl("http://[::ffff:192.168.1.1]/x")).toThrow(
      UnsafeOutboundUrlError
    );
  });

  it("rejects deprecated ::a.b.c.d (IPv4-compatible) form", () => {
    expect(() => assertSafeOutboundUrl("http://[::169.254.169.254]/x")).toThrow(
      UnsafeOutboundUrlError
    );
  });

  it("rejects ::ffff:0.0.0.0", () => {
    expect(() => assertSafeOutboundUrl("http://[::ffff:0.0.0.0]/x")).toThrow(
      UnsafeOutboundUrlError
    );
  });

  it("allows ::ffff: form pointing at a public IPv4 (e.g. Google DNS)", () => {
    // The mapped form itself is not malicious — only the embedded address matters.
    expect(assertSafeOutboundUrl("http://[::ffff:8.8.8.8]/x")).toBeInstanceOf(URL);
  });

  it("allows ::ffff:127.0.0.1 (loopback policy applies through the mapped form)", () => {
    // Loopback is intentionally allowed throughout this module; the IPv4-in-IPv6
    // path must not invent a stricter rule than the IPv4 path.
    expect(assertSafeOutboundUrl("http://[::ffff:127.0.0.1]/x")).toBeInstanceOf(URL);
  });
});

describe("assertSafeOutboundUrl — alternate IPv4 encodings (octal / hex / integer)", () => {
  // `0251.0376.0251.0376`, `0xa9fea9fe` and `2851995390` are all the SAME
  // address as `169.254.169.254`, and the OS resolver treats them as such.
  // The guard is safe from them for a structural reason: it validates
  // `new URL(raw).hostname`, and the WHATWG URL parser canonicalises every
  // one of these forms to dotted-decimal BEFORE the blocklist runs.
  //
  // That guarantee is IMPLICIT — nothing in url-guard.ts mentions it, and
  // `IPV4_RE` (`\d{1,3}` per octet) would not match the octal forms on its
  // own. A refactor that validated the RAW string instead of the parsed
  // hostname would reopen the whole class silently. These cases pin the
  // guarantee so that refactor turns the suite RED.
  //
  // Do not eyeball these: `010.0.0.1` is octal for the PUBLIC 8.0.0.1,
  // while `012.0.0.1` is 10.0.0.1 and must be blocked.

  it("normalises the host before the blocklist runs (the mechanism under test)", () => {
    expect(new URL("http://0xa9fea9fe/").hostname).toBe("169.254.169.254");
  });

  it.each([
    ["octal dotted-quad → 169.254.169.254 (metadata)", "http://0251.0376.0251.0376/latest/meta-data/"],
    ["octal dotted-quad → 10.0.0.1", "http://012.0.0.1/x"],
    ["octal dotted-quad → 192.168.0.1", "http://0300.0250.0.1/x"],
    ["hex integer → 169.254.169.254", "http://0xa9fea9fe/latest/meta-data/"],
    ["hex integer → 192.168.0.1", "http://0xc0a80001/x"],
    ["decimal integer → 192.168.0.1", "http://3232235521/x"],
    ["decimal integer → 10.0.0.1", "http://167772161/x"],
    ["short form → 192.168.0.1", "http://192.168.1/x"],
  ])("rejects %s", (_label, url) => {
    expect(() => assertSafeOutboundUrl(url)).toThrow(UnsafeOutboundUrlError);
  });

  it("allows a hex-encoded PUBLIC address (the encoding itself is not the offence)", () => {
    expect(assertSafeOutboundUrl("http://0x08080808/x")).toBeInstanceOf(URL);
  });

  it("allows octal-encoded loopback (loopback policy survives normalisation)", () => {
    expect(assertSafeOutboundUrl("http://0177.0.0.1/x")).toBeInstanceOf(URL);
  });

  it("allows an octal form that decodes to a PUBLIC address (010 → 8)", () => {
    expect(assertSafeOutboundUrl("http://010.0.0.1/x")).toBeInstanceOf(URL);
  });
});

describe("PM #47 — isLoopbackHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "127.42.99.7",
    "127.0.0.255",
    "::1",
    "[::1]",
  ])("'%s' → loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "api.openai.com",
    "openrouter.ai",
    "google.com",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "169.254.169.254", // metadata
    "0.0.0.0",
    "8.8.8.8",
    "1.2.3.4",
    "[::]",
    "[fe80::1]",
    "[fc00::1]",
  ])("'%s' → NOT loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it("empty string → not loopback (defensive)", () => {
    expect(isLoopbackHost("")).toBe(false);
  });

  it("IPv4-in-IPv6 loopback mapped form is treated as loopback", () => {
    // `::ffff:127.0.0.1` normalises to `::ffff:7f00:1` per WHATWG URL parser.
    // Our extractor parses it back to 127.0.0.1 → matches the 127/8 check.
    expect(isLoopbackHost("::ffff:7f00:1")).toBe(true);
    expect(isLoopbackHost("[::ffff:7f00:1]")).toBe(true);
  });

  it("IPv4-in-IPv6 non-loopback mapped form is NOT loopback", () => {
    // ::ffff:1.2.3.4 → ::ffff:102:304 → public IPv4 → not loopback.
    expect(isLoopbackHost("::ffff:102:304")).toBe(false);
  });
});

describe("PM #47 — isLoopbackUrl", () => {
  it("http://localhost:11434/v1 → loopback", () => {
    expect(isLoopbackUrl("http://localhost:11434/v1")).toBe(true);
  });

  it("http://127.0.0.1:30000 → loopback", () => {
    expect(isLoopbackUrl("http://127.0.0.1:30000")).toBe(true);
  });

  it("https://api.openai.com → NOT loopback", () => {
    expect(isLoopbackUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("file:// → NOT loopback (disallowed protocol)", () => {
    expect(isLoopbackUrl("file:///etc/passwd")).toBe(false);
  });

  it("malformed URL → NOT loopback (defensive)", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});
