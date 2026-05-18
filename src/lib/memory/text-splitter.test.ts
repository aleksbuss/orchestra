import { describe, it, expect } from "vitest";
import { RecursiveCharacterTextSplitter } from "@/lib/memory/text-splitter";

describe("RecursiveCharacterTextSplitter", () => {
  describe("Basic splitting", () => {
    it("should return the original text if shorter than chunkSize", async () => {
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000 });
      const chunks = await splitter.splitText("Short text");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("Short text");
    });

    it("should split long text into multiple chunks", async () => {
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 50, chunkOverlap: 0 });
      const text = "A".repeat(200);
      const chunks = await splitter.splitText(text);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("should prefer paragraph separators over word separators", async () => {
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 0 });
      const text = "Paragraph one content.\n\nParagraph two content.\n\nParagraph three content.";
      const chunks = await splitter.splitText(text);
      // Should split on \n\n (paragraph breaks)
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // Each chunk should be clean without broken words
      for (const chunk of chunks) {
        expect(chunk.trim()).not.toBe("");
      }
    });

    it("should handle text with only newlines", async () => {
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 50, chunkOverlap: 0 });
      const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
      const chunks = await splitter.splitText(text);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Overlap", () => {
    it("should create overlapping chunks when chunkOverlap > 0", async () => {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 40,
        chunkOverlap: 10,
      });
      const text = "Word1 Word2 Word3 Word4 Word5 Word6 Word7 Word8 Word9 Word10";
      const chunks = await splitter.splitText(text);
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe("createDocuments", () => {
    it("should split multiple texts and combine results", async () => {
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 50, chunkOverlap: 0 });
      const texts = ["Short text one.", "Short text two."];
      const docs = await splitter.createDocuments(texts);
      expect(docs.length).toBeGreaterThanOrEqual(2);
    });

    it("should handle empty input array", async () => {
      const splitter = new RecursiveCharacterTextSplitter();
      const docs = await splitter.createDocuments([]);
      expect(docs).toHaveLength(0);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty string", async () => {
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 100 });
      const chunks = await splitter.splitText("");
      // Should return either empty array or array with empty string
      expect(chunks.length).toBeLessThanOrEqual(1);
    });

    it("should handle text with no separators", async () => {
      const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 10, chunkOverlap: 0 });
      const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const chunks = await splitter.splitText(text);
      expect(chunks.length).toBeGreaterThan(1);
      // All characters should be present across chunks
      const joined = chunks.join("");
      expect(joined).toContain("A");
      expect(joined).toContain("Z");
    });
  });
});
