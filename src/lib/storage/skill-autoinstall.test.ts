/**
 * Regression coverage for binary-gated graphify auto-install (A+ / graphify ADR).
 *
 * This file does NOT spy `process.cwd()`, so `GRAPHIFY_BUNDLED_DIR` inside the
 * module resolves to the REAL `bundled-skills/graphify` in this repo — the copy
 * branch therefore installs the actual shipped skill, not a fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  skillAutoInstallMode,
  isGraphifyCliAvailable,
  shouldAutoInstallGraphify,
  autoInstallGraphifyIfAvailable,
} from "./skill-autoinstall";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-skillauto-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Put an executable file named `graphify` into a fresh dir and return the dir. */
async function makeBinDirWithGraphify(): Promise<string> {
  const binDir = path.join(tmp, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const p = path.join(binDir, "graphify");
  await fs.writeFile(p, "#!/bin/sh\necho graphify\n");
  await fs.chmod(p, 0o755);
  return binDir;
}

describe("skillAutoInstallMode", () => {
  it("defaults to auto when unset", () => {
    expect(skillAutoInstallMode({})).toBe("auto");
  });
  it("reads off/force case-insensitively", () => {
    expect(skillAutoInstallMode({ ORCHESTRA_SKILL_AUTOINSTALL: "OFF" })).toBe("off");
    expect(skillAutoInstallMode({ ORCHESTRA_SKILL_AUTOINSTALL: "Force" })).toBe("force");
  });
  it("falls back to auto on an unrecognised value", () => {
    expect(skillAutoInstallMode({ ORCHESTRA_SKILL_AUTOINSTALL: "banana" })).toBe("auto");
  });
});

describe("isGraphifyCliAvailable", () => {
  it("true when an executable graphify is on PATH", async () => {
    const binDir = await makeBinDirWithGraphify();
    expect(await isGraphifyCliAvailable({ PATH: binDir })).toBe(true);
  });

  it("false for an empty or absent PATH", async () => {
    expect(await isGraphifyCliAvailable({ PATH: "" })).toBe(false);
    expect(await isGraphifyCliAvailable({})).toBe(false);
  });

  it("false when PATH has no graphify", async () => {
    const emptyBin = path.join(tmp, "empty");
    await fs.mkdir(emptyBin, { recursive: true });
    expect(await isGraphifyCliAvailable({ PATH: emptyBin })).toBe(false);
  });

  it("false for a non-executable file named graphify (POSIX)", async () => {
    // On Windows the exec bit is meaningless, so this expectation is POSIX-only.
    if (process.platform === "win32") return;
    const binDir = path.join(tmp, "noexec");
    await fs.mkdir(binDir, { recursive: true });
    const p = path.join(binDir, "graphify");
    await fs.writeFile(p, "not executable");
    await fs.chmod(p, 0o644);
    expect(await isGraphifyCliAvailable({ PATH: binDir })).toBe(false);
  });
});

describe("shouldAutoInstallGraphify", () => {
  it("off wins even when the CLI is present", async () => {
    const binDir = await makeBinDirWithGraphify();
    expect(
      await shouldAutoInstallGraphify({ ORCHESTRA_SKILL_AUTOINSTALL: "off", PATH: binDir })
    ).toBe(false);
  });
  it("force installs even with no CLI on PATH", async () => {
    expect(
      await shouldAutoInstallGraphify({ ORCHESTRA_SKILL_AUTOINSTALL: "force", PATH: "" })
    ).toBe(true);
  });
  it("auto follows PATH presence", async () => {
    const binDir = await makeBinDirWithGraphify();
    expect(await shouldAutoInstallGraphify({ PATH: binDir })).toBe(true);
    expect(await shouldAutoInstallGraphify({ PATH: path.join(tmp, "nope") })).toBe(false);
  });
});

describe("autoInstallGraphifyIfAvailable", () => {
  it("installs the real bundled skill when forced", async () => {
    const skillsDir = path.join(tmp, "skills");
    const result = await autoInstallGraphifyIfAvailable(skillsDir, {
      ORCHESTRA_SKILL_AUTOINSTALL: "force",
    });
    expect(result).toBe("installed");
    const skillFile = path.join(skillsDir, "graphify", "SKILL.md");
    const body = await fs.readFile(skillFile, "utf-8");
    // Assert the frontmatter identity only — coupling a storage test to exact
    // prompt copy makes an editorial tweak break an unrelated unit test.
    expect(body).toContain("name: graphify");
    // Atomic install leaves no staging dir behind.
    const leftovers = (await fs.readdir(skillsDir)).filter((n) =>
      n.startsWith(".graphify.installing-")
    );
    expect(leftovers).toEqual([]);
  });

  it("skips (unavailable) when policy is off", async () => {
    const skillsDir = path.join(tmp, "skills");
    const result = await autoInstallGraphifyIfAvailable(skillsDir, {
      ORCHESTRA_SKILL_AUTOINSTALL: "off",
    });
    expect(result).toBe("skipped-unavailable");
    await expect(fs.stat(path.join(skillsDir, "graphify"))).rejects.toThrow();
  });

  it("does not clobber an already-present skill", async () => {
    const skillsDir = path.join(tmp, "skills");
    const existing = path.join(skillsDir, "graphify");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "SKILL.md"), "operator's own copy");

    const result = await autoInstallGraphifyIfAvailable(skillsDir, {
      ORCHESTRA_SKILL_AUTOINSTALL: "force",
    });
    expect(result).toBe("skipped-present");
    // untouched
    expect(await fs.readFile(path.join(existing, "SKILL.md"), "utf-8")).toBe(
      "operator's own copy"
    );
  });
});
