import fs from "fs/promises";
import path from "path";
import type { CronStoreFile } from "@/lib/cron/types";
import { withFileLock } from "@/lib/storage/fs-utils";

export async function withCronStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>
): Promise<T> {
  return await withFileLock(storePath, fn);
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CronStoreFile>;
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return {
      version: 1,
      jobs: jobs.filter(Boolean),
    };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw error;
  }
}

export async function saveCronStore(
  storePath: string,
  store: CronStoreFile
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tmp, storePath);
}
