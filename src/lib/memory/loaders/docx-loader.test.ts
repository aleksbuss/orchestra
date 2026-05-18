/**
 * Tests for `loadDocx` — wraps `mammoth.extractRawText` with the
 * loader's metadata shape. The actual DOCX parsing is mammoth's job;
 * we mock it so the test is fast + deterministic.
 *
 * Pinned invariants:
 *   - Reads the file as a Buffer (not a path) — mammoth's path-mode has
 *     historic Cyrillic-filename bugs the loader file comments call out.
 *   - Trims surrounding whitespace from the extracted text.
 *   - Surfaces filename in metadata for downstream filtering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("mammoth", () => ({
  default: { extractRawText: vi.fn() },
}));

import { loadDocx } from "./docx-loader";
import mammoth from "mammoth";

const mockedExtract = vi.mocked(mammoth.extractRawText);

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-docxloader-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("loadDocx", () => {
  it("calls mammoth with the file's BUFFER, not its path (Cyrillic-safe)", async () => {
    const file = path.join(tmpRoot, "doc-Привет.docx");
    await fs.writeFile(file, Buffer.from([0x50, 0x4b])); // ZIP magic

    mockedExtract.mockResolvedValue({ value: "extracted text", messages: [] } as any);

    await loadDocx(file);

    expect(mockedExtract).toHaveBeenCalledOnce();
    const arg = mockedExtract.mock.calls[0][0];
    expect(arg).toHaveProperty("buffer");
    expect(Buffer.isBuffer((arg as { buffer: Buffer }).buffer)).toBe(true);
  });

  it("returns the extracted text trimmed", async () => {
    const file = path.join(tmpRoot, "doc.docx");
    await fs.writeFile(file, Buffer.from([0x50]));
    mockedExtract.mockResolvedValue({ value: "  hello\n\n  ", messages: [] } as any);

    const out = await loadDocx(file);
    expect(out.text).toBe("hello");
  });

  it("attaches source/type='docx'/filename metadata", async () => {
    const file = path.join(tmpRoot, "Resume_Q1.docx");
    await fs.writeFile(file, Buffer.from([0x50]));
    mockedExtract.mockResolvedValue({ value: "ok", messages: [] } as any);

    const out = await loadDocx(file);
    expect(out.metadata.source).toBe(file);
    expect(out.metadata.type).toBe("docx");
    expect(out.metadata.filename).toBe("Resume_Q1.docx");
  });

  it("propagates mammoth errors (caller's loaders/index catches them)", async () => {
    const file = path.join(tmpRoot, "broken.docx");
    await fs.writeFile(file, Buffer.from([0x00]));
    mockedExtract.mockRejectedValue(new Error("not a valid docx"));

    await expect(loadDocx(file)).rejects.toThrow(/not a valid docx/);
  });
});
