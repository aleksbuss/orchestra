/**
 * Binary-gated auto-install of the bundled `graphify` skill into a new project.
 *
 * WHY THIS EXISTS: graphify measurably saves tool-calls on codebase-exploration
 * turns, but it wraps an external Python CLI that is absent on essentially every
 * fresh install (see `docs/references/graphify-integration-adr.md`). Installing
 * it unconditionally would list a skill whose probe fails on those machines —
 * wasted prompt tokens plus a dead skill in every turn. So the install is
 * *gated on the binary actually being present on `PATH`*: where the operator has
 * graphify, every new project gets it automatically (the point); where they do
 * not, nothing changes and the clean-boot posture the ADR chose is preserved.
 *
 * LEAF MODULE, ON PURPOSE: this imports nothing from `project-store`. The copy
 * helper takes the target skills directory as a parameter instead of resolving
 * it here, so `project-store` → `skill-autoinstall` is a one-way edge with no
 * cycle (the same trap `project-skills` records), and every function is unit
 * testable against a temp dir with no live data root.
 *
 * DETECTION IS A `PATH` SCAN, NOT A SPAWN: probing with `graphify --version`
 * would add a child process to the project-creation path, which drags in the
 * `scrubProcessEnv` obligation (rule 9) for a spawn `project-store` has no
 * business making. `fs.stat` over the `PATH` entries answers the same question
 * with no process and no environment exposure.
 */
import fs from "fs/promises";
import path from "path";

/** Absolute path to the bundled graphify skill source, resolved once at load. */
const GRAPHIFY_BUNDLED_DIR = path.join(process.cwd(), "bundled-skills", "graphify");

const GRAPHIFY_SKILL_NAME = "graphify";

export type SkillAutoInstallMode = "auto" | "off" | "force";

/**
 * Resolve the auto-install policy from the environment.
 *
 * - `auto` (default, production): install only when the graphify CLI is on `PATH`.
 * - `off`: never install. The vitest setup sets this so the whole suite is
 *   hermetic regardless of whether the developer's machine happens to have
 *   graphify installed — otherwise the same test would install on one laptop and
 *   not on another, and a skill-count assertion would flake by machine.
 * - `force`: install regardless of `PATH`. Lets a test exercise the copy branch
 *   deterministically without a real binary or `PATH` surgery.
 */
export function skillAutoInstallMode(env: Record<string, string | undefined> = process.env): SkillAutoInstallMode {
  const raw = (env.ORCHESTRA_SKILL_AUTOINSTALL ?? "auto").trim().toLowerCase();
  return raw === "off" || raw === "force" ? raw : "auto";
}

/**
 * True if a `graphify` executable is discoverable on `PATH`. Pure filesystem
 * probe — scans each `PATH` entry for a file named `graphify` (plus the Windows
 * launcher extensions). No child process, no `PATH` mutation.
 */
export async function isGraphifyCliAvailable(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const pathEnv = env.PATH ?? env.Path ?? "";
  if (!pathEnv) return false;

  // Windows executability is signalled by the extension, so an extensionless
  // file named `graphify` (a README, a data file) is NOT a CLI — do not include
  // the bare name in the Windows list or any such file yields a false positive.
  const exeNames =
    process.platform === "win32"
      ? ["graphify.exe", "graphify.cmd", "graphify.bat"]
      : ["graphify"];

  const isWin = process.platform === "win32";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const exe of exeNames) {
      try {
        // `stat` (not `lstat`) so a symlink shim — how `uv tool install` and
        // most PATH installs actually place a CLI — resolves to its target.
        const stat = await fs.stat(path.join(dir, exe));
        if (!stat.isFile()) continue;
        // On POSIX a file named `graphify` that carries no execute bit is not a
        // usable CLI; on Windows the extension is the executability signal.
        if (isWin || (stat.mode & 0o111) !== 0) return true;
      } catch {
        // not in this dir; keep scanning
      }
    }
  }
  return false;
}

/** Whether a new project should receive graphify, under the resolved policy. */
export async function shouldAutoInstallGraphify(
  env: Record<string, string | undefined> = process.env
): Promise<boolean> {
  const mode = skillAutoInstallMode(env);
  if (mode === "off") return false;
  if (mode === "force") return true;
  return isGraphifyCliAvailable(env);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export type GraphifyAutoInstallResult =
  | "installed"
  | "skipped-present"
  | "skipped-unavailable"
  | "failed";

/**
 * Best-effort: copy the bundled graphify skill into `targetSkillsDir/graphify`
 * when the policy says so and it is not already there. NEVER throws — a failed
 * skill install must not fail project creation, so the caller can ignore the
 * result or log it. Returns which branch was taken for observability/tests.
 *
 * ATOMIC, so a crash mid-copy cannot leave a half-populated `graphify/` that a
 * later run mistakes for a complete install and skips forever: the copy lands
 * in a unique staging dir, its `SKILL.md` is verified, and only then is it
 * `rename`d into place (atomic on one filesystem). Any failure removes the
 * staging dir and returns `"failed"` with `target` untouched.
 *
 * TRUST BOUNDARY: `targetSkillsDir` is assumed already validated by the caller
 * (the only caller, `createProject`, derives it from a ProjectSchema-validated
 * id via `getProjectSkillsDir`). This leaf module intentionally does not know
 * the data root, so it does not re-run `assertPathInside` — do not call it with
 * an unvalidated, user-supplied path.
 */
export async function autoInstallGraphifyIfAvailable(
  targetSkillsDir: string,
  env: Record<string, string | undefined> = process.env
): Promise<GraphifyAutoInstallResult> {
  try {
    if (!(await shouldAutoInstallGraphify(env))) return "skipped-unavailable";

    const target = path.join(targetSkillsDir, GRAPHIFY_SKILL_NAME);
    // Never clobber a copy the operator (or a prior install) already placed.
    if (await pathExists(target)) return "skipped-present";

    await fs.mkdir(targetSkillsDir, { recursive: true });
    const staging = path.join(
      targetSkillsDir,
      `.${GRAPHIFY_SKILL_NAME}.installing-${process.pid}-${Date.now()}`
    );
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    try {
      await fs.cp(GRAPHIFY_BUNDLED_DIR, staging, { recursive: true, force: false });
      // Prove the copy is complete before it is published into place — a source
      // that was missing or a truncated copy must not become a "present" skill.
      await fs.access(path.join(staging, "SKILL.md"));
      await fs.rename(staging, target);
      return "installed";
    } catch {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      // A concurrent create may have landed the skill between our checks.
      if (await pathExists(target)) return "skipped-present";
      return "failed";
    }
  } catch {
    return "failed";
  }
}
