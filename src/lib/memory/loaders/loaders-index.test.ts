/**
 * Tests for `loadDocument` — the dispatcher that routes a file path to
 * the right loader by extension. This is the single entry point used by
 * `knowledge.ts` ingestion, so a missing extension here means that file
 * type is silently dropped from RAG.
 *
 * Pinned invariants:
 *   - Routes 12+ text-like extensions to `loadText` (.txt, .md, .json,
 *     .csv, .html, .xml, .yaml, .yml, .js, .ts, .py, .log).
 *   - Routes .pdf, .docx, .xlsx, .xls to their dedicated loaders.
 *   - Routes 6 image extensions to OCR.
 *   - Returns `null` (not throws) for an unknown extension — caller
 *     uses null as "skip this file."
 *   - Returns `null` on loader exception — same swallowing contract.
 *   - Extension match is case-insensitive (`.PDF`, `.JPG` work too).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("./pdf-loader", () => ({ loadPdf: vi.fn() }));
vi.mock("./docx-loader", () => ({ loadDocx: vi.fn() }));
vi.mock("./xlsx-loader", () => ({ loadXlsx: vi.fn() }));
vi.mock("./image-loader", () => ({ loadImage: vi.fn() }));

import { loadDocument } from "./index";
import { loadPdf } from "./pdf-loader";
import { loadDocx } from "./docx-loader";
import { loadXlsx } from "./xlsx-loader";
import { loadImage } from "./image-loader";

const mockedPdf = vi.mocked(loadPdf);
const mockedDocx = vi.mocked(loadDocx);
const mockedXlsx = vi.mocked(loadXlsx);
const mockedImage = vi.mocked(loadImage);

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-loaders-idx-"));
  vi.clearAllMocks();

  // Default: every loader returns a non-empty doc unless overridden.
  const ok = (type: string) =>
    Promise.resolve({ text: `${type} text`, metadata: { type } });
  mockedPdf.mockImplementation(() => ok("pdf") as any);
  mockedDocx.mockImplementation(() => ok("docx") as any);
  mockedXlsx.mockImplementation(() => ok("xlsx") as any);
  mockedImage.mockImplementation(() => ok("image") as any);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function plant(filename: string, content = "any"): Promise<string> {
  const file = path.join(tmpRoot, filename);
  await fs.writeFile(file, content, "utf-8");
  return file;
}

describe("loadDocument — text extensions", () => {
  // 12+ extensions all routed to text-loader (real implementation).
  it.each([
    "doc.txt",
    "README.md",
    "data.json",
    "rows.csv",
    "page.html",
    "config.xml",
    "config.yaml",
    "config.yml",
    "script.js",
    "module.ts",
    "tool.py",
    "server.log",
  ])("routes %s to the text loader", async (filename) => {
    const file = await plant(filename, "content for " + filename);
    const out = await loadDocument(file);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("content for " + filename);
    expect(out!.metadata.type).toBe("text");
  });
});

describe("loadDocument — binary loaders", () => {
  it("routes .pdf to pdf-loader", async () => {
    const file = await plant("doc.pdf");
    await loadDocument(file);
    expect(mockedPdf).toHaveBeenCalledOnce();
    expect(mockedDocx).not.toHaveBeenCalled();
  });

  it("routes .docx to docx-loader", async () => {
    const file = await plant("doc.docx");
    await loadDocument(file);
    expect(mockedDocx).toHaveBeenCalledOnce();
  });

  it("routes both .xlsx AND .xls to xlsx-loader", async () => {
    const xlsx = await plant("a.xlsx");
    const xls = await plant("b.xls");
    await loadDocument(xlsx);
    await loadDocument(xls);
    expect(mockedXlsx).toHaveBeenCalledTimes(2);
  });

  it.each(["png", "jpg", "jpeg", "gif", "bmp", "webp"])(
    "routes .%s to image-loader (OCR)",
    async (ext) => {
      const file = await plant(`scan.${ext}`);
      await loadDocument(file);
      expect(mockedImage).toHaveBeenCalledOnce();
    }
  );
});

describe("loadDocument — case insensitivity", () => {
  it("routes .PDF (uppercase) the same as .pdf", async () => {
    const file = await plant("doc.PDF");
    await loadDocument(file);
    expect(mockedPdf).toHaveBeenCalledOnce();
  });

  it("routes .JPG to image-loader", async () => {
    const file = await plant("scan.JPG");
    await loadDocument(file);
    expect(mockedImage).toHaveBeenCalledOnce();
  });
});

describe("loadDocument — unknown / error paths", () => {
  it("returns null for an unsupported extension (caller skips the file)", async () => {
    const file = await plant("doc.docxxxx");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadDocument(file)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/No loader/i));
    warnSpy.mockRestore();
  });

  it("returns null when the underlying loader THROWS (does NOT propagate)", async () => {
    const file = await plant("doc.pdf");
    mockedPdf.mockRejectedValue(new Error("malformed pdf"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await loadDocument(file)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("returns null for a file with no extension", async () => {
    const file = await plant("README");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadDocument(file)).toBeNull();
    warnSpy.mockRestore();
  });
});
