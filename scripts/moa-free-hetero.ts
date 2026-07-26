#!/usr/bin/env node
/**
 * FREE heterogeneous-swarm test — the "weak+heterogeneous" cell, never tested,
 * built with DoubleTake's valid corrections folded in:
 *   - CROSS-VENDOR roles (no shared vendor between orchestrator and any proposer
 *     -> avoids self-preference bias). 5 distinct vendors.
 *   - SINGLE baseline = the ORCHESTRATOR model solo (arm A) -> measures swarm
 *     OVERHEAD, not "two different models" (DoubleTake C).
 *   - EMPTY = 0 (a non-delivered answer is scored WRONG, not skipped -> no
 *     survivor bias, DoubleTake D). Delivery-rate reported SEPARATELY per arm.
 *   - Sequential + PACED + retry-with-backoff on empty/429 (free-tier throttle,
 *     DoubleTake B) — but bounded (no infinite retry -> no ban).
 *
 * HONEST SCOPE: exact-match MATH tests SELECTION (is a right draft present + does
 * the orchestrator pick it), NOT multi-constraint SYNTHESIS (a swarm's real value,
 * DoubleTake E). This is a directional/plumbing read on FREE models, NOT a
 * decision-grade result. $0 (no judge — programmatic scoring).
 *
 * Run: OPENROUTER_API_KEY=... npx tsx scripts/moa-free-hetero.ts [--file evals/reasoning-cases-hard.json] [--n 16]
 */
import fs from "fs/promises";
import path from "path";
import { generateText } from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import type { ModelConfig } from "@/lib/types";

// 5 DISTINCT vendors across the roles.
const ORCH: ModelConfig = { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" }; // NVIDIA — orchestrator + single baseline
const PROPOSERS: ModelConfig[] = [
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },   // Google (26b — 31b endpoint was dead)
  { provider: "openrouter", model: "openai/gpt-oss-20b:free" },          // OpenAI
  { provider: "openrouter", model: "inclusionai/ling-3.0-flash:free" },  // InclusionAI
];
const SKEPTIC: ModelConfig = { provider: "openrouter", model: "cohere/north-mini-code:free" }; // Cohere (laguna was flaky: 28s->empty)

interface Case { id: string; q: string; answer: string; accept?: string[] }
const ANSWER_RE = /FINAL ANSWER:\s*([^\n]+)/gi;

function extract(text: string): string {
  const matches = [...text.matchAll(ANSWER_RE)];
  return norm(matches.length ? matches[matches.length - 1][1] : "");
}
function norm(s: string): string {
  return s.toLowerCase().replace(/\$/g, "")
    .replace(/\b(cents?|dollars?|degrees?|miles?|minutes?|days?|times?|ways?|hands?|numbers?)\b/g, "")
    .replace(/[^a-z0-9/.]/g, "").replace(/\.$/, "").trim();
}
function correct(extracted: string, c: Case): boolean {
  return [c.answer, ...(c.accept ?? [])].map(norm).includes(extracted) && extracted !== "";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CallResult { text: string; delivered: boolean }

// Paced + bounded retry-with-backoff. delivered=false on empty/error after retries (EMPTY=0).
async function ask(model: ModelConfig, system: string, prompt: string): Promise<CallResult> {
  const MAX = 3;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      const { text } = await generateText({
        model: createModel(model), temperature: 0, system, prompt,
        maxOutputTokens: Number(process.env.ASK_MAX_TOKENS ?? 4000),
        abortSignal: AbortSignal.timeout(Number(process.env.ASK_TIMEOUT_MS ?? 120_000)),
      });
      const t = (text ?? "").trim();
      if (t.length > 0) { await sleep(1500); return { text: t, delivered: true }; }
      // empty -> backoff + retry
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = /429|rate|too many/i.test(msg);
      if (attempt === MAX - 1) { await sleep(1500); return { text: `__ERROR__ ${msg}`, delivered: false }; }
      await sleep((is429 ? 5000 : 2000) * (attempt + 1)); // harder backoff on 429
      continue;
    }
    await sleep(2000 * (attempt + 1)); // empty backoff
  }
  await sleep(1500);
  return { text: "", delivered: false };
}

const SOLVE_SYS = "Solve the problem. Reason step by step. Then on the LAST line output EXACTLY " +
  "'FINAL ANSWER: X' where X is ONLY the number — no units, no extra words.";
const SKEPTIC_SYS = "You are a skeptical fact-checker. Given a problem and candidate answers, find errors " +
  "and state the correct answer. End with 'FINAL ANSWER: X'.";
const SYNTH_SYS = "You are given a problem, several experts' answers, and a skeptic's critique. Weigh them, " +
  "resolve disagreements, and give the correct answer. End with 'FINAL ANSWER: X' (only the number).";

interface Row {
  aSingleOk: boolean; aDelivered: boolean;
  bVoteOk: boolean; bDelivered: boolean;
  cSwarmOk: boolean; cDelivered: boolean;
  passN: boolean; proposerDelivered: number;
}

function mcnemar(pairs: Array<[boolean, boolean]>) {
  let b = 0, cc = 0;
  for (const [x, y] of pairs) { if (x && !y) b++; else if (!x && y) cc++; }
  const n = b + cc, k = Math.min(b, cc); let tail = 0;
  const comb = (nn: number, kk: number) => { if (kk < 0 || kk > nn) return 0; let r = 1; for (let i = 0; i < kk; i++) r = (r * (nn - i)) / (i + 1); return r; };
  for (let i = 0; i <= k; i++) tail += comb(n, i) * Math.pow(0.5, n);
  return { b, cc, p: n === 0 ? 1 : Math.min(1, 2 * tail) };
}

async function main() {
  const argv = process.argv.slice(2);
  const fArg = argv.indexOf("--file");
  const file = fArg >= 0 ? argv[fArg + 1] : "evals/reasoning-cases-hard.json";
  const nArg = argv.indexOf("--n");
  const limit = nArg >= 0 ? parseInt(argv[nArg + 1]) : Infinity;
  const cases: Case[] = JSON.parse(await fs.readFile(path.join(process.cwd(), file), "utf-8")).slice(0, limit);

  const rows: Record<string, Row> = {};
  const dump: Record<string, unknown> = {};

  for (const c of cases) {
    // Arm A: orchestrator SOLO (single baseline).
    const single = await ask(ORCH, SOLVE_SYS, c.q);
    const aOk = correct(extract(single.text), c);

    // Proposers (subagents).
    const drafts: { model: string; text: string; ans: string; ok: boolean; delivered: boolean }[] = [];
    for (const p of PROPOSERS) {
      const r = await ask(p, SOLVE_SYS, c.q);
      const ans = extract(r.text);
      drafts.push({ model: p.model, text: r.text, ans, ok: correct(ans, c), delivered: r.delivered });
    }
    const proposerDelivered = drafts.filter((d) => d.delivered).length;
    const passN = drafts.some((d) => d.ok);

    // Arm B: majority-vote-of-3 (programmatic, call-count-matched control).
    const counts = new Map<string, number>();
    for (const d of drafts) if (d.ans) counts.set(d.ans, (counts.get(d.ans) ?? 0) + 1);
    let vote = "", voteN = -1;
    for (const [a, n] of counts) if (n > voteN) { vote = a; voteN = n; }
    const bDelivered = proposerDelivered > 0;
    const bOk = correct(vote, c);

    // Skeptic (conditional).
    const skeptic = await ask(SKEPTIC, SKEPTIC_SYS,
      `Problem: ${c.q}\n\nCandidate answers:\n${drafts.map((d, i) => `Expert ${i + 1} (${d.model}): ${d.text}`).join("\n\n")}`);

    // Arm C: full swarm -> orchestrator synth.
    const synth = await ask(ORCH, SYNTH_SYS,
      `Problem: ${c.q}\n\n${drafts.map((d, i) => `Expert ${i + 1} (${d.model}): ${d.text}`).join("\n\n")}\n\nSkeptic: ${skeptic.text}`);
    const cOk = correct(extract(synth.text), c);

    rows[c.id] = {
      aSingleOk: aOk, aDelivered: single.delivered,
      bVoteOk: bOk, bDelivered,
      cSwarmOk: cOk, cDelivered: synth.delivered,
      passN, proposerDelivered,
    };
    dump[c.id] = { q: c.q, expected: c.answer, single: { ...single, ok: aOk }, drafts, skeptic, synth: { ...synth, ok: cOk }, passN, proposerDelivered };
    console.log(`${c.id}: A=${aOk ? "✓" : "✗"}${single.delivered ? "" : "∅"} B=${bOk ? "✓" : "✗"} C=${cOk ? "✓" : "✗"}${synth.delivered ? "" : "∅"} Pass@N=${passN ? "✓" : "✗"} propDeliv=${proposerDelivered}/3  (ans ${c.answer})`);
  }

  const ids = Object.keys(rows);
  const n = ids.length;
  const pct = (k: number) => `${k}/${n} (${(k / n * 100).toFixed(0)}%)`;
  const aAcc = ids.filter((i) => rows[i].aSingleOk).length;
  const bAcc = ids.filter((i) => rows[i].bVoteOk).length;
  const cAcc = ids.filter((i) => rows[i].cSwarmOk).length;
  const passN = ids.filter((i) => rows[i].passN).length;
  const aDel = ids.filter((i) => rows[i].aDelivered).length;
  const cDel = ids.filter((i) => rows[i].cDelivered).length;
  const cVsA = mcnemar(ids.map((i) => [rows[i].cSwarmOk, rows[i].aSingleOk] as [boolean, boolean]));
  const cVsB = mcnemar(ids.map((i) => [rows[i].cSwarmOk, rows[i].bVoteOk] as [boolean, boolean]));

  console.log("\n" + "=".repeat(60));
  console.log(`n=${n}   (EMPTY=0 scoring; delivery reported separately)`);
  console.log(`A single (orchestrator solo) : acc ${pct(aAcc)}   delivered ${pct(aDel)}`);
  console.log(`B majority-vote-of-3         : acc ${pct(bAcc)}`);
  console.log(`C full swarm -> synth        : acc ${pct(cAcc)}   delivered ${pct(cDel)}`);
  console.log(`Pass@N (any proposer right)  : ${pct(passN)}   <- ceiling for any selector`);
  console.log("-".repeat(60));
  console.log(`C vs A: swarm rescues ${cVsA.b}, single rescues ${cVsA.cc}, McNemar p=${cVsA.p.toFixed(4)}`);
  console.log(`C vs B: swarm rescues ${cVsB.b}, vote rescues ${cVsB.cc}, McNemar p=${cVsB.p.toFixed(4)}`);
  console.log("=".repeat(60));

  const outFile = `evals/results/moa-free-hetero-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await fs.mkdir("evals/results", { recursive: true });
  await fs.writeFile(outFile, JSON.stringify({ config: { ORCH, PROPOSERS, SKEPTIC }, rows, summary: { n, aAcc, bAcc, cAcc, passN, aDel, cDel, cVsA, cVsB }, dump }, null, 2));
  console.log(`raw drafts saved: ${outFile}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
