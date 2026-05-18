import fs from "fs/promises";
import path from "path";
import { withFileLock, safeWriteFile } from "../src/lib/storage/fs-utils";

const DATA_DIR = path.join(process.cwd(), "data", "stress-test");
const ITERATIONS = 100;
const CONCURRENT_AGENTS = 20;

async function runTest() {
  console.log(`🚀 Starting Concurrency & Stress Test...`);
  console.log(`Agents: ${CONCURRENT_AGENTS}`);
  console.log(`Updates per agent: ${ITERATIONS}`);
  console.log(`Total expected updates: ${CONCURRENT_AGENTS * ITERATIONS}`);
  
  await fs.mkdir(DATA_DIR, { recursive: true });
  
  const testFile = path.join(DATA_DIR, "concurrent-chat.json");
  
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
  } else {
    console.error(`🔴 FAILURE: Data corruption/loss detected. Expected ${CONCURRENT_AGENTS * ITERATIONS}, got ${finalData.messages.length}`);
  }

  // Clean up
  await fs.rm(DATA_DIR, { recursive: true, force: true });
}

runTest().catch(console.error);
