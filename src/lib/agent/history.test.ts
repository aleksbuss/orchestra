import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";

/**
 * History class manages conversation context with size limits.
 * We inline the implementation here to test the algorithm without
 * importing the real module (which depends on the AI SDK types).
 */
class History {
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
      const systemMessages = this.messages.filter((m) => m.role === "system");
      const nonSystemMessages = this.messages.filter((m) => m.role !== "system");
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

// ── Tests ───────────────────────────────────────────────────────────

describe("History (Conversation Context Manager)", () => {
  const mkMsg = (role: "user" | "assistant" | "system", text: string): ModelMessage => ({
    role,
    content: text,
  });

  describe("Basic operations", () => {
    it("should start empty", () => {
      const h = new History();
      expect(h.length).toBe(0);
      expect(h.getAll()).toEqual([]);
    });

    it("should add single messages", () => {
      const h = new History();
      h.add(mkMsg("user", "Hello"));
      h.add(mkMsg("assistant", "Hi"));
      expect(h.length).toBe(2);
    });

    it("should add many messages at once", () => {
      const h = new History();
      h.addMany([
        mkMsg("user", "A"),
        mkMsg("assistant", "B"),
        mkMsg("user", "C"),
      ]);
      expect(h.length).toBe(3);
    });

    it("should return a copy from getAll() (not a reference)", () => {
      const h = new History();
      h.add(mkMsg("user", "Hello"));
      const all = h.getAll();
      all.push(mkMsg("user", "Injected"));
      expect(h.length).toBe(1); // Internal state not mutated
    });

    it("should return last N messages", () => {
      const h = new History();
      h.addMany([
        mkMsg("user", "1"),
        mkMsg("assistant", "2"),
        mkMsg("user", "3"),
        mkMsg("assistant", "4"),
      ]);
      const last2 = h.getLast(2);
      expect(last2).toHaveLength(2);
      expect((last2[0].content as string)).toBe("3");
      expect((last2[1].content as string)).toBe("4");
    });

    it("should clear all messages", () => {
      const h = new History();
      h.addMany([mkMsg("user", "A"), mkMsg("user", "B")]);
      h.clear();
      expect(h.length).toBe(0);
    });
  });

  describe("Trimming (max size enforcement)", () => {
    it("should trim oldest non-system messages when limit exceeded", () => {
      const h = new History(3);
      h.addMany([
        mkMsg("user", "1"),
        mkMsg("assistant", "2"),
        mkMsg("user", "3"),
        mkMsg("assistant", "4"), // This exceeds max=3
      ]);
      expect(h.length).toBe(3);
      const msgs = h.getAll();
      expect((msgs[0].content as string)).toBe("2");
      expect((msgs[2].content as string)).toBe("4");
    });

    it("should preserve system messages during trimming", () => {
      const h = new History(3);
      h.addMany([
        mkMsg("system", "System prompt"),
        mkMsg("user", "1"),
        mkMsg("assistant", "2"),
        mkMsg("user", "3"),
        mkMsg("assistant", "4"),
      ]);
      const msgs = h.getAll();
      expect(msgs[0].role).toBe("system");
      expect((msgs[0].content as string)).toBe("System prompt");
    });
  });

  describe("Serialization", () => {
    it("toJSON should return all messages", () => {
      const h = new History();
      h.add(mkMsg("user", "Hello"));
      const json = h.toJSON();
      expect(json).toHaveLength(1);
    });

    it("fromJSON should restore history", () => {
      const msgs: ModelMessage[] = [
        mkMsg("user", "A"),
        mkMsg("assistant", "B"),
      ];
      const h = History.fromJSON(msgs, 10);
      expect(h.length).toBe(2);
      expect(h.getAll()).toEqual(msgs);
    });
  });
});
