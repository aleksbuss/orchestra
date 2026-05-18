import type { ModelMessage } from "ai";

/**
 * Merge consecutive messages that share the same role into a single message,
 * joining their text content with a blank line.
 *
 * Why: strict providers (Gemma 4 via OpenRouter, some Anthropic / Vertex
 * configurations) reject API calls that contain consecutive messages from the
 * same role. POST_MORTEM #2 documents the original aggregator failure on
 * Gemma; this helper enforces the invariant on every LLM-bound message array,
 * not only the MoA aggregator path.
 *
 * Only `user` and `assistant` plain-string messages are merged. Assistant
 * messages with tool-call parts (array content) and tool-result messages are
 * always preserved verbatim — the strict-role rule does not apply to them.
 */
export function mergeConsecutiveSameRole(
  messages: ModelMessage[]
): ModelMessage[] {
  if (messages.length < 2) return messages;
  const result: ModelMessage[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    const canMerge =
      prev !== undefined &&
      prev.role === msg.role &&
      (prev.role === "user" || prev.role === "assistant") &&
      typeof prev.content === "string" &&
      typeof msg.content === "string";

    if (canMerge && prev) {
      result[result.length - 1] = {
        ...prev,
        content: `${prev.content as string}\n\n${msg.content as string}`,
      } as ModelMessage;
    } else {
      result.push(msg);
    }
  }
  return result;
}

/**
 * Manage conversation history with size limits
 */
export class History {
  private messages: ModelMessage[] = [];
  private maxMessages: number;

  constructor(maxMessages: number = 100) {
    this.maxMessages = maxMessages;
  }

  add(message: ModelMessage): void {
    this.messages.push(message);
    this.trim();
  }

  addMany(messages: ModelMessage[]): void {
    this.messages.push(...messages);
    this.trim();
  }

  getAll(): ModelMessage[] {
    return [...this.messages];
  }

  getLast(n: number): ModelMessage[] {
    return this.messages.slice(-n);
  }

  clear(): void {
    this.messages = [];
  }

  get length(): number {
    return this.messages.length;
  }

  private trim(): void {
    if (this.messages.length > this.maxMessages) {
      // Keep system messages and trim from the beginning
      const systemMessages = this.messages.filter(
        (m) => m.role === "system"
      );
      const nonSystemMessages = this.messages.filter(
        (m) => m.role !== "system"
      );
      const trimmed = nonSystemMessages.slice(
        nonSystemMessages.length - this.maxMessages + systemMessages.length
      );
      this.messages = [...systemMessages, ...trimmed];
    }
  }

  toJSON(): ModelMessage[] {
    return this.getAll();
  }

  static fromJSON(messages: ModelMessage[], maxMessages?: number): History {
    const history = new History(maxMessages);
    history.messages = messages;
    return history;
  }
}
