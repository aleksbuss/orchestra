import { embed, embedMany } from "ai";
import { createEmbeddingModel } from "@/lib/providers/llm-provider";

/**
 * Generate embeddings for an array of texts
 */
export async function embedTexts(
  texts: string[],
  config: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  },
  options?: { abortSignal?: AbortSignal }
): Promise<number[][]> {
  try {
    // Honor an already-aborted caller before doing any work. Also covers the
    // mock-provider branch below, which never reaches the SDK call to cancel.
    options?.abortSignal?.throwIfAborted();

    // Mock mode for testing without API keys
    if (config.provider === "mock") {
      const dim = config.dimensions || 1536;
      const count = texts.length;
      // Return random normalized vectors
      return Array(count).fill(0).map(() => {
        const vec = Array(dim).fill(0).map(() => Math.random() - 0.5);
        const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
        return vec.map(v => v / norm);
      });
    }

    const model = createEmbeddingModel(config);

    if (texts.length === 1) {
      const { embedding } = await embed({
        model,
        value: texts[0],
        // QA audit F-12 / AbortSignal contract: `embed`/`embedMany` are
        // abortable AI-SDK network calls in the same family as
        // generateText/Object. Forward the signal so an aborted turn cancels
        // the in-flight request instead of leaking it to completion.
        abortSignal: options?.abortSignal,
      });
      return [embedding];
    }

    const { embeddings } = await embedMany({
      model,
      values: texts,
      abortSignal: options?.abortSignal,
    });
    return embeddings;
  } catch (error) {
    // Cancellation is not an "embedding failure" — let it propagate as-is so
    // callers can distinguish an aborted turn from a real provider error.
    if (options?.abortSignal?.aborted) throw error;
    console.error("Embedding error:", error);
    throw new Error(
      `Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
