#!/usr/bin/env node
/**
 * MoA swarm-vs-single A/B runner (Track B pilot).
 * For each prompt x arm: POST /api/chat {background:true, swarmEnabled} with a
 * client-supplied chatId, then poll GET /api/chat/history?id= until the
 * assistant message lands (plus a stability re-check). Records answer text,
 * wall latency, message-timestamp latency, and cumulativeUsage.
 * Sequential on purpose: the agent semaphore has 2 permits and we want clean
 * per-run latency numbers.
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const BASE = process.env.AB_BASE_URL || "http://localhost:3001";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_TIMEOUT_MS = 300_000;
const POLL_MS = 3_000;
const STABILITY_MS = 5_000;

const prompts = JSON.parse(await fs.readFile(path.join(HERE, "prompts.json"), "utf-8"));
const arms = [
  { name: "single", swarmEnabled: false },
  { name: "swarm", swarmEnabled: true },
];

function lastAssistant(chat) {
  const msgs = chat?.messages ?? [];
  // Prefer the last non-empty assistant message; fall back to the last tool
  // message — a model that ships its answer via the `response` tool (PM #61)
  // persists an EMPTY assistant turn and the answer text in the tool result.
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant" && (msgs[i].content ?? "").trim()) return msgs[i];
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "tool" && (msgs[i].content ?? "").trim().length > 100) return msgs[i];
  }
  return null;
}

function extractText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

// Error stubs the daemon persists as assistant messages are NOT answers.
function isErrorStub(text) {
  return /^\*\*\[Background Daemon Error\]|^\*\*\[Agent Error\]|Provider returned error/.test(
    text.trim()
  );
}

async function getChat(chatId) {
  const res = await fetch(`${BASE}/api/chat/history?id=${chatId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`history ${res.status}`);
  return res.json();
}

async function runOne(prompt, arm) {
  const chatId = `ab-${prompt.id}-${arm.name}-${Date.now().toString(36)}`;
  const started = Date.now();

  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chatId,
      message: prompt.prompt,
      background: true,
      swarmEnabled: arm.swarmEnabled,
    }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/chat ${res.status}: ${await res.text()}`);
  }
  const { traceId } = await res.json();

  let answer = "";
  let chat = null;
  let settledAt = 0;
  while (Date.now() - started < RUN_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    chat = await getChat(chatId);
    const text = extractText(lastAssistant(chat));
    if (text && isErrorStub(text)) {
      return {
        promptId: prompt.id,
        category: prompt.category,
        arm: arm.name,
        chatId,
        traceId,
        ok: false,
        error: `daemon error stub: ${text.slice(0, 120)}`,
        wallMs: Date.now() - started,
      };
    }
    if (text && text.trim().length > 0) {
      // stability re-check: make sure a continuation isn't still appending
      await new Promise((r) => setTimeout(r, STABILITY_MS));
      const again = await getChat(chatId);
      const text2 = extractText(lastAssistant(again));
      if (text2 === text && (again?.messages?.length ?? 0) === (chat?.messages?.length ?? 0)) {
        chat = again;
        answer = text2;
        settledAt = Date.now();
        break;
      }
    }
  }

  if (!answer) {
    return {
      promptId: prompt.id,
      category: prompt.category,
      arm: arm.name,
      chatId,
      traceId,
      ok: false,
      error: "timeout or empty answer",
      wallMs: Date.now() - started,
    };
  }

  const msgs = chat.messages ?? [];
  const userMsg = msgs.find((m) => m.role === "user");
  const asstMsg = lastAssistant(chat);
  const tsLatencyMs =
    userMsg?.createdAt && asstMsg?.createdAt
      ? new Date(asstMsg.createdAt) - new Date(userMsg.createdAt)
      : null;

  return {
    promptId: prompt.id,
    category: prompt.category,
    arm: arm.name,
    chatId,
    traceId,
    ok: true,
    answer,
    answerChars: answer.length,
    wallMs: settledAt - started,
    tsLatencyMs,
    usage: chat.cumulativeUsage ?? null,
    messageCount: msgs.length,
  };
}

let results = [];
try {
  results = JSON.parse(await fs.readFile(path.join(HERE, "results.json"), "utf-8"));
} catch {
  // fresh start
}

for (const prompt of prompts) {
  for (const arm of arms) {
    const done = results.find(
      (r) => r.promptId === prompt.id && r.arm === arm.name && r.ok
    );
    if (done) {
      console.log(`→ ${prompt.id} / ${arm.name} … already done, skipping`);
      continue;
    }
    process.stdout.write(`→ ${prompt.id} / ${arm.name} … `);
    try {
      const r = await runOne(prompt, arm);
      results.push(r);
      console.log(
        r.ok
          ? `ok ${Math.round(r.wallMs / 1000)}s, ${r.answerChars} chars, $${r.usage?.costUsd?.toFixed?.(4) ?? "?"}, ${r.usage?.totalTokens ?? "?"} tok`
          : `FAIL: ${r.error}`
      );
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      results.push({ promptId: prompt.id, arm: arm.name, ok: false, error: err.message });
    }
    await fs.writeFile(path.join(HERE, "results.json"), JSON.stringify(results, null, 2));
  }
}
console.log(`\nDone. ${results.filter((r) => r.ok).length}/${results.length} runs ok → results.json`);
