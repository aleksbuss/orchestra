#!/usr/bin/env node
/**
 * Blind pairwise judge for the MoA A/B (Track B pilot).
 * For each prompt: shuffles the two answers into A/B, judges TWICE with
 * swapped positions (position-bias control), via deepseek-chat on OpenRouter.
 * Verdict per judging: winner A|B|tie + scores + rationale; the report maps
 * back to arms and flags position-sensitive verdicts.
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.AB_REPO_ROOT || "/Users/aleksejsbuss/orchestra";

const settings = JSON.parse(
  await fs.readFile(path.join(REPO, "data/settings/settings.json"), "utf-8")
);
const OR_KEY = settings?.chatModel?.apiKey;
if (!OR_KEY) throw new Error("no openrouter key in settings");
const JUDGE_MODEL = "deepseek/deepseek-chat";

const results = JSON.parse(await fs.readFile(path.join(HERE, "results.json"), "utf-8"));
const prompts = JSON.parse(await fs.readFile(path.join(HERE, "prompts.json"), "utf-8"));

async function judgeOnce(promptText, answerA, answerB) {
  const system = `You are a strict evaluation judge. Compare two answers to the same user prompt.
Criteria, in priority order:
1. Correctness — factual/technical accuracy; penalize any hallucinated or wrong claim heavily.
2. Completeness & insight — covers the real facets, surfaces non-obvious considerations.
3. Directness & actionability — answers what was asked, commits where asked to commit.
Verbosity alone is NOT quality; do not reward length.
Respond with ONLY a JSON object: {"winner": "A"|"B"|"tie", "scoreA": 1-10, "scoreB": 1-10, "rationale": "<2-3 sentences>", "factErrors": {"A": ["..."], "B": ["..."]}}`;
  const user = `## Prompt\n${promptText}\n\n## Answer A\n${answerA}\n\n## Answer B\n${answerB}\n\nJudge now. JSON only.`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OR_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`judge http ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const raw = body.choices?.[0]?.message?.content ?? "";
  const jsonText = raw.replace(/^```(json)?/m, "").replace(/```$/m, "").trim();
  return JSON.parse(jsonText);
}

const report = [];
for (const p of prompts) {
  const single = results.find((r) => r.promptId === p.id && r.arm === "single" && r.ok);
  const swarm = results.find((r) => r.promptId === p.id && r.arm === "swarm" && r.ok);
  if (!single || !swarm) {
    report.push({ promptId: p.id, error: "missing arm", single: !!single, swarm: !!swarm });
    continue;
  }

  // Pass 1: random assignment. Pass 2: swapped.
  const swarmIsA = Math.random() < 0.5;
  const [a1, b1] = swarmIsA ? [swarm.answer, single.answer] : [single.answer, swarm.answer];
  const pass1 = await judgeOnce(p.prompt, a1, b1);
  const pass2 = await judgeOnce(p.prompt, b1, a1);

  const toArm = (winner, aIsSwarm) =>
    winner === "tie" ? "tie" : (winner === "A") === aIsSwarm ? "swarm" : "single";
  const v1 = toArm(pass1.winner, swarmIsA);
  const v2 = toArm(pass2.winner, !swarmIsA);
  const agreed = v1 === v2;

  report.push({
    promptId: p.id,
    category: p.category,
    verdict: agreed ? v1 : "position-sensitive",
    pass1: { asArm: v1, ...pass1 },
    pass2: { asArm: v2, ...pass2 },
    metrics: {
      single: { wallMs: single.wallMs, chars: single.answerChars, usage: single.usage },
      swarm: { wallMs: swarm.wallMs, chars: swarm.answerChars, usage: swarm.usage },
    },
  });
  console.log(`${p.id}: ${agreed ? v1 : `POSITION-SENSITIVE (${v1}/${v2})`}`);
}

await fs.writeFile(path.join(HERE, "judge-report.json"), JSON.stringify(report, null, 2));
console.log("→ judge-report.json");
