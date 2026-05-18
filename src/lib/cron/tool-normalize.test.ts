import { describe, it, expect } from "vitest";
import {
  normalizeCronToolAddInput,
  explainCronToolAddInputFailure,
  normalizeCronToolPatchInput,
} from "@/lib/cron/tool-normalize";

describe("Cron Tool Input Normalizer", () => {
  describe("normalizeCronToolAddInput", () => {
    it("should parse a simple delay-based job", () => {
      const result = normalizeCronToolAddInput({
        delaySeconds: 30,
        message: "Send a reminder",
      });
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("at");
      expect(result!.payload.message).toBe("Send a reminder");
    });

    it("should parse a recurring interval job", () => {
      const result = normalizeCronToolAddInput({
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "agentTurn", message: "Check status" },
      });
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("every");
      if (result!.schedule.kind === "every") {
        expect(result!.schedule.everyMs).toBe(60000);
      }
    });

    it("should parse a cron expression job", () => {
      const result = normalizeCronToolAddInput({
        schedule: { kind: "cron", expr: "*/5 * * * *" },
        payload: { kind: "agentTurn", message: "Periodic task" },
      });
      expect(result).not.toBeNull();
      expect(result!.schedule.kind).toBe("cron");
    });

    it("should parse nested data wrappers (LLM hallucination resilience)", () => {
      const result = normalizeCronToolAddInput({
        data: {
          delaySeconds: 10,
          message: "Nested message",
        },
      });
      expect(result).not.toBeNull();
      expect(result!.payload.message).toBe("Nested message");
    });

    it("should return null for completely invalid input", () => {
      expect(normalizeCronToolAddInput(null)).toBeNull();
      expect(normalizeCronToolAddInput("string")).toBeNull();
      expect(normalizeCronToolAddInput(42)).toBeNull();
    });

    it("should return null when schedule is missing", () => {
      const result = normalizeCronToolAddInput({
        message: "No schedule provided",
      });
      expect(result).toBeNull();
    });

    it("should set deleteAfterRun=true for one-shot 'at' jobs by default", () => {
      const result = normalizeCronToolAddInput({
        delaySeconds: 10,
        message: "One-shot",
      });
      expect(result).not.toBeNull();
      expect(result!.deleteAfterRun).toBe(true);
    });

    it("should convert everyMinutes to everyMs", () => {
      const result = normalizeCronToolAddInput({
        schedule: { kind: "every", everyMinutes: 5 },
        payload: { kind: "agentTurn", message: "Every 5 min" },
      });
      expect(result).not.toBeNull();
      if (result!.schedule.kind === "every") {
        expect(result!.schedule.everyMs).toBe(300000);
      }
    });
  });

  describe("explainCronToolAddInputFailure", () => {
    it("should explain missing schedule", () => {
      const msg = explainCronToolAddInputFailure({ message: "Hello" });
      expect(msg).toContain("schedule");
    });

    it("should explain missing message", () => {
      const msg = explainCronToolAddInputFailure({ delaySeconds: 10 });
      expect(msg).toContain("message");
    });

    it("should explain non-object input", () => {
      const msg = explainCronToolAddInputFailure("string");
      expect(msg).toContain("JSON object");
    });
  });

  describe("normalizeCronToolPatchInput", () => {
    it("should extract name and enabled from patch", () => {
      const result = normalizeCronToolPatchInput(
        { name: "Updated", enabled: false },
        null
      );
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Updated");
      expect(result!.enabled).toBe(false);
    });

    it("should return null for empty patch", () => {
      const result = normalizeCronToolPatchInput({}, null);
      expect(result).toBeNull();
    });

    it("should accept a separate patch object", () => {
      const result = normalizeCronToolPatchInput(
        {},
        { name: "From patch arg", enabled: true }
      );
      expect(result).not.toBeNull();
      expect(result!.name).toBe("From patch arg");
    });
  });
});
