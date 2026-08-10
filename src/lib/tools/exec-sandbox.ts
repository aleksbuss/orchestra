/**
 * OS-level confinement for code execution (§ "Egress & execution").
 *
 * WHAT THIS IS FOR. `code_execution` runs model-authored code. Until now the
 * only thing standing between a prompt-injected payload and the operator's
 * home directory was POLICY: the `dangerous-command-guard` deny-list, env
 * scrubbing, RCE tools denied to untrusted triggers, and a `cwd` pinned to the
 * project directory. Policy is a filter — it stops what it recognises. This
 * module adds STRUCTURE: the kernel refuses the write regardless of whether
 * anything recognised the command.
 *
 * WHY NOT DOCKER. The containerised path already exists (`npm run
 * setup:docker`) and is the stronger boundary. It is deliberately NOT the
 * default: the default install has to be one command for a non-technical user,
 * who would be lost configuring a Docker daemon. So the default path needs a
 * boundary that requires the user to install NOTHING. On macOS that is
 * `sandbox-exec` (Seatbelt), present on every machine.
 *
 * WHY FILESYSTEM ONLY, NOT NETWORK. Confining the network would break the web
 * tools, MCP servers and every package install the agent legitimately performs.
 * Filesystem confinement alone removes the payoff from the realistic attack —
 * reading credentials, or writing outside the project — at zero cost to normal
 * work. Network policy stays in the application layer (`assertSafeOutboundUrl`).
 *
 * WHY IT IS PERMISSIVE ABOUT CACHES. A deny-by-default profile is stronger on
 * paper and useless in practice here: measured, `npm install` fails outright
 * because npm writes to `~/.npm`, and a non-technical user reads that as "the
 * AI is broken", not "the sandbox worked". Package-manager caches are therefore
 * writable. They are not the asset worth protecting — credentials are, and
 * those are denied for READ, which is the rule that actually matters.
 *
 * DEGRADATION IS EXPLICIT, NEVER SILENT. Where no mechanism is available the
 * command runs exactly as before and the decision is reported to the caller so
 * the UI can say so. A sandbox that quietly does nothing is worse than none,
 * because it is believed.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

/** Which confinement mechanism is in force for a spawn. */
export type SandboxKind = "seatbelt" | "none";

export interface SandboxDecision {
  kind: SandboxKind;
  /** Human-readable reason, surfaced in logs and the UI warning. */
  reason: string;
}

/**
 * Escape hatch. `ORCHESTRA_EXEC_SANDBOX=off` restores the pre-sandbox
 * behaviour. Documented in `docs/references/security-patterns.md` alongside the
 * other hatches — an undocumented one is indistinguishable from a bug.
 */
function sandboxDisabled(): boolean {
  return process.env.ORCHESTRA_EXEC_SANDBOX === "off";
}

/**
 * Directories whose CONTENTS are credentials. Denied for read, so a payload
 * cannot exfiltrate them even if it is allowed to run.
 *
 * Relative to the user's home. `~/.config` as a whole is NOT denied — too much
 * legitimate tooling lives there — so its credential-bearing children are
 * listed individually.
 */
const CREDENTIAL_SUBPATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/gh",
  ".config/git",
  ".local/share/keyrings",
  "Library/Keychains",
  "Library/Application Support/Google/Chrome/Default/Login Data",
];

/** Individual credential files (not directories) denied for read. */
const CREDENTIAL_FILES = [".netrc", ".npmrc", ".pypirc", ".git-credentials"];

/**
 * Writable cache roots. Package managers are useless without these, and a cache
 * is not an asset — see the module header.
 */
const CACHE_SUBPATHS = [
  ".npm",
  ".cache",
  ".pnpm-store",
  ".yarn",
  ".bun",
  ".cargo",
  ".rustup",
  ".deno",
  ".local/share/uv",
  ".local/share/virtualenv",
  "Library/Caches",
  "Library/pnpm",
];

let cachedDecision: SandboxDecision | null = null;

/**
 * Detect an available mechanism, once per process.
 *
 * Probing runs `sandbox-exec` on a trivial profile rather than testing for the
 * binary's existence: the binary is present but non-functional in some
 * environments (containers, restricted CI), and "the file exists" is exactly
 * the kind of proxy that reports success while the mechanism is dead.
 */
export function detectExecSandbox(): SandboxDecision {
  if (cachedDecision) return cachedDecision;

  if (sandboxDisabled()) {
    cachedDecision = { kind: "none", reason: "disabled via ORCHESTRA_EXEC_SANDBOX=off" };
    return cachedDecision;
  }

  if (process.platform === "darwin") {
    try {
      execFileSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
        stdio: "ignore",
        timeout: 5000,
      });
      cachedDecision = { kind: "seatbelt", reason: "macOS Seatbelt (sandbox-exec)" };
      return cachedDecision;
    } catch {
      cachedDecision = { kind: "none", reason: "sandbox-exec present but not functional" };
      return cachedDecision;
    }
  }

  cachedDecision = {
    kind: "none",
    reason: `no filesystem confinement available on ${process.platform} — run via 'npm run setup:docker' for isolation`,
  };
  return cachedDecision;
}

/** Test seam: forget the cached probe result. */
export function resetExecSandboxDetection(): void {
  cachedDecision = null;
}

/** Seatbelt string literals are quoted; a path containing `"` or `\` must escape. */
function sbQuote(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Resolve symlinks before a path enters a profile.
 *
 * NOT cosmetic — this is the difference between a sandbox and the appearance of
 * one. Seatbelt matches on the RESOLVED path, and on macOS `/var`, `/tmp` and
 * `/etc` are symlinks into `/private`. A rule written against the unresolved
 * `/var/folders/…` that `os.tmpdir()` returns therefore matches nothing: the
 * deny never fires, the access is permitted, and every structural assertion
 * about the profile still passes. It fails OPEN and silently.
 *
 * Found by the real-enforcement tests in this module's spec, which caught a
 * secrets read sailing through a profile that explicitly denied it.
 *
 * A path that does not exist yet still has to be resolved, because its ANCESTORS
 * may be symlinks: `realpathSync` throws on `/tmp/proj` before that directory is
 * created, and a bare `path.resolve` then bakes `/tmp/proj` into the profile
 * while the kernel will match `/private/tmp/proj`. So resolve the deepest
 * existing ancestor and re-append the rest.
 *
 * Note the direction of that failure, because a review got it backwards: an
 * unmatched rule is an ALLOW that never fires, i.e. the write is DENIED. It
 * breaks a legitimate workflow rather than opening a hole — still worth fixing,
 * and worth fixing for the right reason.
 */
function resolveForProfile(p: string): string {
  const absolute = path.resolve(p);
  let head = absolute;
  const tail: string[] = [];

  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return absolute; // hit the root: nothing resolvable
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

export interface SeatbeltProfileOptions {
  /** The project directory the run is allowed to write to. */
  workDir: string;
  /** Extra writable roots (temp dirs, the data dir's scratch space). */
  extraWritePaths?: string[];
  /** Extra read-denied roots — the install's own secrets. */
  extraDenyReadPaths?: string[];
  /** Override the home directory (tests). */
  homeDir?: string;
}

/**
 * Build a Seatbelt profile.
 *
 * ORDER IS LOAD-BEARING: Seatbelt applies rules in order and the LAST match
 * wins, so the credential read-denials are emitted after every allow. Moving
 * them earlier silently re-permits reads that an allow further down re-opens —
 * a failure that looks identical to a working sandbox from the outside.
 */
export function buildSeatbeltProfile(options: SeatbeltProfileOptions): string {
  const home = resolveForProfile(options.homeDir ?? os.homedir());
  const writable = [
    options.workDir,
    // THIS process's own per-user temp/cache root, not the whole
    // `/private/var/folders` tree. The tree holds one such root per user plus
    // the system's, and nothing the agent runs needs another account's temp
    // dir. The parent of `os.tmpdir()` is the Darwin user dir, which covers
    // both `T` (temp) and `C` (cache) — so `getconf DARWIN_USER_CACHE_DIR`
    // consumers keep working while the blast radius drops to one account.
    path.dirname(resolveForProfile(os.tmpdir())),
    "/private/tmp",
    ...CACHE_SUBPATHS.map((p) => path.join(home, p)),
    ...(options.extraWritePaths ?? []),
  ].map(resolveForProfile);

  const lines: string[] = [
    "(version 1)",
    "; Reads stay broad: interpreters, libraries and toolchains live all over the",
    "; filesystem, and denying reads by default breaks node/python before it",
    "; blocks anything. Credentials are re-denied at the bottom.",
    "(allow default)",
    "",
    "; --- writes: deny everything, then re-open the project and the caches ---",
    "; The system temp root is writable BY DESIGN — compilers, package managers",
    "; and test runners are unusable without it. It holds no assets worth",
    "; protecting; the home directory and the credential set are the targets.",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((p) => `(subpath ${sbQuote(p)})`).join(" ")})`,
    // Character devices a shell pipeline cannot run without. `/dev/dtracehelper`
    // was here defensively and is deliberately NOT: DTrace is a process- and
    // memory-inspection interface, nothing the agent legitimately runs touches
    // it, and "I added it just in case" is the wrong reason to widen a sandbox.
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout")',
    '  (literal "/dev/stderr") (literal "/dev/tty"))',
    "",
    "; --- reads: the credential set, denied LAST so no allow above re-opens it ---",
  ];

  const denyRead = [
    ...CREDENTIAL_SUBPATHS.map((p) => `(subpath ${sbQuote(resolveForProfile(path.join(home, p)))})`),
    ...CREDENTIAL_FILES.map((p) => `(literal ${sbQuote(resolveForProfile(path.join(home, p)))})`),
    ...(options.extraDenyReadPaths ?? []).map((p) => `(subpath ${sbQuote(resolveForProfile(p))})`),
  ];
  lines.push(`(deny file-read* ${denyRead.join(" ")})`);

  return lines.join("\n");
}

/**
 * `sandbox-exec` exits 71 (EX_OSERR) when IT starts fine but cannot exec the
 * target — a missing or non-executable interpreter, say.
 *
 * Without this translation the wrapper silently downgrades a diagnostic: an
 * unspawnable interpreter used to arrive as Node's spawn `error` event and be
 * reported as `Process error: …`, which is how the agent learns the runtime is
 * broken rather than the code. Under the wrapper the same condition becomes a
 * plain non-zero exit with a stderr line, and the agent sees "exit 71" —
 * true, useless, and a different failure mode from the one every existing test
 * and prompt was written against. Caught by
 * `code-execution.runtimes.spawn.test.ts`, not by review.
 *
 * @returns the inner failure message, or `null` when this is an ordinary exit.
 */
export function describeSandboxSpawnFailure(
  exitCode: number | null | undefined,
  stderr: string
): string | null {
  if (exitCode !== 71) return null;
  const match = /sandbox-exec:\s*(execvp\(\).*)$/m.exec(stderr);
  return match ? match[1].trim() : null;
}

export interface SandboxedCommand {
  command: string;
  args: string[];
  sandbox: SandboxDecision;
}

let sandboxDecisionReported = false;

/** Test seam: allow the one-shot report to fire again. */
export function resetSandboxDecisionReport(): void {
  sandboxDecisionReported = false;
}

/**
 * Say once, out loud, whether confinement is actually in force.
 *
 * The decision was being threaded onto the prepared command and read by nobody,
 * which is the precise shape of failure this module claims to avoid: an
 * operator on a platform with no mechanism would have believed the feature was
 * protecting them. Console, not the structured logger, for the same reason
 * `schema-version.ts` uses it — a solo local operator reads their own dev
 * terminal, and this must not depend on a log sink being wired.
 *
 * A UI surface is NOT built; this is the whole of the reporting.
 */
function reportSandboxDecisionOnce(decision: SandboxDecision): void {
  if (sandboxDecisionReported) return;
  sandboxDecisionReported = true;
  if (decision.kind === "none") {
    console.warn(
      `[code-execution] NO filesystem confinement (${decision.reason}). ` +
        `Model-authored code runs with your user's full write access. ` +
        `For isolation, run Orchestra via 'npm run setup:docker'.`
    );
  }
}

/**
 * The one call the executor makes: confine a command to a project, and report
 * what actually happened.
 *
 * `projectRoot` MUST be the project the run belongs to, never the executor's
 * current working directory. The terminal runtime persists each run's `pwd`
 * into its session state, so a cwd-anchored profile is self-widening: `cd ~`
 * is permitted (read and execute only), and the next command in that session
 * inherits write access to the whole home directory. Verified end-to-end, then
 * pinned by a test in `code-execution.runtimes.spawn.test.ts`.
 *
 * Lives here rather than in the executor so the sandbox's own knowledge — which
 * roots are writable, which are secret, how degradation is reported — stays in
 * one module, and so wiring it costs the executor a single call.
 */
export function sandboxProjectCommand(
  command: string,
  args: string[],
  projectRoot: string,
  paths: { writable: string[]; secret: string[] }
): SandboxedCommand {
  const wrapped = applyExecSandbox(command, args, {
    workDir: projectRoot,
    extraWritePaths: paths.writable,
    extraDenyReadPaths: paths.secret,
  });
  reportSandboxDecisionOnce(wrapped.sandbox);
  return wrapped;
}

/**
 * Wrap a prepared command in the available confinement mechanism.
 *
 * Returns the command UNCHANGED when nothing is available — the caller reports
 * the decision rather than assuming confinement happened.
 */
export function applyExecSandbox(
  command: string,
  args: string[],
  options: SeatbeltProfileOptions
): SandboxedCommand {
  const decision = detectExecSandbox();
  if (decision.kind !== "seatbelt") {
    return { command, args, sandbox: decision };
  }

  const profile = buildSeatbeltProfile(options);
  return {
    command: "sandbox-exec",
    args: ["-p", profile, command, ...args],
    sandbox: decision,
  };
}
