#!/usr/bin/env node
/**
 * Drive CURRENT Orchestra on a REAL project task, long-horizon, and log
 * everything needed to assess agent behaviour — the same signals used to read
 * the old telegram build: tool calls, exit codes, loop-guard / streak-breaker
 * hits, printed-tool-call markup (PM #81), swarm traces, and whether the final
 * turn was an honest pause vs a false "done".
 *
 * This mirrors the canonical POST /api/chat invocation (projectId + swarm +
 * forceSwarm) so it exercises the production path, and presses "continue" like
 * a real operator across N turns.
 *
 * Usage: npx tsx scripts/run-real-task.ts <projectId> <turns> "<task>"
 * Env:   ORCHESTRA_EVAL_CAPTURE_SWARM=true captures per-draft swarm telemetry.
 */
import fsSync from "fs";
import path from "path";
// Type-only: erased at compile time, so it does NOT pull the module graph in
// before `loadEnvLocal()` runs (the reason everything else is imported lazily
// inside `main`).
import type { ChatMessage } from "@/lib/types";

function loadEnvLocal(): void {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fsSync.existsSync(envPath)) return;
  const snapshot = { ...process.env };
  (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(envPath);
  for (const k of Object.keys(snapshot)) {
    if (snapshot[k] !== undefined) process.env[k] = snapshot[k]!;
  }
}

const projectId = process.argv[2];
const turns = Number(process.argv[3] ?? 1);
const task = process.argv[4];
if (!projectId || !task) {
  console.error('usage: npx tsx scripts/run-real-task.ts <projectId> <turns> "<task>"');
  process.exit(2);
}

function summarizeTurn(messages: ChatMessage[], sinceIndex: number): void {
  const slice = messages.slice(sinceIndex);
  const tools: Record<string, number> = {};
  const exitCodes: number[] = [];
  let printedMarkup = 0;
  let loopGuard = 0;
  let streak = 0;
  for (const m of slice) {
    if (m.role === "tool" || m.toolName) {
      const t = m.toolName || "?";
      tools[t] = (tools[t] || 0) + 1;
      const mm = m.content.match(/Exit code:\s*(\d+)/);
      if (mm) exitCodes.push(Number(mm[1]));
    }
    if (/<tool_call>|<function=|<｜tool▁call|\{"call":"/.test(m.content)) printedMarkup++;
    if (/loop guard|Loop guard|\[Loop/i.test(m.content)) loopGuard++;
    if (/streak|read.*verify.*ask|refus/i.test(m.content)) streak++;
  }
  console.log(`\n  ── turn summary ──`);
  console.log(`  new messages: ${slice.length}`);
  console.log(`  tool calls: ${JSON.stringify(tools)}`);
  console.log(`  code_execution exit codes: [${exitCodes.join(", ")}]`);
  console.log(`  printed-markup(PM#81): ${printedMarkup} | loop-guard hits: ${loopGuard} | streak/verify-ask: ${streak}`);
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { refreshOpenRouterPricingCache } = await import("../src/lib/cost/openrouter-pricing");
  await refreshOpenRouterPricingCache().catch(() => null);

  const { runAgent } = await import("@/lib/agent/agent");
  const { createChat, getChat, flushAllPendingChats } = await import("@/lib/storage/chat-store");
  const { takeEvalSwarmTelemetry } = await import("@/lib/agent/eval-arms");
  const crypto = await import("node:crypto");

  // RESUME_CHAT=<id> continues an existing (e.g. step-limit-paused) chat instead
  // of starting fresh — this is how the PM #82 resume-after-pause path is tested.
  const resumeChat = process.env.RESUME_CHAT;
  let chatId: string;
  if (resumeChat) {
    const existing = await getChat(resumeChat);
    if (!existing) throw new Error(`RESUME_CHAT ${resumeChat} not found`);
    chatId = resumeChat;
    console.log(`RESUMING chat: ${chatId} | project: ${projectId} | turns: ${turns} | prior messages: ${existing.messages.length}`);
  } else {
    chatId = `realrun-${projectId}-${crypto.randomUUID().slice(0, 8)}`;
    await createChat(chatId, `[real-run] ${projectId}`, projectId);
    console.log(`chat: ${chatId} | project: ${projectId} | turns: ${turns}`);
  }

  let lastMsgCount = resumeChat ? (await getChat(chatId))!.messages.length : 0;
  for (let turn = 1; turn <= turns; turn++) {
    const userMessage = turn === 1 ? task : "continue";
    console.log(`\n${"=".repeat(70)}\n=== TURN ${turn}/${turns} — ${JSON.stringify(userMessage.slice(0, 60))} ===\n${"=".repeat(70)}`);
    const t0 = Date.now();
    let ttft: number | undefined;
    try {
      // ORCHESTRA_TASK_SWARM=off runs the single-agent path; default is swarm.
      const swarmOn = process.env.ORCHESTRA_TASK_SWARM !== "off";
      const result = await runAgent({
        chatId,
        userMessage,
        projectId,
        swarmEnabled: swarmOn,
        forceSwarm: swarmOn,
      });
      const response = result.toUIMessageStreamResponse({});
      if (response.body) {
        const reader = response.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ttft === undefined && value) {
            const chunk = dec.decode(value, { stream: true });
            if (chunk.includes("text-delta") || chunk.includes('"type":"text"')) ttft = Date.now() - t0;
          }
        }
      }
      await flushAllPendingChats();
    } catch (err) {
      console.error(`  TURN ${turn} THREW:`, err instanceof Error ? err.message : err);
    }

    const swarm = takeEvalSwarmTelemetry(chatId);
    if (swarm) {
      const models = new Set(swarm.drafts.map((d) => `${d.provider}/${d.model}`));
      console.log(
        `  swarm: ${swarm.drafts.length} drafts, ${models.size} distinct models, ` +
          `disagreement ${swarm.disagreement.maxDistance.toFixed(3)} (${swarm.disagreement.detected ? "DETECTED" : "consensus"})`
      );
    }
    const chat = await getChat(chatId);
    if (chat) {
      summarizeTurn(chat.messages, lastMsgCount);
      console.log(`  turn wall clock: ${((Date.now() - t0) / 1000).toFixed(1)}s${ttft ? `, TTFT ${(ttft / 1000).toFixed(1)}s` : ""}`);
      lastMsgCount = chat.messages.length;
    }
  }

  console.log(`\n${"=".repeat(70)}\nDONE — chat ${chatId}\n${"=".repeat(70)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
