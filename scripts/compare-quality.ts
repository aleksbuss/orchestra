import { generateText } from "ai";
import { createModel } from "../src/lib/providers/llm-provider";
import { getSettings } from "../src/lib/storage/settings-store";
import { runMoAEnsemble } from "../src/lib/agent/moa";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";

async function compare() {
  const settings = await getSettings();
  const brainModel = createModel(settings.chatModel);
  
  const trickyPrompt = `
You are a senior Node.js security engineer.
Write a function \`generatePassword(length: number, alphabet: string): string\` in TypeScript.
It must be cryptographically secure.
It MUST strictly avoid "modulo bias" (or any uneven probability distribution) when picking characters from the alphabet.
Return only the code snippet and a brief explanation.
`;

  let markdown = `# Сравнение качества: Single Agent vs Mixture of Agents (Team of Experts)\n\n`;
  markdown += `## Каверзная задача\n\n\`\`\`text\n${trickyPrompt.trim()}\n\`\`\`\n\n`;
  markdown += `*Справка: "Modulo bias" — это частая уязвимость, когда программисты используют \`randomBytes % alphabet.length\`. Базовые LLM часто пишут этот уязвимый код. Проверим, поймает ли это рой экспертов.*\n\n`;

  console.log("Запускаю Single Agent...");
  // 1. Single Agent (прямой вызов)
  // try {
  //   const singleResult = await generateText({
  //     model: brainModel,
  //     system: "You are a helpful coding assistant.",
  //     messages: [{ role: "user", content: trickyPrompt }],
  //     temperature: 0.7,
  //     maxTokens: 1000,
  //   });
  //   markdown += `## ❌ 1. Single Agent (Gemma-4-31b-it)\n\n${singleResult.text}\n\n`;
  //   console.log("Single Agent завершен.");
  // } catch (e: any) {
  //   markdown += `## ❌ 1. Single Agent (Ошибка)\n\n${e.message}\n\n`;
  // }

  console.log("Запускаю Swarm (Team of Experts)...");
  // 2. Swarm
  try {
    const moaResult = await runMoAEnsemble({
      chatId: crypto.randomUUID(),
      userMessage: trickyPrompt,
      history: [],
      settings,
    });
    
    markdown += `## ✅ 2. Mixture of Agents (Team of Experts ENABLED)\n\n`;
    markdown += `*Агенты-критики, участвовавшие в обсуждении:*\n`;
    for (const d of moaResult.drafts) {
      markdown += `- **${d.role}**: создал черновик (${d.text.length} символов)\n`;
    }
    markdown += `\n### Финальный ответ Агрегатора:\n\n${moaResult.text}\n\n`;
    console.log("Swarm завершен.");
  } catch (e: any) {
    markdown += `## ✅ 2. Mixture of Agents (Ошибка)\n\n${e.message}\n\n`;
  }

  const outPath = path.join(process.cwd(), "scripts", "comparison.md");
  await fs.writeFile(outPath, markdown, "utf-8");
  console.log(`\n🎉 Готово! Результаты сохранены в: ${outPath}`);
}

compare().catch(console.error);
