#!/usr/bin/env node
/**
 * Heterogeneous MoA vs single vs compute-matched majority-vote — the decisive
 * (directional) test designed with DoubleTake, on HARD exact-match reasoning
 * questions (no LLM judge — answers are exact, scored programmatically, so there
 * is no judge self-preference/length bias and no cost for judging).
 *
 * Three arms per question:
 *   A (single)        : one call to the BRAIN model.
 *   B (majority vote) : 3 cross-family PROPOSERS answer independently -> programmatic mode.
 *   C (MoA)           : the same 3 proposers (reasoning+answer) + a SKEPTIC critique -> the
 *                       BRAIN synthesizes a final answer. (The operator's real config.)
 *
 * Proposers are PAID cross-family models (uncorrelated blind spots — the only regime
 * where MoA can beat majority-vote). Calls run SEQUENTIALLY to avoid the free-tier /
 * parallel-load throttle wall that invalidated an earlier run.
 *
 * Falsification: if C <= A the architecture DEGRADES; if C <= B the synthesizer cannot
 * adjudicate (it is swayed by confident wrong proposers instead of finding the lone right one).
 *
 * Run: OPENROUTER_API_KEY=... npx tsx scripts/moa-vs-vote.ts [--n 24] [--runs 1]
 */
import fs from "fs/promises";
import path from "path";
import { generateText } from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import type { ModelConfig } from "@/lib/types";

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

const BRAIN: ModelConfig = { provider: "openrouter", model: "deepseek/deepseek-v4-flash" };
const PROPOSERS: ModelConfig[] = [
  { provider: "openrouter", model: "deepseek/deepseek-chat" },
  { provider: "openrouter", model: "openai/gpt-4o-mini" },
  { provider: "openrouter", model: "anthropic/claude-3.5-haiku" },
];
const SKEPTIC: ModelConfig = { provider: "openrouter", model: "moonshotai/kimi-k2" };

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
    .replace(/\b(cents?|dollars?|degrees?|miles?|minutes?|days?|times?)\b/g, "")
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
      abortSignal: AbortSignal.timeout(60_000),
    });
    return text ?? "";
  } catch (err) {
    return `__ERROR__ ${err instanceof Error ? err.message : String(err)}`;
  }
}

const SOLVE_SYS =
  "Solve the problem. Reason briefly step by step. Then on the LAST line output EXACTLY " +
  "'FINAL ANSWER: X' where X is ONLY the number, word, or fraction — no units, no extra words.";

async function armA(c: Case): Promise<boolean> {
  return correct(extract(await ask(BRAIN, SOLVE_SYS, c.q)), c);
}

async function armB(c: Case): Promise<boolean> {
  const answers: string[] = [];
  for (const p of PROPOSERS) answers.push(extract(await ask(p, SOLVE_SYS, c.q)));
  // programmatic mode; tie -> first proposer (primary)
  const counts = new Map<string, number>();
  for (const a of answers) if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  let best = answers[0], bestN = -1;
  for (const [a, n] of counts) if (n > bestN) { best = a; bestN = n; }
  return correct(best, c);
}

async function armC(c: Case): Promise<boolean> {
  const drafts: string[] = [];
  for (const p of PROPOSERS) drafts.push(await ask(p, SOLVE_SYS, c.q));
  const skeptic = await ask(
    SKEPTIC,
    "You are a skeptical fact-checker. Given a problem and candidate answers, find errors and state the correct answer. End with 'FINAL ANSWER: X'.",
    `Problem: ${c.q}\n\nCandidate answers:\n${drafts.map((d, i) => `Expert ${i + 1}: ${d}`).join("\n\n")}`
  );
  const synth = await ask(
    BRAIN,
    "You are given a problem, several experts' answers, and a skeptic's critique. Weigh them, resolve disagreements, and give the correct answer. End with 'FINAL ANSWER: X' (only the number/word/fraction).",
    `Problem: ${c.q}\n\n${drafts.map((d, i) => `Expert ${i + 1}: ${d}`).join("\n\n")}\n\nSkeptic: ${skeptic}`
  );
  return correct(extract(synth), c);
}

function mcnemar(pairs: Array<[boolean, boolean]>): { b: number; cc: number; p: number } {
  let b = 0, cc = 0;
  for (const [x, y] of pairs) { if (x && !y) b++; else if (!x && y) cc++; }
  const n = b + cc, k = Math.min(b, cc);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += comb(n, i) * Math.pow(0.5, n);
  return { b, cc, p: n === 0 ? 1 : Math.min(1, 2 * tail) };
}

async function main() {
  const argv = process.argv.slice(2);
  const nArg = argv.indexOf("--n");
  const limit = nArg >= 0 ? parseInt(argv[nArg + 1]) : Infinity;
  const fArg = argv.indexOf("--file");
  const file = fArg >= 0 ? argv[fArg + 1] : "evals/reasoning-cases.json";
  const cases: Case[] = JSON.parse(
    await fs.readFile(path.join(process.cwd(), file), "utf-8")
  ).slice(0, limit);

  const res: Record<string, { a: boolean; b: boolean; c: boolean }> = {};
  for (const c of cases) {
    const [a, b, cc] = [await armA(c), await armB(c), await armC(c)];
    res[c.id] = { a, b, c: cc };
    console.log(`${c.id}: A=${a ? "✓" : "✗"} B=${b ? "✓" : "✗"} C=${cc ? "✓" : "✗"}  (ans ${c.answer})`);
  }

  const ids = Object.keys(res);
  const n = ids.length;
  const acc = (k: "a" | "b" | "c") => ids.filter((i) => res[i][k]).length;
  const cVsA = mcnemar(ids.map((i) => [res[i].c, res[i].a] as [boolean, boolean]));
  const cVsB = mcnemar(ids.map((i) => [res[i].c, res[i].b] as [boolean, boolean]));
  console.log("\n" + "=".repeat(56));
  console.log(`n=${n}`);
  console.log(`A single      : ${acc("a")}/${n} (${(acc("a") / n * 100).toFixed(0)}%)`);
  console.log(`B majority-vote: ${acc("b")}/${n} (${(acc("b") / n * 100).toFixed(0)}%)`);
  console.log(`C MoA (config) : ${acc("c")}/${n} (${(acc("c") / n * 100).toFixed(0)}%)`);
  console.log("-".repeat(56));
  console.log(`C vs A: MoA rescues ${cVsA.b}, single rescues ${cVsA.cc}, McNemar p=${cVsA.p.toFixed(4)}`);
  console.log(`C vs B: MoA rescues ${cVsB.b}, vote rescues ${cVsB.cc}, McNemar p=${cVsB.p.toFixed(4)}`);
  console.log("=".repeat(56));
  const outFile = `evals/results/moa-vs-vote-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await fs.mkdir("evals/results", { recursive: true });
  await fs.writeFile(outFile, JSON.stringify({ res, acc: { a: acc("a"), b: acc("b"), c: acc("c") }, n, cVsA, cVsB }, null, 2));
  console.log(`results: ${outFile}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
