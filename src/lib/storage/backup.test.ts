import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  createDataBackup,
  pruneBackups,
  listBackups,
  shouldRunBootBackup,
  getBackupStatus,
} from "./backup";

let dataDir: string;
let backupDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function seedDataDir() {
  await fs.mkdir(path.join(dataDir, "chats"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "chats", "c1.json"), '{"id":"c1"}');
  await fs.mkdir(path.join(dataDir, "settings"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "settings", "settings.json"), "{}");
  // Ephemeral / regenerable — must be EXCLUDED from backups.
  await fs.mkdir(path.join(dataDir, "npm-cache"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "npm-cache", "junk"), "x");
  await fs.mkdir(path.join(dataDir, "tmp"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "tmp", "scratch"), "x");
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "orch-backup-"));
  dataDir = path.join(base, "data");
  backupDir = path.join(base, "data-backups");
  await fs.mkdir(dataDir, { recursive: true });
  setEnv("ORCHESTRA_DATA_DIR", dataDir);
  setEnv("ORCHESTRA_BACKUP_DIR", backupDir);
  setEnv("ORCHESTRA_BACKUP_DISABLED", undefined);
  setEnv("ORCHESTRA_BACKUP_RETENTION", undefined);
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  await fs.rm(path.dirname(dataDir), { recursive: true, force: true }).catch(() => {});
});

describe("createDataBackup", () => {
  it("copies user data, EXCLUDES regenerable dirs (npm-cache, tmp), and reports the path", async () => {
    await seedDataDir();
    const res = await createDataBackup();
    expect(res).not.toBeNull();

    // User data present.
    expect(await exists(path.join(res!.path, "chats", "c1.json"))).toBe(true);
    expect(await exists(path.join(res!.path, "settings", "settings.json"))).toBe(true);
    // Ephemeral excluded.
    expect(await exists(path.join(res!.path, "npm-cache"))).toBe(false);
    expect(await exists(path.join(res!.path, "tmp"))).toBe(false);
    // Lives OUTSIDE data/ (survives a data/ wipe).
    expect(res!.path.startsWith(backupDir)).toBe(true);
  });

  it("returns null when backups are disabled (opt-out)", async () => {
    await seedDataDir();
    setEnv("ORCHESTRA_BACKUP_DISABLED", "true");
    const res = await createDataBackup();
    expect(res).toBeNull();
    expect(await exists(backupDir)).toBe(false);
  });

  it("returns null when there is no data dir yet (fresh install)", async () => {
    setEnv("ORCHESTRA_DATA_DIR", path.join(os.tmpdir(), "orch-does-not-exist-xyz"));
    const res = await createDataBackup();
    expect(res).toBeNull();
  });

  it("publishes atomically — no leftover .tmp- partial after success", async () => {
    await seedDataDir();
    await createDataBackup();
    const entries = await fs.readdir(backupDir);
    expect(entries.some((e) => e.startsWith(".tmp-"))).toBe(false);
    expect(entries.filter((e) => e.startsWith("data-"))).toHaveLength(1);
  });
});

describe("rotation (FIFO retention)", () => {
  it("keeps only the N newest backups", async () => {
    await seedDataDir();
    setEnv("ORCHESTRA_BACKUP_RETENTION", "3");
    const t0 = 1_700_000_000_000;
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await createDataBackup({ now: new Date(t0 + i * 60_000) }); // 1 min apart
      created.push(path.basename(r!.path));
    }
    const kept = (await listBackups()).map((b) => b.name);
    expect(kept).toHaveLength(3);
    // The 3 newest (i=2,3,4) survive, newest-first; the 2 oldest evicted.
    expect(kept).toEqual([created[4], created[3], created[2]]);
    expect(kept).not.toContain(created[0]);
    expect(kept).not.toContain(created[1]);
  });
});

describe("shouldRunBootBackup (audit fix #1 — boot-dedup)", () => {
  const INTERVAL = 24 * 60 * 60 * 1000;
  it("runs when there is no backup yet", () => {
    expect(shouldRunBootBackup(null, INTERVAL)).toBe(true);
  });
  it("SKIPS when the newest backup is younger than half the interval", () => {
    expect(shouldRunBootBackup(INTERVAL / 4, INTERVAL)).toBe(false); // 6h old, < 12h
  });
  it("runs when the newest backup is older than half the interval", () => {
    expect(shouldRunBootBackup(INTERVAL / 2, INTERVAL)).toBe(true);
    expect(shouldRunBootBackup(INTERVAL * 3, INTERVAL)).toBe(true);
  });
});

describe("getBackupStatus (audit fix #2 — observability)", () => {
  it("reports disabled when opted out", async () => {
    setEnv("ORCHESTRA_BACKUP_DISABLED", "true");
    const s = await getBackupStatus();
    expect(s.disabled).toBe(true);
    expect(s.count).toBe(0);
    expect(s.newestAgeMs).toBeNull();
  });

  it("reports no backups (null age) before any run", async () => {
    const s = await getBackupStatus();
    expect(s.disabled).toBe(false);
    expect(s.count).toBe(0);
    expect(s.newestAgeMs).toBeNull();
    expect(s.staleThresholdMs).toBeGreaterThan(0);
  });

  it("reports count + a recent age after a backup", async () => {
    await seedDataDir();
    await createDataBackup();
    const s = await getBackupStatus();
    expect(s.count).toBe(1);
    expect(s.newestAgeMs).not.toBeNull();
    expect(s.newestAgeMs!).toBeLessThan(60_000); // just created
  });
});

describe("pruneBackups", () => {
  it("sweeps crash-leaked .tmp- partials", async () => {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(path.join(backupDir, ".tmp-crashed-123"), { recursive: true });
    await fs.mkdir(path.join(backupDir, "data-2026-01-01T00-00-00-000Z"), { recursive: true });
    await pruneBackups();
    const entries = await fs.readdir(backupDir);
    expect(entries.some((e) => e.startsWith(".tmp-"))).toBe(false);
    expect(entries).toContain("data-2026-01-01T00-00-00-000Z"); // real backup kept
  });

  it("is a no-op (no throw) when the backup root doesn't exist", async () => {
    await expect(pruneBackups()).resolves.toEqual({ kept: 0, removed: 0 });
  });
});
