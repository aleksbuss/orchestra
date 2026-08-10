import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  executeCode,
  listManagedProcessSessions,
  pollManagedProcessSession,
  readManagedProcessSessionLog,
  killManagedProcessSession,
  removeManagedProcessSession,
  clearFinishedManagedProcessSessions,
  cleanupSessions,
  buildProposerCodeExecutionTool,
} from "./code-execution";
import type { AppSettings } from "@/lib/types";

/**
 * Real-spawn tests for the paths `code-execution.spawn.test.ts` left uncovered
 * (~600 no-coverage mutants at the 2026-07-21 Stryker run): the TERMINAL
 * runtime (login-shell wrap, session marker parse, per-session cwd
 * persistence), the PYTHON runtime (venv resolution — driven with a FAKE
 * `.venv/bin/python` shell script so no real Python is needed for the
 * resolution logic; only the no-venv fallback shells out to the system
 * `python3`), the managed-session API surface (yield-to-background, poll,
 * log slicing, kill error branches, list ordering, clear/remove), and the
 * proposer-scoped tool's preflight limits.
 *
 * Same threat-model boundary as the sibling spawn suite: these assert the
 * executor's OWN guarantees (marker integrity, env shaping, session state),
 * not OS-level confinement it never claimed.
 */

const cfg = (over: Partial<AppSettings["codeExecution"]> = {}): AppSettings["codeExecution"] =>
  ({ enabled: true, timeout: 30, maxOutputLength: 50000, ...over }) as AppSettings["codeExecution"];

let workDir: string;
beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-exec-"));
});
afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});
afterEach(() => cleanupSessions());

const sessionIdFrom = (out: string): string => {
  const m = out.match(/Session ID: (proc-[a-z0-9-]+)/);
  expect(m, `managed-session output carries a session id:\n${out}`).toBeTruthy();
  return m![1];
};

describe("terminal runtime — marker protocol", () => {
  it("captures stdout, strips the session marker, exits clean", async () => {
    const out = await executeCode("terminal", "echo TERM_OK", 4201, cfg(), workDir);
    expect(out).toContain("TERM_OK");
    // The wrapper's marker line is internal plumbing — it must NEVER leak
    // into what the model sees.
    expect(out).not.toContain("__ORCHESTRA_SESSION_RESULT");
    expect(out).not.toContain("Exit code");
  });

  it("propagates the wrapped command's exit code through the marker", async () => {
    const out = await executeCode("terminal", "exit 7", 4202, cfg(), workDir);
    expect(out).toContain("Exit code: 7");
  });

  it("persists cwd across calls sharing a terminal sessionId", async () => {
    await fs.mkdir(path.join(workDir, "subx"), { recursive: true });
    const first = await executeCode("terminal", "cd subx && echo MOVED", 4203, cfg(), workDir);
    expect(first).toContain("MOVED");
    const second = await executeCode("terminal", "pwd", 4203, cfg(), workDir);
    expect(second).toContain("/subx");
  });

  it("does NOT leak cwd into a different terminal sessionId", async () => {
    const out = await executeCode("terminal", "pwd", 4204, cfg(), workDir);
    expect(out).not.toContain("/subx");
  });
});

describe("python runtime — venv resolution (fake interpreter, no real Python needed)", () => {
  const makeFakeVenv = async (root: string, dirName: string, mode = 0o755) => {
    const bin = path.join(root, dirName, "bin");
    await fs.mkdir(bin, { recursive: true });
    const script = [
      "#!/bin/sh",
      'echo "FAKEPY VIRTUAL_ENV=$VIRTUAL_ENV"',
      'echo "PATHHEAD=${PATH%%:*}"',
    ].join("\n");
    const p = path.join(bin, "python");
    await fs.writeFile(p, script, { mode });
    return path.join(root, dirName);
  };

  it("prefers ./.venv/bin/python and exports VIRTUAL_ENV + PATH prefix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-venv-"));
    try {
      const venvDir = await makeFakeVenv(root, ".venv");
      const out = await executeCode("python", "print(1)", 0, cfg(), root);
      expect(out).toContain(`FAKEPY VIRTUAL_ENV=${venvDir}`);
      expect(out).toContain(`PATHHEAD=${path.join(venvDir, "bin")}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to ./venv when .venv is absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-venv-"));
    try {
      const venvDir = await makeFakeVenv(root, "venv");
      const out = await executeCode("python", "print(1)", 0, cfg(), root);
      expect(out).toContain(`FAKEPY VIRTUAL_ENV=${venvDir}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs the system python3 when no venv exists", async () => {
    const out = await executeCode("python", "print('SYSPY_OK')", 0, cfg(), workDir);
    expect(out).toContain("SYSPY_OK");
  });

  it("surfaces a spawn error when the venv python is not executable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-venv-"));
    try {
      await makeFakeVenv(root, ".venv", 0o644);
      const out = await executeCode("python", "print(1)", 0, cfg(), root);
      expect(out).toContain("Process error:");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("managed sessions — yield_ms", () => {
  it("a fast command completes within the yield window and returns its result", async () => {
    const out = await executeCode("nodejs", "console.log('FAST_DONE')", 0, cfg(), workDir, {
      yieldMs: 5000,
    });
    expect(out).toContain("FAST_DONE");
    expect(out).not.toContain("yielded to background");
  });

  it("a slow command yields to background and is pollable to completion", async () => {
    const out = await executeCode(
      "nodejs",
      "setTimeout(() => console.log('SLOW_DONE'), 700)",
      0,
      cfg(),
      workDir,
      { yieldMs: 100 }
    );
    expect(out).toContain("[Execution yielded to background]");
    const id = sessionIdFrom(out);

    // Poll until TERMINAL, not once.
    //
    // A single `pollManagedProcessSession(id, 10_000)` here was flaky — it
    // failed 2 of 4 full-suite runs with `status: "running"`. The cause is not
    // machine load and not a too-short cap: the helper's wait loop exits as
    // soon as the session's VERSION changes, i.e. the moment new output lands,
    // and `SLOW_DONE` is printed a few milliseconds BEFORE the process exits.
    // So the poll returned while the status was still `running` whenever the
    // output bump was observed first — a coin flip, not a timeout.
    //
    // Early-return-on-new-output is deliberate: it is what lets the agent
    // stream a long-running command instead of blocking for the whole
    // timeout. The helper is right; the one-shot expectation was wrong. Poll
    // the way a real caller does — until the status stops being `running`.
    let poll = await pollManagedProcessSession(id, 10_000);
    const deadline = Date.now() + 10_000;
    while (poll.status === "running" && Date.now() < deadline) {
      poll = await pollManagedProcessSession(id, 1_000);
    }

    expect(poll.success).toBe(true);
    expect(poll.status).toBe("completed");
    expect(poll.output).toContain("SLOW_DONE");
    expect(poll.exitCode).toBe(0);
  }, 30000);
});

describe("managed sessions — poll error branches", () => {
  it("empty session id → not_found with a directive", async () => {
    const res = await pollManagedProcessSession("   ");
    expect(res.success).toBe(false);
    expect(res.status).toBe("not_found");
    expect(res.output).toContain("session_id is required");
  });

  it("unknown session id → not_found naming the id", async () => {
    const res = await pollManagedProcessSession("proc-nope");
    expect(res.success).toBe(false);
    expect(res.status).toBe("not_found");
    expect(res.output).toContain("proc-nope");
  });
});

describe("managed sessions — log reader", () => {
  const finishedSession = async (): Promise<string> => {
    const out = await executeCode(
      "nodejs",
      "for (let i = 1; i <= 5; i++) console.log('LINE_' + i)",
      0,
      cfg(),
      workDir,
      { background: true }
    );
    const id = sessionIdFrom(out);
    const poll = await pollManagedProcessSession(id, 10_000);
    expect(poll.status).toBe("completed");
    return id;
  };

  it("empty / unknown ids → not_found", () => {
    expect(readManagedProcessSessionLog("").status).toBe("not_found");
    expect(readManagedProcessSessionLog("proc-nope").status).toBe("not_found");
  });

  it("default read returns the tail with totalLines", async () => {
    const id = await finishedSession();
    const log = readManagedProcessSessionLog(id);
    expect(log.success).toBe(true);
    expect(log.output).toContain("LINE_5");
    expect(log.totalLines).toBeGreaterThanOrEqual(5);
  }, 15000);

  it("offset/limit slice the log window", async () => {
    const id = await finishedSession();
    const log = readManagedProcessSessionLog(id, 1, 2);
    expect(log.success).toBe(true);
    expect(log.output).toContain("LINE_2");
    expect(log.output).toContain("LINE_3");
    expect(log.output).not.toContain("LINE_1");
    expect(log.output).not.toContain("LINE_4");
  }, 15000);
});

describe("managed sessions — kill error branches", () => {
  it("empty id → not_found", () => {
    const res = killManagedProcessSession("  ");
    expect(res.success).toBe(false);
    expect(res.status).toBe("not_found");
  });

  it("unknown id → not_found", () => {
    const res = killManagedProcessSession("proc-nope");
    expect(res.success).toBe(false);
    expect(res.status).toBe("not_found");
  });

  it("already-finished session → already_finished, not a second kill", async () => {
    const out = await executeCode("nodejs", "console.log('done')", 0, cfg(), workDir, {
      background: true,
    });
    const id = sessionIdFrom(out);
    await pollManagedProcessSession(id, 10_000);
    const res = killManagedProcessSession(id);
    expect(res.success).toBe(true);
    expect(res.status).toBe("already_finished");
  }, 15000);
});

describe("managed sessions — listing and cleanup", () => {
  it("lists sessions newest-first", async () => {
    const first = await executeCode("nodejs", "console.log('a')", 0, cfg(), workDir, {
      background: true,
    });
    const firstId = sessionIdFrom(first);
    await new Promise((r) => setTimeout(r, 25)); // distinct startedAt
    const second = await executeCode("nodejs", "console.log('b')", 0, cfg(), workDir, {
      background: true,
    });
    const secondId = sessionIdFrom(second);

    const ids = listManagedProcessSessions().map((s) => s.sessionId);
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));

    await pollManagedProcessSession(firstId, 10_000);
    await pollManagedProcessSession(secondId, 10_000);
  }, 15000);

  it("removeManagedProcessSession removes exactly the finished target", async () => {
    const out = await executeCode("nodejs", "console.log('x')", 0, cfg(), workDir, {
      background: true,
    });
    const id = sessionIdFrom(out);
    await pollManagedProcessSession(id, 10_000);

    expect(removeManagedProcessSession("")).toEqual({ removed: false });
    expect(removeManagedProcessSession("proc-nope")).toEqual({ removed: false });
    expect(removeManagedProcessSession(id)).toEqual({ removed: true });
    await expect(pollManagedProcessSession(id).then((r) => r.status)).resolves.toBe("not_found");
  }, 15000);

  it("clearFinishedManagedProcessSessions reports the purge count", async () => {
    const out = await executeCode("nodejs", "console.log('y')", 0, cfg(), workDir, {
      background: true,
    });
    await pollManagedProcessSession(sessionIdFrom(out), 10_000);
    const { removed } = clearFinishedManagedProcessSessions();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(listManagedProcessSessions().filter((s) => s.status !== "running")).toHaveLength(0);
  }, 15000);
});

describe("proposer-scoped code_execution tool — preflight limits", () => {
  const settings = { codeExecution: cfg() } as AppSettings;
  const tool = buildProposerCodeExecutionTool(settings, os.tmpdir());
  type ProposerExec = (input: { runtime: "python" | "nodejs" | "terminal"; code: string }) => Promise<string>;
  const run = tool.execute as unknown as ProposerExec;

  it("rejects an empty payload", async () => {
    expect(await run({ runtime: "nodejs", code: "   \n  " })).toContain("Empty code payload");
  });

  it("rejects an oversized payload with the limit named", async () => {
    const out = await run({ runtime: "nodejs", code: "x".repeat(20001) });
    expect(out).toContain("too large");
    expect(out).toContain("20000");
  });

  it("rejects too many lines with the limit named", async () => {
    const out = await run({ runtime: "nodejs", code: Array(801).fill("1;").join("\n") });
    expect(out).toContain("too many lines");
    expect(out).toContain("800");
  });

  it("delegates a valid payload to the real executor", async () => {
    const out = await run({ runtime: "nodejs", code: "console.log('PROPOSER_OK')" });
    expect(out).toContain("PROPOSER_OK");
  });
});

const onMac = process.platform === "darwin" ? describe : describe.skip;

onMac("sandbox anchoring — a session `cd` must not widen what may be written", () => {
  // A real two-step escape, found by line-by-line review AFTER a model council
  // reviewed the same code and missed it. The terminal runtime persists each
  // run's `pwd` into the session state, so `prepared.cwd` DRIFTS. Anchoring the
  // Seatbelt profile on it made the sandbox self-widening: `cd ~` is permitted
  // (it needs only read and execute), and the next command in the same session
  // inherited write access to the entire home directory.
  //
  // Driven through `executeCode` on purpose. A profile-shaped assertion cannot
  // see this bug at all — the profile was always internally consistent; the
  // defect was in which directory it was handed.
  const probe = path.join(os.homedir(), `.orchestra-anchor-probe-${process.pid}`);

  afterEach(async () => {
    await fs.rm(probe, { force: true });
  });

  it("still refuses a HOME write after the session has cd'd to HOME", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orch-anchor-"));
    const session = 4901;

    // Control: the write is refused before any `cd`, so step 3 is comparable.
    await executeCode("terminal", `echo a > ${probe}`, session, cfg(), workDir);
    expect(await fs.access(probe).then(() => true, () => false)).toBe(false);

    // The drift itself must keep working — `cd` is legitimate.
    const moved = await executeCode("terminal", `cd ${os.homedir()} && pwd`, session, cfg(), workDir);
    expect(moved).toContain(os.homedir());

    // Same session, post-drift: still refused.
    await executeCode("terminal", `echo pwned > ${probe}`, session, cfg(), workDir);
    expect(await fs.access(probe).then(() => true, () => false)).toBe(false);

    await fs.rm(workDir, { recursive: true, force: true });
  });
});

onMac("sandbox denies SECRETS, not tool CONFIG", () => {
  // An earlier profile denied whole tool-config directories (`.config/gh`,
  // `.config/git`, `.config/gcloud`, `.docker`). That broke the tools outright
  // while protecting nothing: `gh` refused to start at all —
  //   "failed to read configuration: .config/gh/config.yml: operation not permitted"
  // — and its token was never in that directory; it lives in the keyring.
  //
  // The rule this pins: a config file a tool needs in order to RUN stays
  // readable. Credential MATERIAL does not. Asserting only that `gh` starts,
  // never that it authenticates — the keychain is deliberately denied, so
  // authentication failing inside the sandbox is correct behaviour.
  it("lets gh start (config readable) even though its credential store is not", async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orch-ghcfg-"));
    const out = await executeCode("terminal", "gh --version 2>&1 | head -2", 4902, cfg(), workDir);
    expect(out).not.toContain("failed to read configuration");
    expect(out).toMatch(/gh version/i);
    await fs.rm(workDir, { recursive: true, force: true });
  });
});
