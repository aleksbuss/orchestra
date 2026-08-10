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
    // Expect the RESOLVED form: `/tmp` is a symlink on macOS, and the profile
    // must carry what the kernel will match. Derived independently of the code
    // under test so this cannot pass by agreeing with the same bug.
    const resolved = path.join(fs.realpathSync("/tmp"), "proj");
    expect(p).toMatch(
      new RegExp(`\\(allow file-write\\*[^\\n]*\\(subpath "${resolved.replace(/\//g, "\\/")}"\\)`)
    );
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

  it("grants only THIS account's temp root, not the whole /private/var/folders tree", () => {
    // The tree holds one per-user temp/cache root per account plus the
    // system's. A review flagged the wide grant; narrowing costs nothing and
    // does not break `npm install` (verified against the real profile).
    const p = buildSeatbeltProfile({ workDir: "/tmp/proj", homeDir: HOME });
    expect(p).not.toContain('(subpath "/private/var/folders")');
    expect(p).toContain(`(subpath "${path.dirname(fs.realpathSync(os.tmpdir()))}")`);
  });

  it("does not hand out /dev/dtracehelper", () => {
    // DTrace is a process- and memory-inspection interface. It was in the
    // allow list defensively, which is the wrong reason to widen a sandbox.
    const p = buildSeatbeltProfile({ workDir: "/tmp/proj", homeDir: HOME });
    expect(p).not.toContain("dtracehelper");
  });

  it("resolves a symlinked ANCESTOR of a path that does not exist yet", () => {
    // `/tmp` is a symlink to `/private/tmp`, so a work dir that has not been
    // created yet must still enter the profile as `/private/tmp/...`. Baking
    // the unresolved form in produces an allow rule the kernel never matches —
    // which denies the write rather than permitting it, so the symptom is a
    // broken workflow, not an escape.
    const p = buildSeatbeltProfile({
      workDir: "/tmp/not-created-yet/deeper",
      homeDir: HOME,
    });
    expect(p).toContain('(subpath "/private/tmp/not-created-yet/deeper")');
    expect(p).not.toContain('(subpath "/tmp/not-created-yet/deeper")');
  });

  it("escapes quotes and backslashes in paths", () => {
    // Assert on the basename only — the directory part is rewritten by symlink
    // resolution, and this test is about quoting, not paths.
    const p = buildSeatbeltProfile({ workDir: '/tmp/we"ird\\dir', homeDir: HOME });
    expect(p).toContain('we\\"ird\\\\dir"');
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

  it("fails CLOSED on a symlink planted inside the writable work dir", () => {
    // A review argued this was a TOCTOU escape: plant a link in an allowed
    // directory, then reach a denied one through it. Measured, it is not —
    // Seatbelt resolves the path AT ACCESS TIME, so the denied target is what
    // gets matched and the allow on the work dir never applies. Pinned here
    // because the claim is plausible enough to be re-raised, and because a
    // future profile change could quietly make it true.
    const readLink = path.join(work, "escape-read");
    fs.symlinkSync(secrets, readLink);
    expect(sandboxed(`cat ${readLink}/keys.json`).out).not.toContain("sk-REAL");

    // The write half deliberately targets HOME, not the temp-backed secrets
    // dir: temp is writable by design, so a denial there would prove only that
    // the test picked an allowed destination. An earlier draft of this test did
    // exactly that and passed for the wrong reason.
    const writeLink = path.join(work, "escape-write");
    fs.symlinkSync(os.homedir(), writeLink);
    const landed = path.join(os.homedir(), `.orchestra-sbx-escape-${process.pid}`);
    try {
      expect(sandboxed(`echo pwned > ${writeLink}/${path.basename(landed)}`).code).not.toBe(0);
      expect(fs.existsSync(landed)).toBe(false);
    } finally {
      fs.rmSync(landed, { force: true });
    }
  });

  it("still lets the interpreters the agent depends on run", () => {
    expect(sandboxed(`node -e 'console.log("n-ok")'`).out).toContain("n-ok");
  });
});
