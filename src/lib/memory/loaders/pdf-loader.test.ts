/**
 * Tests for `loadPdf` — wraps `pdfjs-dist/legacy` with the loader's
 * metadata shape. The PDF parser itself is mocked: real PDF parsing
 * pulls in a worker setup that's flaky in unit tests.
 *
 * Pinned invariants:
 *   - Reads file as Uint8Array (pdfjs requires it, not a Node Buffer).
 *   - Iterates ALL pages (1..numPages, 1-indexed per pdfjs API).
 *   - Concatenates page text with blank lines and trims trailing.
 *   - Surfaces page count + info metadata.
 *   - Pre-emptively sets `GlobalWorkerOptions.workerSrc` to "" so we
 *     don't try to load a worker in Node.
 *   - Uses `useSystemFonts: true` + `disableFontFace: true` to avoid
 *     font-parsing crashes documented inline in the loader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const mockGetDocument = vi.fn();
const mockGlobalWorkerOptions = { workerSrc: undefined as string | undefined };

vi.mock("pdfjs-dist/legacy/build/pdf.js", () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
  GlobalWorkerOptions: mockGlobalWorkerOptions,
}));

import { loadPdf } from "./pdf-loader";

let tmpRoot: string;

function fakeDocument(opts: {
  numPages: number;
  pageTexts: string[];
  info?: Record<string, unknown>;
}): unknown {
  return {
    numPages: opts.numPages,
    getMetadata: vi.fn().mockResolvedValue({ info: opts.info ?? { Title: "T" } }),
    getPage: vi.fn().mockImplementation(async (i: number) => ({
      getTextContent: vi.fn().mockResolvedValue({
        items: (opts.pageTexts[i - 1] ?? "").split(" ").map((str) => ({ str })),
      }),
    })),
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-pdfloader-"));
  vi.clearAllMocks();
  // Reset workerSrc so the "if not set" branch is exercised on fresh load.
  mockGlobalWorkerOptions.workerSrc = undefined;
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("loadPdf — invocation", () => {
  it("reads file content and passes it as Uint8Array to pdfjs.getDocument", async () => {
    const file = path.join(tmpRoot, "doc.pdf");
    await fs.writeFile(file, Buffer.from("%PDF-1.4 fake"));

    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(fakeDocument({ numPages: 1, pageTexts: ["page one"] })),
    });

    await loadPdf(file);

    expect(mockGetDocument).toHaveBeenCalledOnce();
    const arg = mockGetDocument.mock.calls[0][0];
    expect(arg.data).toBeInstanceOf(Uint8Array);
    expect(arg.useSystemFonts).toBe(true);
    expect(arg.disableFontFace).toBe(true);
  });

  it("sets GlobalWorkerOptions.workerSrc to an empty string when unset (no worker file load)", async () => {
    const file = path.join(tmpRoot, "doc.pdf");
    await fs.writeFile(file, Buffer.from("%PDF"));

    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(fakeDocument({ numPages: 1, pageTexts: ["x"] })),
    });

    expect(mockGlobalWorkerOptions.workerSrc).toBeUndefined();
    await loadPdf(file);
    expect(mockGlobalWorkerOptions.workerSrc).toBe("");
  });
});

describe("loadPdf — extraction", () => {
  it("concatenates text from all pages with blank-line separators", async () => {
    const file = path.join(tmpRoot, "doc.pdf");
    await fs.writeFile(file, Buffer.from("%PDF"));

    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(
        fakeDocument({
          numPages: 3,
          pageTexts: ["page one", "page two", "page three"],
        })
      ),
    });

    const out = await loadPdf(file);
    expect(out.text).toBe("page one\n\npage two\n\npage three");
  });

  it("returns empty text for a 0-page document (does NOT throw)", async () => {
    const file = path.join(tmpRoot, "empty.pdf");
    await fs.writeFile(file, Buffer.from("%PDF"));

    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(fakeDocument({ numPages: 0, pageTexts: [] })),
    });

    const out = await loadPdf(file);
    expect(out.text).toBe("");
  });

  it("attaches pages count + info to metadata", async () => {
    const file = path.join(tmpRoot, "doc.pdf");
    await fs.writeFile(file, Buffer.from("%PDF"));

    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(
        fakeDocument({
          numPages: 5,
          pageTexts: ["", "", "", "", ""],
          info: { Title: "Annual Report", Author: "Test" },
        })
      ),
    });

    const out = await loadPdf(file);
    expect(out.metadata.type).toBe("pdf");
    expect(out.metadata.pages).toBe(5);
    expect(out.metadata.info).toEqual({ Title: "Annual Report", Author: "Test" });
    expect(out.metadata.source).toBe(file);
  });

  it("propagates parser errors (caller's loaders/index catches them)", async () => {
    const file = path.join(tmpRoot, "broken.pdf");
    await fs.writeFile(file, Buffer.from("not a pdf"));

    // The rejection MUST be lazy: `Promise.reject()` at object-construction
    // time is "unhandled" until something awaits it, and vitest's parallel
    // worker reports that as a failed run even when the rejection IS later
    // awaited. A getter creates the rejected promise the first time
    // `.promise` is read, which is exactly when `loadPdf` awaits it — the
    // rejection is handled in the same tick.
    mockGetDocument.mockReturnValue({
      get promise() {
        return Promise.reject(new Error("InvalidPDFException"));
      },
    });

    await expect(loadPdf(file)).rejects.toThrow(/InvalidPDFException/);
  });
});
