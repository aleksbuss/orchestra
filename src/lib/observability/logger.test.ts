/**
 * Tests for the structured logger.
 *
 * Pinned invariants:
 *   - Output is one JSON line per call, valid JSON, with required fields
 *     (ts, level, event).
 *   - `withLogContext` propagates fields across awaits via AsyncLocalStorage;
 *     parent + child contexts merge, child overrides on collision.
 *   - Sensitive field names are redacted (defense-in-depth — callers must
 *     not log secrets in the first place, but a typo shouldn't ship hashes).
 *   - Errors get their `.message` and `.stack` lifted into the entry.
 *   - The file sink stays disabled unless `ORCHESTRA_LOG_TO_FILE=1` (so
 *     tests and dev scripts don't touch disk).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  log,
  withLogContext,
  getCurrentTraceId,
  __resetFileStreamForTests,
} from "./logger";

let stdoutSpy: any;
let stderrSpy: any;

beforeEach(() => {
  __resetFileStreamForTests();
  vi.unstubAllEnvs();
  // Force-disable the file sink in tests, regardless of the host env.
  vi.stubEnv("ORCHESTRA_LOG_TO_FILE", "");
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy?.mockRestore();
  stderrSpy?.mockRestore();
});

function lastJsonOn(spy: any): Record<string, unknown> {
  const calls = spy.mock.calls;
  expect(calls.length, "expected at least one write").toBeGreaterThan(0);
  const last = calls.at(-1)?.[0];
  expect(typeof last).toBe("string");
  return JSON.parse((last as string).trimEnd());
}

describe("log.* — emits one structured JSON line per call", () => {
  it("info() writes to stdout with required fields", () => {
    log.info("agent_started", { chatId: "c1" });
    const entry = lastJsonOn(stdoutSpy);

    expect(entry.level).toBe("info");
    expect(entry.event).toBe("agent_started");
    expect(entry.chatId).toBe("c1");
    expect(typeof entry.ts).toBe("string");
    // ISO 8601 sanity
    expect(new Date(entry.ts as string).toISOString()).toBe(entry.ts);
  });

  it("warn() and error() route to stderr (so docker logs color-codes them)", () => {
    log.warn("near_quota", { remaining: 100 });
    log.error("upstream_404", { url: "https://example/api" });

    expect(stderrSpy.mock.calls.length).toBe(2);
    expect(stdoutSpy.mock.calls.length).toBe(0);
  });

  it("output is exactly one JSON line per emit (no embedded newlines, single trailing \\n)", () => {
    log.info("evt_a", { msg: "hello" });
    const raw = stdoutSpy.mock.calls.at(-1)?.[0] as string;
    expect(raw.endsWith("\n")).toBe(true);
    const inner = raw.slice(0, -1);
    expect(inner.includes("\n")).toBe(false);
    JSON.parse(inner); // would throw if not a valid JSON line
  });
});

describe("withLogContext — AsyncLocalStorage propagation", () => {
  it("attaches context fields to every log inside the callback", async () => {
    await withLogContext({ traceId: "T1", chatId: "c1" }, async () => {
      log.info("inner_event");
    });

    const entry = lastJsonOn(stdoutSpy);
    expect(entry.traceId).toBe("T1");
    expect(entry.chatId).toBe("c1");
  });

  it("survives awaits — context lives for the entire microtask chain", async () => {
    await withLogContext({ traceId: "T2" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      await Promise.resolve();
      log.info("after_awaits");
    });

    const entry = lastJsonOn(stdoutSpy);
    expect(entry.traceId).toBe("T2");
  });

  it("nested contexts merge; children override on key collision", async () => {
    await withLogContext({ traceId: "outer", chatId: "c-outer" }, async () => {
      await withLogContext({ chatId: "c-inner" }, async () => {
        log.info("nested");
      });
    });

    const entry = lastJsonOn(stdoutSpy);
    expect(entry.traceId).toBe("outer");      // inherited from parent
    expect(entry.chatId).toBe("c-inner");     // overridden by child
  });

  it("getCurrentTraceId() returns the active trace id, undefined outside any context", () => {
    expect(getCurrentTraceId()).toBeUndefined();

    let captured: string | undefined;
    withLogContext({ traceId: "T-current" }, () => {
      captured = getCurrentTraceId();
    });
    expect(captured).toBe("T-current");

    expect(getCurrentTraceId()).toBeUndefined(); // restored after exit
  });

  it("explicit fields on log.info() override context-supplied ones", async () => {
    await withLogContext({ chatId: "from-ctx" }, async () => {
      log.info("override_test", { chatId: "from-args" });
    });

    const entry = lastJsonOn(stdoutSpy);
    expect(entry.chatId).toBe("from-args");
  });
});

describe("redaction — sensitive field names never reach the wire", () => {
  it("redacts apiKey, passwordHash, token, secret, authorization, cookie", () => {
    log.info("evt", {
      apiKey: "sk-real-secret",
      passwordHash: "scrypt$abc$def",
      token: "ghp_xyz",
      secret: "shh",
      authorization: "Bearer xxx",
      cookie: "session=zzz",
      benignField: "this should pass through",
    });

    const entry = lastJsonOn(stdoutSpy);
    expect(entry.apiKey).toBe("[REDACTED]");
    expect(entry.passwordHash).toBe("[REDACTED]");
    expect(entry.token).toBe("[REDACTED]");
    expect(entry.secret).toBe("[REDACTED]");
    expect(entry.authorization).toBe("[REDACTED]");
    expect(entry.cookie).toBe("[REDACTED]");
    expect(entry.benignField).toBe("this should pass through");

    // Verify the raw bytes too — we never want the actual hash anywhere
    // in the line, even reflected back in some other field.
    const raw = (stdoutSpy.mock.calls.at(-1)?.[0] as string) ?? "";
    expect(raw).not.toContain("scrypt$abc$def");
    expect(raw).not.toContain("sk-real-secret");
  });

  it("redaction is case-insensitive on field names", () => {
    log.info("evt", { APIKey: "x", Password_Hash: "y" });
    const entry = lastJsonOn(stdoutSpy);
    expect(entry.APIKey).toBe("[REDACTED]");
    expect(entry.Password_Hash).toBe("[REDACTED]");
  });

  it("Sprint 5 — extended set: bearer / x-api-key / x-token / passwd", () => {
    log.info("evt", {
      bearer: "Bearer sk-xxx",
      "x-api-key": "sk-header",
      "x-token": "ghp_header",
      "x-auth-token": "auth-header",
      "x-access-token": "access-header",
      passwd: "old-unix-style",
    });
    const entry = lastJsonOn(stdoutSpy);
    expect(entry.bearer).toBe("[REDACTED]");
    expect(entry["x-api-key"]).toBe("[REDACTED]");
    expect(entry["x-token"]).toBe("[REDACTED]");
    expect(entry["x-auth-token"]).toBe("[REDACTED]");
    expect(entry["x-access-token"]).toBe("[REDACTED]");
    expect(entry.passwd).toBe("[REDACTED]");
  });

  it("Sprint 5 — credential / credentials / private / private_key all redact", () => {
    log.info("evt", {
      credential: "single",
      credentials: { aws_access_key_id: "AKIA..." },
      private: "secret",
      private_key: "-----BEGIN RSA PRIVATE KEY-----",
      privateKey: "another shape",
    });
    const entry = lastJsonOn(stdoutSpy);
    expect(entry.credential).toBe("[REDACTED]");
    expect(entry.credentials).toBe("[REDACTED]");
    expect(entry.private).toBe("[REDACTED]");
    expect(entry.private_key).toBe("[REDACTED]");
    expect(entry.privateKey).toBe("[REDACTED]");
    // Raw bytes check: even the nested AKIA shouldn't leak via JSON
    // serialization because the wrapping field is redacted.
    const raw = (stdoutSpy.mock.calls.at(-1)?.[0] as string) ?? "";
    expect(raw).not.toContain("AKIA");
    expect(raw).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("Sprint 7 — OAuth2 + cloud-provider keys: id_token / refresh_token / client_secret / aws_* / jwt", () => {
    log.info("evt", {
      id_token: "eyJhbGc...",
      refresh_token: "rft-real",
      client_secret: "shh-oauth",
      access_token: "at-real",
      jwt: "header.payload.signature",
      aws_access_key_id: "AKIAIOSFODNN7EXAMPLE",
      aws_secret_access_key: "wJalrXUtnFEMI/REAL/SECRET",
      azure_storage_connection_string:
        "DefaultEndpointsProtocol=https;AccountKey=REALKEY",
      connection_string: "postgres://u:p@host/db",
      database_url: "postgres://u:p@host/db",
      dsn: "https://abc@sentry.io/123",
      "x-csrf-token": "csrf-real",
      csrf: "csrf-real",
      session_id: "sess-real",
    });
    const entry = lastJsonOn(stdoutSpy);
    for (const key of [
      "id_token",
      "refresh_token",
      "client_secret",
      "access_token",
      "jwt",
      "aws_access_key_id",
      "aws_secret_access_key",
      "azure_storage_connection_string",
      "connection_string",
      "database_url",
      "dsn",
      "x-csrf-token",
      "csrf",
      "session_id",
    ]) {
      expect(entry[key]).toBe("[REDACTED]");
    }
    // Raw-byte sanity check on the high-value secrets.
    const raw = (stdoutSpy.mock.calls.at(-1)?.[0] as string) ?? "";
    expect(raw).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(raw).not.toContain("wJalrXUtnFEMI");
    expect(raw).not.toContain("eyJhbGc...");
  });

  it("Sprint 7 — RECURSIVE redaction: nested headers.authorization leak closed", () => {
    // The pre-Sprint-7 bug: a perfectly innocent-looking
    // `log.info("req", { request: { headers: { authorization: "Bearer xyz" } } })`
    // leaked the bearer token because `request` isn't a redacted key and
    // the nested `headers` was never walked.
    log.info("req", {
      request: {
        method: "POST",
        headers: {
          authorization: "Bearer sk-real-leaky",
          "x-api-key": "ak-real",
        },
        body: { password: "should-not-leak" },
      },
    });
    const raw = (stdoutSpy.mock.calls.at(-1)?.[0] as string) ?? "";
    expect(raw).not.toContain("sk-real-leaky");
    expect(raw).not.toContain("ak-real");
    expect(raw).not.toContain("should-not-leak");
    // And confirm the redaction shape via parsed entry.
    const entry = lastJsonOn(stdoutSpy);
    const req = entry.request as Record<string, unknown>;
    const headers = req.headers as Record<string, unknown>;
    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers["x-api-key"]).toBe("[REDACTED]");
    const body = req.body as Record<string, unknown>;
    expect(body.password).toBe("[REDACTED]");
    // Non-secret fields survive.
    expect(req.method).toBe("POST");
  });

  it("Sprint 7 — recursive redaction inside arrays of objects", () => {
    log.info("multi", {
      events: [
        { name: "ok", token: "should-redact-1" },
        { name: "ok", token: "should-redact-2" },
      ],
    });
    const raw = (stdoutSpy.mock.calls.at(-1)?.[0] as string) ?? "";
    expect(raw).not.toContain("should-redact-1");
    expect(raw).not.toContain("should-redact-2");
  });

  it("Sprint 7 — circular references don't blow the stack", () => {
    type Cyc = { name: string; self?: Cyc };
    const a: Cyc = { name: "a" };
    a.self = a;
    expect(() => log.info("cyc", { a })).not.toThrow();
    const raw = (stdoutSpy.mock.calls.at(-1)?.[0] as string) ?? "";
    expect(raw).toContain("[REDACTED:cycle]");
  });
});

describe("Error capture — message + stack lifted automatically", () => {
  it("serializes Error instances into message + stack fields", () => {
    const err = new Error("boom");
    log.error("upstream_failed", { err });

    const entry = lastJsonOn(stderrSpy);
    expect(entry.err).toBe("boom");
    expect(typeof entry.stack).toBe("string");
    expect(entry.stack as string).toContain("Error: boom");
  });

  it("does not crash on cyclic references via Error chains", () => {
    const a: Error & { related?: unknown } = new Error("a-fail");
    a.related = a;
    expect(() => log.error("evt", { err: a })).not.toThrow();
  });
});

describe("file sink — disabled unless ORCHESTRA_LOG_TO_FILE=1 is set", () => {
  it("does not attempt to write to data/logs/ when the env is unset", () => {
    // The mocks for stdout/stderr never see a separate file write —
    // because we never open one. We assert by NOT seeing any error
    // path being hit; if we tried to open the file inside a test
    // worker it would either work (and we'd need to clean up) or
    // throw (and the test would surface it). Either way, this test
    // depends on `ORCHESTRA_LOG_TO_FILE` being unset (set by beforeEach).
    log.info("evt", { foo: 1 });
    expect(stdoutSpy.mock.calls.length).toBe(1);
  });
});
