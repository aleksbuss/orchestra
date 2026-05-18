import fs from "fs/promises";
import path from "path";
import { withFileLock, safeWriteFile } from "@/lib/storage/fs-utils";
import type { AgentJobPayload } from "@/lib/agent/daemon";

const DATA_DIR = path.join(process.cwd(), "data");
const QUEUE_DIR = path.join(DATA_DIR, "queue");

async function ensureDir() {
  await fs.mkdir(QUEUE_DIR, { recursive: true });
}

/**
 * Persists a background job to the queue directory.
 * If a job for the same chatId already exists, it will be overwritten.
 */
export async function enqueueJob(payload: AgentJobPayload): Promise<void> {
  await ensureDir();
  const filePath = path.join(QUEUE_DIR, `${payload.chatId}.json`);
  await withFileLock(filePath, async () => {
    await safeWriteFile(filePath, JSON.stringify(payload, null, 2));
  });
}

/**
 * Removes a job from the queue directory after it finishes (success or fail).
 */
export async function dequeueJob(chatId: string): Promise<void> {
  const filePath = path.join(QUEUE_DIR, `${chatId}.json`);
  try {
    await withFileLock(filePath, async () => {
      await fs.unlink(filePath);
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[queue-store] Failed to dequeue job ${chatId}:`, (err as Error).message);
    }
  }
}

/**
 * Retrieves all pending jobs from the queue directory on server boot.
 */
export async function getPendingJobs(): Promise<AgentJobPayload[]> {
  await ensureDir();
  const files = await fs.readdir(QUEUE_DIR);
  const jobs: AgentJobPayload[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await fs.readFile(path.join(QUEUE_DIR, file), "utf-8");
      jobs.push(JSON.parse(content));
    } catch {
      console.warn(`[queue-store] Failed to read pending job: ${file}`);
    }
  }

  return jobs;
}
