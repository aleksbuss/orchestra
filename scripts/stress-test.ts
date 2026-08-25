import fs from "fs/promises";
import os from "os";
import path from "path";
import { withFileLock, safeWriteFile } from "../src/lib/storage/fs-utils";

/**
 * Scratch root for this run — an OS temp directory, NOT the data root.
 *
 * This used to be `path.join(process.cwd(), "data", "stress-test")`: a fresh
 * `process.cwd()/data` literal (the defect class non-negotiable #3 exists to
 * kill) which ignored `ORCHESTRA_DATA_DIR` and wrote 2,000 files into the
 * OPERATOR'S LIVE DATABASE every time the documented `npm run test:stress` ran.
 * The cleanup at the end then `rm -rf`'d a directory inside `data/`.
 *
 * `dataPath("stress-test")` would have satisfied the letter of the rule and
 * still written into live `data/` by default — the rule is about having ONE
 * resolver, and the honest answer here is that this script needs no data root
 * at all. It exercises `withFileLock` / `safeWriteFile`, which take absolute
 * paths and do not care where the file lives. A unique temp dir per run also
 * means two concurrent runs cannot collide.
 */
const ITERATIONS = 100;
const CONCURRENT_AGENTS = 20;

async function runTest(scratchDir: string) {
  console.log(`🚀 Starting Concurrency & Stress Test...`);
  console.log(`Agents: ${CONCURRENT_AGENTS}`);
  console.log(`Updates per agent: ${ITERATIONS}`);
  console.log(`Total expected updates: ${CONCURRENT_AGENTS * ITERATIONS}`);
  console.log(`Scratch dir: ${scratchDir}`);

  const testFile = path.join(scratchDir, "concurrent-chat.json");
  
  // Initialize file
  await safeWriteFile(testFile, JSON.stringify({ messages: [] }));

  async function agentTask(agentId: number) {
    for (let i = 0; i < ITERATIONS; i++) {
      // Simulate read-modify-write cycle using the lock
      await withFileLock(testFile, async () => {
        const raw = await fs.readFile(testFile, "utf-8");
        const data = JSON.parse(raw);
        data.messages.push(`Agent ${agentId} - msg ${i}`);
        
        // Simulating some processing time (like JSON parse/stringify delay)
        await new Promise(r => setTimeout(r, Math.random() * 2));
        
        await safeWriteFile(testFile, JSON.stringify(data));
      });
    }
  }

  const startTime = Date.now();
  
  // Launch all agents concurrently
  const promises: Promise<void>[] = [];
  for (let a = 0; a < CONCURRENT_AGENTS; a++) {
    promises.push(agentTask(a));
  }
  
  await Promise.all(promises);
  
  const duration = Date.now() - startTime;
  
  // Verify results
  const rawFinal = await fs.readFile(testFile, "utf-8");
  const finalData = JSON.parse(rawFinal);
  
  console.log(`\n✅ Test Completed in ${duration}ms`);
  console.log(`Messages saved: ${finalData.messages.length}`);
  
  if (finalData.messages.length === CONCURRENT_AGENTS * ITERATIONS) {
    console.log(`🟢 SUCCESS: No race conditions detected! Data integrity maintained.`);
    return true;
  }
  console.error(`🔴 FAILURE: Data corruption/loss detected. Expected ${CONCURRENT_AGENTS * ITERATIONS}, got ${finalData.messages.length}`);
  return false;
}

async function main() {
  // `mkdtemp` gives a unique dir, so concurrent runs cannot fight over it.
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-stress-"));
  try {
    const ok = await runTest(scratchDir);
    // A stress test that detects corruption and still exits 0 is not a gate —
    // `npm run test:stress` used to print 🔴 FAILURE and report success, and a
    // thrown error was swallowed by `.catch(console.error)` with the same
    // result. Both paths now set a non-zero exit code.
    if (!ok) process.exitCode = 1;
  } finally {
    // `finally`, so a crash mid-run still removes the scratch dir instead of
    // leaving an orphan behind.
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
