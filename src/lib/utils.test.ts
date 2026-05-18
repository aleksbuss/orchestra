import { describe, it, expect } from "vitest";
import { generateClientId } from "@/lib/utils";

describe("Utility Functions", () => {
  describe("generateClientId", () => {
    it("should return a valid UUID v4 format string", () => {
      const id = generateClientId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it("should generate unique IDs across multiple calls", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateClientId());
      }
      expect(ids.size).toBe(100); // All 100 should be unique
    });

    it("should have correct UUID field lengths", () => {
      const id = generateClientId();
      const parts = id.split("-");
      expect(parts).toHaveLength(5);
      expect(parts[0]).toHaveLength(8);
      expect(parts[1]).toHaveLength(4);
      expect(parts[2]).toHaveLength(4);
      expect(parts[3]).toHaveLength(4);
      expect(parts[4]).toHaveLength(12);
    });
  });
});
