import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import {
  executeCode,
  listManagedProcessSessions,
  killManagedProcessSession,
  cleanupSessions,
} from "./code-execution";
import type { AppSettings } from "@/lib/types";

/**
 * Real-spawn tests for the executor (`code-execution.ts`) — the RCE surface,
 * previously at ~5% coverage. These drive `executeCode` against the REAL `node`
 * binary (guaranteed present; no network; sub-second scripts) so the security +
 * logic properties are proven END-TO-END, not on an isolated helper:
 *   - the cwd-required footgun guard (no spawn on empty cwd),
 *   - the PM #84 exit-code signal (`Exit code: N` iff non-zero) — load-bearing
 *     for the completion-honesty contract,
 *   - env scrub REACHING the child (a secret in process.env is absent in the
 *     spawned process; PATH is kept so the child can run at all),
 *   - output head+tail capping under a large payload,
 *   - foreground timeout kills the child and returns promptly,
 *   - managed-session kill actually terminates the OS process (no zombie).
 *
 * Threat-model boundary (deliberate NON-goals): the child runs with the
 * operator's own privileges. There is NO PATH jail, network block, filesystem
 * sandbox, or rlimit here by design — containment is the opt-in Docker story
 * (CLAUDE.md §6). These tests assert the executor's OWN guarantees, not
 * confinement it never claimed.
 */

const CWD = os.tmpdir();
const cfg = (over: Partial<AppSettings["codeExecution"]> = {}): AppSettings["codeExecution"] =>
  ({ enabled: true, timeout: 30, maxOutputLength: 50000, ...over }) as AppSettings["codeExecution"];

// Kill any managed children this suite spawned so the runner can exit cleanly.
afterEach(() => cleanupSessions());

describe("executeCode — cwd-required guard (no spawn)", () => {
  it("refuses an empty cwd instead of falling back to the Orchestra source tree", async () => {
    const out = await executeCode("nodejs", "console.log(1)", 0, cfg(), "");
    expect(out).toContain("cwd is required");
  });
  it("refuses a whitespace-only cwd", async () => {
    const out = await executeCode("nodejs", "console.log(1)", 0, cfg(), "   ");
    expect(out).toContain("cwd is required");
  });
});

describe("executeCode — PM #84 exit-code signal", () => {
  it("appends 'Exit code: N' on a non-zero exit", async () => {
    const out = await executeCode("nodejs", "process.exit(3)", 0, cfg(), CWD);
    expect(out).toContain("Exit code: 3");
  });
  it("does NOT append an exit-code line on a clean (zero) exit", async () => {
    // The signal must be false-negative-biased: a success turn carries no
    // 'Exit code' line, so the completion-honesty surface (PM #84) stays clean.
    const out = await executeCode("nodejs", "console.log('ok')", 0, cfg(), CWD);
    expect(out).toContain("ok");
    expect(out).not.toContain("Exit code");
  });
});

describe("executeCode — stream capture", () => {
  it("captures both stdout and stderr", async () => {
    const out = await executeCode(
      "nodejs",
      "console.log('OUT_MARKER'); console.error('ERR_MARKER')",
      0,
      cfg(),
      CWD
    );
    expect(out).toContain("OUT_MARKER");
    expect(out).toContain("ERR_MARKER");
  });
});

describe("executeCode — env scrub reaches the spawned child (security)", () => {
  it("a *_API_KEY in the parent env is ABSENT in the child, but PATH is kept", async () => {
    const SECRET = "sk-leak-" + Math.random().toString(36).slice(2);
    process.env.LEAKTEST_API_KEY = SECRET;
    try {
      const out = await executeCode(
        "nodejs",
        "process.stdout.write('KEY='+String(process.env.LEAKTEST_API_KEY)+' PATHLEN='+String((process.env.PATH||'').length))",
        0,
        cfg(),
        CWD
      );
      // The scrub reached the real child: the secret never made it across.
      expect(out).not.toContain(SECRET);
      expect(out).toContain("KEY=undefined");
      // PATH is deliberately kept (the child must be able to resolve binaries).
      expect(out).toMatch(/PATHLEN=[1-9]/);
    } finally {
      delete process.env.LEAKTEST_API_KEY;
    }
  });
});

describe("executeCode — output capping under a large payload", () => {
  it("caps oversized output head+tail instead of returning it whole", async () => {
    const out = await executeCode(
      "nodejs",
      "process.stdout.write('Z'.repeat(300000))",
      0,
      cfg({ maxOutputLength: 4000 }),
      CWD
    );
    // Bounded well under the 300k the child emitted (head+tail + markers/labels).
    expect(out.length).toBeLessThan(20000);
    expect(out).toContain("truncated");
  });
});

describe("executeCode — foreground timeout", () => {
  it("kills a long-running child and returns promptly (does not hang)", async () => {
    const started = Date.now();
    const out = await executeCode(
      "nodejs",
      "setTimeout(() => console.log('LATE_SHOULD_NOT_APPEAR'), 8000)",
      0,
      cfg({ timeout: 1 }),
      CWD
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(7000); // returned around the 1s timeout, not after 8s
    expect(out).not.toContain("LATE_SHOULD_NOT_APPEAR");
  }, 12000);
});

describe("executeCode — managed session kill terminates the real process (no zombie)", () => {
  it("start background → list shows a live pid → kill → the OS process is dead", async () => {
    const running = await executeCode(
      "nodejs",
      "setInterval(() => {}, 1000)",
      0,
      cfg(),
      CWD,
      { background: true }
    );
    expect(running).toMatch(/session|background|running/i);

    const sessions = listManagedProcessSessions();
    const live = sessions.find((s) => s.status === "running" && typeof s.pid === "number");
    expect(live, "a running managed session with a pid").toBeTruthy();
    const pid = live!.pid!;
    // The pid is real and alive right now.
    expect(() => process.kill(pid, 0)).not.toThrow();

    const res = killManagedProcessSession(live!.sessionId);
    expect(res.status).toBe("killed");

    // SIGTERM lands async; poll until the OS reports the pid gone (ESRCH).
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        dead = true;
      }
    }
    expect(dead, "child process terminated after kill").toBe(true);
  }, 12000);
});
