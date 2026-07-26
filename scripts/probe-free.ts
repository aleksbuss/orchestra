#!/usr/bin/env node
/** Availability probe for candidate FREE models (replace dead gemma). Run: OPENROUTER_API_KEY=... npx tsx scripts/probe-free.ts */
import { generateText } from "ai";
import { createModel } from "@/lib/providers/llm-provider";

const CANDIDATES = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "cohere/north-mini-code:free",
  "poolside/laguna-m.1:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openai/gpt-oss-20b:free",
  "inclusionai/ling-3.0-flash:free",
];

async function main() {
  for (const model of CANDIDATES) {
    const start = Date.now();
    try {
      const { text } = await generateText({
        model: createModel({ provider: "openrouter", model }),
        temperature: 0, prompt: "What is 17*23? On the last line output 'FINAL ANSWER: X'.",
        maxOutputTokens: 500, abortSignal: AbortSignal.timeout(60_000),
      });
      const t = (text ?? "").trim();
      const ok = /391/.test(t);
      console.log(`${ok ? "✓" : "?"} ${model}  (${Date.now() - start}ms, ${t.length} chars)${t.length ? "" : "  EMPTY"}`);
    } catch (err) {
      console.log(`✗ ${model}  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
