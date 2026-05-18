import { createChat, getChat, updateChat } from "../src/lib/storage/chat-store";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

async function main() {
  console.log("Starting Storage Stress Test...");
  const chatId = "stress-test-" + Date.now();
  
  // 1. Create a dummy chat
  await createChat(chatId, "Stress Test Chat", "none");
  
  // 2. Spawn 100 concurrent requests trying to append a message to this chat
  const CONCURRENT_REQUESTS = 100;
  console.log(`Spawning ${CONCURRENT_REQUESTS} concurrent writes...`);
  
  const promises = [];
  for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
    promises.push(
      updateChat(chatId, (chat) => {
        chat.messages.push({
          id: crypto.randomUUID(),
          role: "user",
          content: `Concurrent Message ${i}`,
          createdAt: new Date().toISOString()
        });
        return chat;
      })
    );
  }
  
  await Promise.all(promises);
  
  // 3. Verify
  const chat = await getChat(chatId);
  const totalMessages = chat?.messages.length || 0;
  
  console.log(`Expected messages: ${CONCURRENT_REQUESTS}`);
  console.log(`Actual messages: ${totalMessages}`);
  
  if (totalMessages === CONCURRENT_REQUESTS) {
    console.log("✅ STRESS TEST PASSED: No race conditions detected. All writes were perfectly serialized.");
  } else {
    console.error("❌ STRESS TEST FAILED: Data race condition occurred. Some messages were overwritten.");
  }
  
  // Cleanup
  const chatPath = path.join(process.cwd(), "data", "chats", `${chatId}.json`);
  await fs.unlink(chatPath).catch(() => {});
}

main().catch(console.error);
