import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyExecSandbox,
  buildSeatbeltProfile,
  describeSandboxSpawnFailure,
  detectExecSandbox,
  resetExecSandboxDetection,
} from "./exec-sandbox";

const HOME = "/Users/testuser";

beforeEach(() => resetExecSandboxDetection());
afterEach(() => {
  delete process.env.ORCHESTRA_EXEC_SANDBOX;
  resetExecSandboxDetection();
});

describe("buildSeatbeltProfile", () => {
  it("makes the work dir writable", () => {
    const p = buildSeatbeltProfile({ workDir: "/tmp/proj", homeDir: HOME });
    expect(p).toContain("(deny file-write*)");
    expect(p).toMatch(/\(allow file-write\*[^\n]*\(subpath "\/tmp\/proj"\)/);
  });

  it("keeps package-manager caches writable — a deny-all profile breaks npm install", () => {
    const p = buildSeatbeltProfile({ workDir: "/tmp/proj", homeDir: HOME });
    expect(p).toContain(`(subpath "${HOME}/.npm")`);
    expect(p).toContain(`(subpath "${HOME}/.cache")`);
  });

  it("denies reading the credential set", () => {
    const p = buildSeatbeltProfile({ workDir: "/tmp/proj", homeDir: HOME });
    expect(p).toContain(`(subpath "${HOME}/.ssh")`);
    expect(p).toContain(`(subpath "${HOME}/.aws")`);
    expect(p).toContain(`(literal "${HOME}/.netrc")`);
  });

  it("emits the read-denials LAST — Seatbelt resolves by last match, so order is the rule", () => {
    // If an `allow` is ever appended after the denials, the credential block is
    // silently re-opened and every other assertion here still passes. That is
    // the failure this test exists to catch.
    const p = buildSeatbeltProfile({ workDir: "/tmp/proj", homeDir: HOME });
    const lastAllow = p.lastIndexOf("(allow file-");
    const denyRead = p.indexOf("(deny file-read*");
    expect(denyRead).toBeGreaterThan(lastAllow);
  });

  it("escapes quotes and backslashes in paths", () => {
    const p = buildSeatbeltProfile({ workDir: '/tmp/we"ird\\dir', homeDir: HOME });
    expect(p).toContain('"/tmp/we\\"ird\\\\dir"');
  });

  it("threads caller-supplied write and deny-read roots", () => {
    const p = buildSeatbeltProfile({
      workDir: "/tmp/proj",
      homeDir: HOME,
      extraWritePaths: ["/data/tmp"],
      extraDenyReadPaths: ["/data/settings"],
    });
    expect(p).toContain('(subpath "/data/tmp")');
    expect(p.indexOf('"/data/settings"')).toBeGreaterThan(p.indexOf('"/data/tmp"'));
  });
});

describe("describeSandboxSpawnFailure", () => {
  it("recovers the inner error from sandbox-exec's EX_OSERR exit", () => {
    const msg = describeSandboxSpawnFailure(
      71,
      "sandbox-exec: execvp() of '/x/.venv/bin/python' failed: Permission denied\n"
    );
    expect(msg).toBe("execvp() of '/x/.venv/bin/python' failed: Permission denied");
  });

  it("leaves an ordinary non-zero exit alone", () => {
    expect(describeSandboxSpawnFailure(1, "boom")).toBeNull();
    expect(describeSandboxSpawnFailure(0, "")).toBeNull();
    expect(describeSandboxSpawnFailure(null, "")).toBeNull();
  });

  it("does not claim a spawn failure for an unrelated 71", () => {
    expect(describeSandboxSpawnFailure(71, "the program chose to exit 71")).toBeNull();
  });
});

describe("applyExecSandbox", () => {
  it("returns the command untouched, and SAYS SO, when disabled", () => {
    process.env.ORCHESTRA_EXEC_SANDBOX = "off";
    resetExecSandboxDetection();
    const out = applyExecSandbox("node", ["-e", "1"], { workDir: "/tmp/proj" });
    expect(out.command).toBe("node");
    expect(out.args).toEqual(["-e", "1"]);
    expect(out.sandbox.kind).toBe("none");
    // Degradation must be reportable — a sandbox that quietly does nothing is
    // worse than none, because it gets believed.
    expect(out.sandbox.reason).toMatch(/ORCHESTRA_EXEC_SANDBOX/);
  });
});

const onMac = process.platform === "darwin" ? describe : describe.skip;

onMac("Seatbelt actually enforces (real sandbox-exec, no mocks)", () => {
  // These run the mechanism. A profile that parses is not a profile that
  // confines — the same reason an MCP config that parses is not a server that
  // starts. Each case is paired with an unsandboxed control, so a run where
  // sandbox-exec silently did nothing cannot pass.
  let work: string;
  let secrets: string;
  let profile: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-work-"));
    secrets = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-secret-"));
    fs.writeFileSync(path.join(secrets, "keys.json"), '{"apiKey":"sk-REAL"}');
    profile = buildSeatbeltProfile({ workDir: work, extraDenyReadPaths: [secrets] });
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(secrets, { recursive: true, force: true });
  });

  function sandboxed(script: string): { code: number; out: string } {
    try {
      const out = execFileSync("sandbox-exec", ["-p", profile, "/bin/sh", "-c", script], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  }

  it("detects the mechanism on this platform", () => {
    expect(detectExecSandbox().kind).toBe("seatbelt");
  });

  it("allows writes inside the work dir", () => {
    expect(sandboxed(`echo ok > ${work}/f.txt`).code).toBe(0);
    expect(fs.existsSync(path.join(work, "f.txt"))).toBe(true);
  });

  it("blocks a write into the home dir that succeeds unsandboxed", () => {
    // Deliberately NOT a temp path: the system temp root is writable BY DESIGN
    // (every toolchain needs it), so asserting a denial there would only prove
    // the test picked a directory the profile already allows. The home
    // directory is the asset an injected payload actually goes after.
    const target = path.join(os.homedir(), `.orchestra-sbx-probe-${process.pid}`);
    try {
      // Control: without confinement this write genuinely lands.
      fs.writeFileSync(target, "x");
      expect(fs.existsSync(target)).toBe(true);
      fs.rmSync(target);

      expect(sandboxed(`echo pwned > ${target}`).code).not.toBe(0);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it("blocks reading a secrets dir that IS readable unsandboxed", () => {
    // Control first: without confinement this is a working exfiltration.
    expect(fs.readFileSync(path.join(secrets, "keys.json"), "utf8")).toContain("sk-REAL");

    const res = sandboxed(`cat ${secrets}/keys.json`);
    expect(res.code).not.toBe(0);
    expect(res.out).not.toContain("sk-REAL");
  });

  it("still lets the interpreters the agent depends on run", () => {
    expect(sandboxed(`node -e 'console.log("n-ok")'`).out).toContain("n-ok");
  });
});
