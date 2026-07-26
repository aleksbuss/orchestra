#!/usr/bin/env node
/**
 * MECHANISM replay (NOT a statistical probe) of the two discordant MoA cases
 * h03 (averaging-synth DRAG) and h10 (rescue). Runs the operator's real 3-role
 * pipeline — proposers (subagents) -> skeptic -> orchestrator/synthesizer — on
 * each case with NO token starvation, and DUMPS every raw output so we can READ
 * what the synthesizer actually did (does it follow a wrong majority?).
 *
 * This answers the "fixable orchestration flaw vs dead idea" question by
 * inspection, not by an underpowered N. It does NOT claim statistical proof.
 *
 * Run: OPENROUTER_API_KEY=... npx tsx scripts/moa-replay.ts
 */
import fs from "fs/promises";
import path from "path";
import { generateText } from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import type { ModelConfig } from "@/lib/types";

// The three SELECTABLE roles (operator's real config shape).
const BRAIN: ModelConfig = { provider: "openrouter", model: "deepseek/deepseek-v4-flash" }; // orchestrator/synthesizer
const PROPOSERS: ModelConfig[] = [
  { provider: "openrouter", model: "deepseek/deepseek-chat" },
  { provider: "openrouter", model: "openai/gpt-4o-mini" },
  { provider: "openrouter", model: "anthropic/claude-3.5-haiku" },
];
const SKEPTIC: ModelConfig = { provider: "openrouter", model: "moonshotai/kimi-k2" }; // separate skeptic role

const REPLAY_IDS = new Set(["h03", "h10"]);

interface Case { id: string; q: string; answer: string; accept?: string[] }
const ANSWER_RE = /FINAL ANSWER:\s*([^\n]+)/gi;

function extract(text: string): string {
  const matches = [...text.matchAll(ANSWER_RE)];
  const raw = matches.length ? matches[matches.length - 1][1] : "";
  return norm(raw);
}
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/\b(cents?|dollars?|degrees?|miles?|minutes?|days?|times?|ways?|hands?)\b/g, "")
    .replace(/[^a-z0-9/.]/g, "")
    .replace(/\.$/, "")
    .trim();
}
function correct(extracted: string, c: Case): boolean {
  const targets = [c.answer, ...(c.accept ?? [])].map(norm);
  return targets.includes(extracted);
}

async function ask(model: ModelConfig, system: string, prompt: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: createModel(model),
      temperature: 0,
      system,
      prompt,
      maxOutputTokens: 4000, // generous — NO token starvation (DoubleTake point A)
      abortSignal: AbortSignal.timeout(120_000),
    });
    return text ?? "";
  } catch (err) {
    return `__ERROR__ ${err instanceof Error ? err.message : String(err)}`;
  }
}

const SOLVE_SYS =
  "Solve the problem. Reason step by step. Then on the LAST line output EXACTLY " +
  "'FINAL ANSWER: X' where X is ONLY the number — no units, no extra words.";
const SKEPTIC_SYS =
  "You are a skeptical fact-checker. Given a problem and candidate answers, find errors and " +
  "state the correct answer. End with 'FINAL ANSWER: X'.";
const SYNTH_SYS =
  "You are given a problem, several experts' answers, and a skeptic's critique. Weigh them, " +
  "resolve disagreements, and give the correct answer. End with 'FINAL ANSWER: X' (only the number).";

function short(s: string, n = 600): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + " …[truncated in console; full text in JSON]" : t;
}

async function main() {
  const file = "evals/reasoning-cases-hard.json";
  const all: Case[] = JSON.parse(await fs.readFile(path.join(process.cwd(), file), "utf-8"));
  const cases = all.filter((c) => REPLAY_IDS.has(c.id));

  const dump: Record<string, unknown> = {};

  for (const c of cases) {
    console.log("\n" + "█".repeat(72));
    console.log(`CASE ${c.id}  —  expected FINAL ANSWER: ${c.answer}`);
    console.log(`Q: ${c.q}`);
    console.log("█".repeat(72));

    // Arm A: single orchestrator/brain solo.
    const singleText = await ask(BRAIN, SOLVE_SYS, c.q);
    const singleAns = extract(singleText);
    const singleOk = correct(singleAns, c);
    console.log(`\n[SINGLE brain ${BRAIN.model}] -> ${singleAns || "(none)"}  ${singleOk ? "✓" : "✗"}`);
    console.log(`  ${short(singleText)}`);

    // Subagents / proposers (independent drafts).
    const drafts: { model: string; text: string; ans: string; ok: boolean }[] = [];
    for (const p of PROPOSERS) {
      const text = await ask(p, SOLVE_SYS, c.q);
      const ans = extract(text);
      const ok = correct(ans, c);
      drafts.push({ model: p.model, text, ans, ok });
      console.log(`\n[PROPOSER ${p.model}] -> ${ans || "(none)"}  ${ok ? "✓" : "✗"}`);
      console.log(`  ${short(text)}`);
    }
    const passN = drafts.some((d) => d.ok);
    const answerCounts = new Map<string, number>();
    for (const d of drafts) if (d.ans) answerCounts.set(d.ans, (answerCounts.get(d.ans) ?? 0) + 1);
    const majority = [...answerCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    // Separate skeptic role (CONDITIONAL — sees the drafts).
    const skepticText = await ask(
      SKEPTIC,
      SKEPTIC_SYS,
      `Problem: ${c.q}\n\nCandidate answers:\n${drafts.map((d, i) => `Expert ${i + 1} (${d.model}): ${d.text}`).join("\n\n")}`
    );
    const skepticAns = extract(skepticText);
    const skepticOk = correct(skepticAns, c);
    console.log(`\n[SKEPTIC ${SKEPTIC.model}] -> ${skepticAns || "(none)"}  ${skepticOk ? "✓" : "✗"}`);
    console.log(`  ${short(skepticText)}`);

    // Orchestrator/synthesizer (the proven failure surface).
    const synthText = await ask(
      BRAIN,
      SYNTH_SYS,
      `Problem: ${c.q}\n\n${drafts.map((d, i) => `Expert ${i + 1} (${d.model}): ${d.text}`).join("\n\n")}\n\nSkeptic: ${skepticText}`
    );
    const synthAns = extract(synthText);
    const synthOk = correct(synthAns, c);
    console.log(`\n[SYNTH ${BRAIN.model}] -> ${synthAns || "(none)"}  ${synthOk ? "✓" : "✗"}`);
    console.log(`  ${short(synthText)}`);

    // Mechanism verdict.
    console.log("\n" + "─".repeat(72));
    console.log(`MECHANISM  ${c.id}:`);
    console.log(`  single=${singleOk ? "✓" : "✗"}  Pass@N(proposers)=${passN ? "✓ a right draft EXISTS" : "✗ no right draft"}  skeptic=${skepticOk ? "✓" : "✗"}  synth=${synthOk ? "✓" : "✗"}`);
    console.log(`  proposer majority: ${majority ? `${majority[0]} (${majority[1]}/${drafts.length})` : "(none)"}  | correct=${norm(c.answer)}`);
    if (passN && !synthOk) console.log(`  ⚠ DRAG CONFIRMED: a correct draft existed but the SYNTHESIZER did not select it.`);
    if (!passN && !synthOk) console.log(`  → no headroom: no source held the right answer (not a synth flaw here).`);
    if (synthOk && !singleOk) console.log(`  → RESCUE: synth beat the single brain.`);
    console.log("─".repeat(72));

    dump[c.id] = {
      q: c.q, expected: c.answer,
      single: { model: BRAIN.model, ans: singleAns, ok: singleOk, text: singleText },
      proposers: drafts,
      passN, majority: majority ? { ans: majority[0], count: majority[1] } : null,
      skeptic: { model: SKEPTIC.model, ans: skepticAns, ok: skepticOk, text: skepticText },
      synth: { model: BRAIN.model, ans: synthAns, ok: synthOk, text: synthText },
    };
  }

  const outFile = `evals/results/moa-replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await fs.mkdir("evals/results", { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(dump, null, 2));
  console.log(`\nRAW DRAFTS SAVED: ${outFile}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
