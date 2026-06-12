import { generateText } from "ai";
import { createModel } from "../src/lib/providers/llm-provider";
import { getSettings } from "../src/lib/storage/settings-store";
import { runMoAEnsemble } from "../src/lib/agent/moa";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";

// Adversarial tasks probing architecture, security and logic
const BENCHMARK_QUESTIONS = [
  {
    id: "security_architecture",
    prompt: "Write an Express.js (Node) route that accepts a POST request with `userId` and `newEmail` and updates the user's email in the database (use a raw `pg` SQL query, no ORM). The code must be strictly protected against SQL injection and IDOR (Insecure Direct Object Reference).",
  },
  {
    id: "logic_puzzle",
    prompt: "I have a 5-liter bucket and a 3-liter bucket, with unlimited water. I need exactly 4 liters. The catch: the 3-liter bucket has a micro-crack and loses exactly 1 liter per minute. Filling a bucket takes 1 minute, pouring between buckets takes 1 minute. Write a step-by-step algorithm to end up with exactly 4 liters.",
  }
];

// LLM-as-a-Judge
async function evaluateAsJudge(judgeModel: any, prompt: string, answerA: string, answerB: string) {
  const judgePrompt = `
You are an impartial, expert AI Judge evaluating two different AI responses to a complex prompt.

[USER PROMPT]
${prompt}

[RESPONSE A]
${answerA}

[RESPONSE B]
${answerB}

Evaluate both responses strictly on:
1. Security & Correctness (Did they miss a vulnerability like IDOR or SQLi? Did they fail the logic puzzle?)
2. Completeness (Did they address all constraints?)

Output EXACTLY in this JSON format (no markdown code blocks, just raw JSON):
{
  "scoreA": <number 1-10>,
  "scoreB": <number 1-10>,
  "reasoning": "<brief explanation of who won and why>"
}
`;

  try {
    const result = await generateText({
      model: judgeModel,
      system: "You are a strict, objective, and JSON-only evaluation engine.",
      messages: [{ role: "user", content: judgePrompt }],
      temperature: 0.1,
      maxTokens: 500,
    });
    
    const text = result.text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(text);
  } catch (err: any) {
    console.error("Judge Error:", err.message);
    return { scoreA: 0, scoreB: 0, reasoning: "Judge failed to evaluate." };
  }
}

async function runBenchmark() {
  console.log("Benchmark: Orchestra MoA vs Single Agent\n");
  
  const settings = await getSettings();
  const brainModel = createModel(settings.chatModel);
  
  let markdownReport = `# 🏆 Orchestra Benchmark Report\n\n`;
  markdownReport += `**Baseline Model:** ${settings.chatModel.model} (Single)\n`;
  markdownReport += `**Swarm Configuration:** Mixture of Agents (MoA) with ${settings.utilityModel.model}\n\n`;

  let totalScoreSingle = 0;
  let totalScoreMoA = 0;

  for (const q of BENCHMARK_QUESTIONS) {
    console.log(`Running question: ${q.id}...`);

    // 1. Single Agent Baseline
    console.log("   -> Single Agent...");
    let singleAnswer = "";
    try {
      const res = await generateText({
        model: brainModel,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: q.prompt }],
        temperature: 0.7,
        maxTokens: 1024,
      });
      singleAnswer = res.text;
    } catch (e: any) {
      singleAnswer = `[Error: ${e.message}]`;
    }

    // 2. Orchestra MoA Swarm
    console.log("   -> Orchestra MoA (Swarm)...");
    let moaAnswer = "";
    try {
      const moaResult = await runMoAEnsemble({
        chatId: crypto.randomUUID(),
        userMessage: q.prompt,
        history: [],
        settings,
      });
      moaAnswer = moaResult.text;
    } catch (e: any) {
      moaAnswer = `[Error: ${e.message}]`;
    }

    // 3. Judgment
    console.log("   -> Judging...");
    // We shuffle A and B randomly to prevent position bias
    const isMoA_A = Math.random() > 0.5;
    const answerA = isMoA_A ? moaAnswer : singleAnswer;
    const answerB = isMoA_A ? singleAnswer : moaAnswer;

    const judgeResult = await evaluateAsJudge(brainModel, q.prompt, answerA, answerB);
    
    const singleScore = isMoA_A ? judgeResult.scoreB : judgeResult.scoreA;
    const moaScore = isMoA_A ? judgeResult.scoreA : judgeResult.scoreB;
    
    totalScoreSingle += singleScore;
    totalScoreMoA += moaScore;

    console.log(`   Result: Single [${singleScore}/10] vs MoA [${moaScore}/10]\n`);

    markdownReport += `## Test: ${q.id}\n`;
    markdownReport += `> ${q.prompt}\n\n`;
    markdownReport += `### Scores\n`;
    markdownReport += `- **Single Agent:** ${singleScore}/10\n`;
    markdownReport += `- **Orchestra MoA:** ${moaScore}/10\n\n`;
    markdownReport += `### Judge Reasoning:\n${judgeResult.reasoning}\n\n`;
    markdownReport += `---\n\n`;
  }

  markdownReport += `## 🏁 Final Verdict\n`;
  markdownReport += `- **Single Agent Total:** ${totalScoreSingle} / ${BENCHMARK_QUESTIONS.length * 10}\n`;
  markdownReport += `- **Orchestra MoA Total:** ${totalScoreMoA} / ${BENCHMARK_QUESTIONS.length * 10}\n\n`;
  
  if (totalScoreMoA > totalScoreSingle) {
    markdownReport += `**Verdict:** MoA outscored the single agent in this run (${totalScoreMoA} vs ${totalScoreSingle}, LLM judge, n=${BENCHMARK_QUESTIONS.length}). Small sample — treat as a smoke signal, not proof.`;
  } else {
    markdownReport += `**Verdict:** The single agent matched or beat MoA in this run (${totalScoreSingle} vs ${totalScoreMoA}). Consider harder tasks or more samples.`;
  }

  const outPath = path.join(process.cwd(), "scripts", "benchmark-report.md");
  await fs.writeFile(outPath, markdownReport, "utf-8");
  console.log(`Benchmark complete. Report written to: ${outPath}`);
}

runBenchmark().catch(console.error);
