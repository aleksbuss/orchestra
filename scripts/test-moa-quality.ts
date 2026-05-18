import crypto from "crypto";
import { runAgent } from "../src/lib/agent/agent";
import { getSettings } from "../src/lib/storage/settings-store";

async function runQualityTest() {
  console.log("🧪 Starting Quality Assurance Test: Single Agent vs MoA (Team of Experts)");
  
  const settings = await getSettings();
  console.log(`🧠 Brain Model (Aggregator/Single): ${settings.chatModel.provider}/${settings.chatModel.model}`);
  console.log(`👷 Worker Models (Proposers): ${settings.utilityModel.provider}/${settings.utilityModel.model}\n`);

  const complexPrompt = `
  Design a high-level architecture for a real-time multiplayer chess game backend in Node.js.
  Requirements:
  1. Websocket connections for real-time moves.
  2. How to handle connection drops and state recovery.
  3. Prevent race conditions if two players move at the exact same millisecond.
  `;

  console.log("📝 Test Prompt:");
  console.log(complexPrompt);
  console.log("--------------------------------------------------\n");

  // 1. Test Single Agent
  console.log("🏃‍♂️ RUN 1: Single Agent (Team of Experts DISABLED)");
  const singleChatId = crypto.randomUUID();
  const startSingle = Date.now();
  
  try {
    const singleResult = await runAgent({
      chatId: singleChatId,
      userMessage: complexPrompt,
      swarmEnabled: false,
      isBackground: true,
    });
    
    // runAgent returns a stream or string depending on isBackground. 
    // In our backend it usually returns an object with `text` promise.
    const singleText = await singleResult.text;
    const singleTime = Date.now() - startSingle;
    
    console.log(`✅ Single Agent completed in ${singleTime}ms`);
    console.log(`📏 Length: ${singleText.length} characters\n`);
    
  } catch (err) {
    console.error("❌ Single Agent failed:", err);
  }

  // 2. Test MoA Swarm
  console.log("🐝 RUN 2: Mixture of Agents (Team of Experts ENABLED)");
  const swarmChatId = crypto.randomUUID();
  const startSwarm = Date.now();
  
  try {
    const swarmResult = await runAgent({
      chatId: swarmChatId,
      userMessage: complexPrompt,
      swarmEnabled: true,
      isBackground: true,
    });
    
    const swarmText = await swarmResult.text;
    const swarmTime = Date.now() - startSwarm;
    
    console.log(`✅ Swarm completed in ${swarmTime}ms`);
    console.log(`📏 Length: ${swarmText.length} characters\n`);
    
  } catch (err) {
    console.error("❌ Swarm failed:", err);
  }
}

runQualityTest().catch(console.error);
