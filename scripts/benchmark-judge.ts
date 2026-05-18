import { generateText } from "ai";
import { createModel } from "../src/lib/providers/llm-provider";
import { getSettings } from "../src/lib/storage/settings-store";
import { runMoAEnsemble } from "../src/lib/agent/moa";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";

// Каверзные задачи для проверки архитектуры, безопасности и логики
const BENCHMARK_QUESTIONS = [
  {
    id: "security_architecture",
    prompt: "Напиши Express.js (Node) роут, который принимает POST-запрос с `userId` и `newEmail` и обновляет email пользователя в базе (используй сырой SQL-запрос `pg` без ORM). Код должен быть строго защищен от SQL-инъекций и IDOR (Insecure Direct Object Reference).",
  },
  {
    id: "logic_puzzle",
    prompt: "У меня есть 5-литровое ведро и 3-литровое ведро. Воды неограниченно. Мне нужно ровно 4 литра. Но есть подвох: в 3-литровом ведре есть микро-трещина, из-за которой оно теряет ровно 1 литр каждую минуту. Наполнение ведра занимает 1 минуту, переливание — 1 минуту. Напиши пошаговый алгоритм, как получить ровно 4 литра.",
  }
];

// Функция-судья (LLM-as-a-Judge)
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
  console.log("🏆 Запуск Бенчмарка: Orchestra MoA vs Single Agent\n");
  
  const settings = await getSettings();
  const brainModel = createModel(settings.chatModel);
  
  let markdownReport = `# 🏆 Orchestra Benchmark Report\n\n`;
  markdownReport += `**Baseline Model:** ${settings.chatModel.model} (Single)\n`;
  markdownReport += `**Swarm Configuration:** Mixture of Agents (MoA) with ${settings.utilityModel.model}\n\n`;

  let totalScoreSingle = 0;
  let totalScoreMoA = 0;

  for (const q of BENCHMARK_QUESTIONS) {
    console.log(`⏳ Тестирую вопрос: ${q.id}...`);
    
    // 1. Single Agent Baseline
    console.log("   👉 Запуск Single Agent...");
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
    console.log("   👉 Запуск Orchestra MoA (Swarm)...");
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
    console.log("   ⚖️  Судья выносит решение...");
    // We shuffle A and B randomly to prevent position bias
    const isMoA_A = Math.random() > 0.5;
    const answerA = isMoA_A ? moaAnswer : singleAnswer;
    const answerB = isMoA_A ? singleAnswer : moaAnswer;

    const judgeResult = await evaluateAsJudge(brainModel, q.prompt, answerA, answerB);
    
    const singleScore = isMoA_A ? judgeResult.scoreB : judgeResult.scoreA;
    const moaScore = isMoA_A ? judgeResult.scoreA : judgeResult.scoreB;
    
    totalScoreSingle += singleScore;
    totalScoreMoA += moaScore;

    console.log(`   📊 Результат: Single [${singleScore}/10] vs MoA [${moaScore}/10]\n`);

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
    markdownReport += `**Вывод:** Архитектура Team of Experts математически доказала свое превосходство над одиночной моделью!`;
  } else {
    markdownReport += `**Вывод:** В данном тесте одиночная модель справилась наравне или лучше. Возможно, стоит использовать более сложные задачи.`;
  }

  const outPath = path.join(process.cwd(), "scripts", "benchmark-report.md");
  await fs.writeFile(outPath, markdownReport, "utf-8");
  console.log(`🎉 Бенчмарк завершен! Результаты в файле: ${outPath}`);
}

runBenchmark().catch(console.error);
