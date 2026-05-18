import fs from "fs/promises";
import path from "path";
import { embed } from "ai";
import { getWorkDir } from "@/lib/storage/project-store";
import { createEmbeddingModel } from "@/lib/providers/llm-provider";
import { getSettings } from "@/lib/storage/settings-store";
import { withFileLock, safeWriteFile } from "@/lib/storage/fs-utils";

const BLACKBOARD_FILE_NAME = ".orchestra_blackboard.json";

export interface BlackboardFact {
  id: string;
  topic: string;
  content: string;
  embedding: number[];
  timestamp: string;
  author: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function getBlackboardPath(projectId: string): Promise<string> {
  const workDir = getWorkDir(projectId);
  await fs.mkdir(workDir, { recursive: true });
  return path.join(workDir, BLACKBOARD_FILE_NAME);
}

export async function loadBlackboard(projectId: string): Promise<BlackboardFact[]> {
  try {
    const bbPath = await getBlackboardPath(projectId);
    const content = await fs.readFile(bbPath, "utf-8");
    return JSON.parse(content) as BlackboardFact[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function saveBlackboard(projectId: string, facts: BlackboardFact[]): Promise<void> {
  const bbPath = await getBlackboardPath(projectId);
  await safeWriteFile(bbPath, JSON.stringify(facts, null, 2));
}

export async function writeFactToBlackboard(params: {
  projectId: string;
  topic: string;
  content: string;
  author: string;
}): Promise<string> {
  const { projectId, topic, content, author } = params;
  
  const settings = await getSettings();
  if (!settings.embeddingsModel) {
    throw new Error("No embedding model configured in settings.");
  }

  const model = createEmbeddingModel(settings.embeddingsModel);
  const { embedding } = await embed({
    model,
    value: `Topic: ${topic}\nContent: ${content}`,
  });

  const bbPath = await getBlackboardPath(projectId);

  return await withFileLock(bbPath, async () => {
    const facts = await loadBlackboard(projectId);

    const newFact: BlackboardFact = {
      id: crypto.randomUUID(),
      topic,
      content,
      embedding,
      timestamp: new Date().toISOString(),
      author,
    };

    facts.push(newFact);
    if (facts.length > 500) {
      facts.splice(0, facts.length - 500);
    }

    await saveBlackboard(projectId, facts);
    return `Successfully wrote fact '${topic}' to blackboard (Fact ID: ${newFact.id})`;
  });
}

export async function searchBlackboardFacts(params: {
  projectId: string;
  query: string;
  topK?: number;
}): Promise<Array<{ topic: string; content: string; author: string; score: number }>> {
  const { projectId, query, topK = 5 } = params;
  
  const facts = await loadBlackboard(projectId);
  if (facts.length === 0) {
    return [];
  }

  const settings = await getSettings();
  if (!settings.embeddingsModel) {
    throw new Error("No embedding model configured in settings.");
  }

  const model = createEmbeddingModel(settings.embeddingsModel);
  const { embedding: queryEmbedding } = await embed({
    model,
    value: query,
  });

  const scoredFacts = facts.map((fact) => ({
    topic: fact.topic,
    content: fact.content,
    author: fact.author,
    score: cosineSimilarity(queryEmbedding, fact.embedding),
  }));

  // Sort by similarity descending
  scoredFacts.sort((a, b) => b.score - a.score);

  return scoredFacts.slice(0, topK);
}
