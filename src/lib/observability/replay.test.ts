/**
 * Replay harness tests + the live regression scan over `data/postmortems/`.
 *
 * Two layers:
 *   1. Unit tests for `replayPostmortem` and `findSecretsInPostmortemString`
 *      — synthetic PM fixtures that exercise every classifier branch and
 *      every secret-detection regex.
 *   2. The live scan: read every `data/postmortems/*.json` on disk, replay
 *      it, and assert (a) the classifier today is consistent with the
 *      captured one, (b) no secrets leaked through. Each PM file becomes
 *      a permanent regression case for free.
 *
 * The live scan is wrapped in a `describe.skipIf` so it's a no-op when
 * the directory is empty (fresh checkout, no incidents yet).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  POSTMORTEM_SCHEMA_VERSION,
  type PostmortemFile,
} from "./postmortem";
import {
  findSecretsInPostmortemString,
  replayPostmortem,
} from "./replay";

function fixturePm(overrides: Partial<PostmortemFile>): PostmortemFile {
  return {
    schemaVersion: POSTMORTEM_SCHEMA_VERSION,
    traceId: "T-fixture",
    ts: "2026-05-09T12:00:00.000Z",
    chatId: "c-fixture",
    request: { userMessage: "test", swarmEnabled: true },
    settings: {
      chatModel: { provider: "openrouter", model: "x" },
      utilityModel: { provider: "openrouter", model: "y" },
      embeddingsModel: { provider: "openai", model: "z" },
      providerApiKeysPresent: [],
      chatModelApiKeyPresent: false,
    },
    errorClassification: {
      traceId: "T-fixture",
      kind: "internal",
      message: "x",
      recoverable: false,
    },
    rawError: { message: "x" },
    logs: [],
    chatSnapshot: null,
    ...overrides,
  };
}

describe("replayPostmortem — classifier regression check", () => {
  it("upstream_no_tools is reproducible from rawError shape today", () => {
    const pm = fixturePm({
      errorClassification: {
        traceId: "T-fixture",
        kind: "upstream_no_tools",
        message: "Tool calls not supported",
        hint: "Switch model",
        recoverable: false,
      },
      rawError: { message: "404", name: "AI_APICallError" },
    });
    const result = replayPostmortem(pm);
    expect(result.consistent).toBe(true);
    expect(result.reclassified.kind).toBe("upstream_no_tools");
  });

  it("upstream_rate_limit is reproducible", () => {
    const pm = fixturePm({
      errorClassification: {
        traceId: "T-fixture",
        kind: "upstream_rate_limit",
        message: "Slow down",
        recoverable: true,
      },
    });
    const result = replayPostmortem(pm);
    expect(result.consistent).toBe(true);
  });

  it("upstream_4xx and upstream_5xx are reproducible", () => {
    for (const kind of ["upstream_4xx", "upstream_5xx"] as const) {
      const pm = fixturePm({
        errorClassification: {
          traceId: "T-fixture",
          kind,
          message: "x",
          recoverable: kind === "upstream_5xx",
        },
      });
      const result = replayPostmortem(pm);
      expect(result.consistent, `kind=${kind} drifted: ${result.drift.join("; ")}`).toBe(true);
    }
  });

  it("abort is reproducible from a captured AbortError", () => {
    const pm = fixturePm({
      errorClassification: {
        traceId: "T-fixture",
        kind: "abort",
        message: "Request was cancelled.",
        recoverable: false,
      },
      rawError: { name: "AbortError", message: "aborted" },
    });
    const result = replayPostmortem(pm);
    expect(result.consistent).toBe(true);
  });

  it("internal kind is reproducible — generic error -> internal", () => {
    const pm = fixturePm({
      errorClassification: {
        traceId: "T-fixture",
        kind: "internal",
        message: "An internal error occurred while processing the request.",
        recoverable: false,
      },
      rawError: { message: "ENOENT: ..." },
    });
    const result = replayPostmortem(pm);
    expect(result.consistent).toBe(true);
  });

  it("reports drift when classifier kind changes", () => {
    // Synthesize a deliberately-stale PM whose stored kind doesn't match
    // what the classifier produces today. This is the failure mode the
    // harness exists to catch.
    const pm = fixturePm({
      errorClassification: {
        traceId: "T-fixture",
        kind: "upstream_4xx", // stored
        message: "x",
        recoverable: false,
      },
      rawError: { name: "AbortError", message: "aborted" }, // would re-classify as abort
    });
    const result = replayPostmortem(pm);
    expect(result.consistent).toBe(false);
    expect(result.drift.join(" ")).toMatch(/kind drift/);
  });
});

describe("findSecretsInPostmortemString — defense-in-depth scanner", () => {
  it("flags a literal scrypt envelope (passwordHash leak)", () => {
    const text = '"passwordHash":"scrypt$abc$DEFGHIJK"';
    const found = findSecretsInPostmortemString(text);
    expect(found.some((f) => /scrypt/i.test(f))).toBe(true);
  });

  it("flags OpenAI-shaped sk- keys", () => {
    expect(
      findSecretsInPostmortemString('"key":"sk-aaaaaaaaaaaaaaaaaaaaaaaa"').length
    ).toBeGreaterThan(0);
  });

  it("flags Anthropic sk-ant- prefix specifically", () => {
    const found = findSecretsInPostmortemString('"key":"sk-ant-real-anthropic-key"');
    expect(found.some((f) => /Anthropic/.test(f))).toBe(true);
  });

  it("flags Google AIza prefix", () => {
    const found = findSecretsInPostmortemString(
      '"key":"AIzaSyDxxxxxxxxxxxxxxxxxxx"'
    );
    expect(found.some((f) => /Google/.test(f))).toBe(true);
  });

  it("flags Tavily tvly- prefix", () => {
    const found = findSecretsInPostmortemString(
      '"key":"tvly-xxxxxxxxxxxxxxxxxxxx"'
    );
    expect(found.some((f) => /Tavily/.test(f))).toBe(true);
  });

  it("returns [] for a clean string (no false positives on `kind` etc.)", () => {
    const clean = JSON.stringify({
      schemaVersion: 1,
      traceId: "T-1",
      kind: "upstream_no_tools",
      message: "ok",
    });
    expect(findSecretsInPostmortemString(clean)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Live scan over the on-disk postmortem corpus. Each file becomes a
// permanent regression case at zero authoring cost.
// ────────────────────────────────────────────────────────────────────

const POSTMORTEM_DIR = path.join(process.cwd(), "data", "postmortems");

async function readPostmortemCorpus(): Promise<
  Array<{ path: string; pm: PostmortemFile; raw: string }>
> {
  let entries: string[];
  try {
    entries = await fs.readdir(POSTMORTEM_DIR);
  } catch {
    return [];
  }
  const out: Array<{ path: string; pm: PostmortemFile; raw: string }> = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(POSTMORTEM_DIR, name);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const pm = JSON.parse(raw) as PostmortemFile;
      out.push({ path: filePath, pm, raw });
    } catch {
      // Skip malformed files; the unit tests above pin classifier behavior
      // independently. A corrupted PM is itself a cleanup task, not a
      // regression-test failure.
    }
  }
  return out;
}

describe("live postmortem corpus — regression scan", async () => {
  const corpus = await readPostmortemCorpus();

  it.skipIf(corpus.length === 0)(
    "every postmortem reclassifies to the same kind today (no classifier drift)",
    () => {
      const drifts: string[] = [];
      for (const { path: p, pm } of corpus) {
        const r = replayPostmortem(pm);
        if (!r.consistent) {
          drifts.push(`${p}: ${r.drift.join("; ")}`);
        }
      }
      expect(drifts, drifts.join("\n")).toEqual([]);
    }
  );

  it.skipIf(corpus.length === 0)(
    "no postmortem on disk leaks a secret (sanitizer regression guard)",
    () => {
      const leaks: string[] = [];
      for (const { path: p, raw } of corpus) {
        const found = findSecretsInPostmortemString(raw);
        if (found.length > 0) leaks.push(`${p}: ${found.join(", ")}`);
      }
      expect(leaks, leaks.join("\n")).toEqual([]);
    }
  );

  it.skipIf(corpus.length === 0)(
    "every postmortem matches the current schema version",
    () => {
      const wrongVersion: string[] = [];
      for (const { path: p, pm } of corpus) {
        if (pm.schemaVersion !== POSTMORTEM_SCHEMA_VERSION) {
          wrongVersion.push(`${p}: schema=${pm.schemaVersion}`);
        }
      }
      expect(wrongVersion).toEqual([]);
    }
  );
});
