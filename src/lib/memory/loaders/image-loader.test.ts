/**
 * Tests for `loadImage` — wraps `tesseract.js` for OCR. The worker-spawn
 * path is mocked so tests are fast + don't require the bundled
 * traineddata files.
 *
 * Pinned invariants:
 *   - Reads file as a Buffer and feeds it to tesseract.recognize.
 *   - The `workerPath` points inside `node_modules/tesseract.js/...`
 *     (the loader file comments say require.resolve doesn't work under
 *     Next's RSC bundler — the explicit cwd-based path is the workaround).
 *   - The worker is ALWAYS terminated (cleanup), even on recognize error.
 *   - Output text is trimmed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const mockTerminate = vi.fn().mockResolvedValue(undefined);
const mockRecognize = vi.fn();
const mockCreateWorker = vi.fn();

vi.mock("tesseract.js", () => ({
  createWorker: (...args: unknown[]) => mockCreateWorker(...args),
}));

import { loadImage } from "./image-loader";

let tmpRoot: string;

function fakeWorker() {
  return { recognize: mockRecognize, terminate: mockTerminate };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-imageloader-"));
  vi.clearAllMocks();
  mockCreateWorker.mockResolvedValue(fakeWorker());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("loadImage", () => {
  it("calls createWorker with 'eng' lang + workerPath under node_modules/tesseract.js", async () => {
    const file = path.join(tmpRoot, "page.png");
    await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    mockRecognize.mockResolvedValue({ data: { text: "hello" } });

    await loadImage(file);

    expect(mockCreateWorker).toHaveBeenCalledOnce();
    const [lang, oem, opts] = mockCreateWorker.mock.calls[0];
    expect(lang).toBe("eng");
    expect(oem).toBe(1);
    expect(opts.workerPath).toContain(
      path.join("node_modules", "tesseract.js", "src", "worker-script", "node", "index.js")
    );
  });

  it("passes the file's BUFFER to recognize (not the path)", async () => {
    const file = path.join(tmpRoot, "page.png");
    await fs.writeFile(file, Buffer.from([0xff, 0xd8, 0xff])); // JPEG-ish magic

    mockRecognize.mockResolvedValue({ data: { text: "ocr-result" } });

    await loadImage(file);
    const arg = mockRecognize.mock.calls[0][0];
    expect(Buffer.isBuffer(arg)).toBe(true);
  });

  it("returns trimmed OCR text + image-typed metadata", async () => {
    const file = path.join(tmpRoot, "scan.png");
    await fs.writeFile(file, Buffer.from([0x89]));

    mockRecognize.mockResolvedValue({ data: { text: "  scanned text  \n\n" } });

    const out = await loadImage(file);
    expect(out.text).toBe("scanned text");
    expect(out.metadata).toEqual({
      source: file,
      type: "image",
    });
  });

  it("ALWAYS terminates the worker, even when recognize throws", async () => {
    const file = path.join(tmpRoot, "scan.png");
    await fs.writeFile(file, Buffer.from([0x89]));

    mockRecognize.mockRejectedValue(new Error("tesseract crashed"));

    await expect(loadImage(file)).rejects.toThrow(/tesseract/);
    // Worker termination is what releases the trained-data file handle.
    // Forgetting it leaks file descriptors across many uploads.
    expect(mockTerminate).toHaveBeenCalledOnce();
  });

  it("terminates the worker exactly once on the happy path too", async () => {
    const file = path.join(tmpRoot, "scan.png");
    await fs.writeFile(file, Buffer.from([0x89]));
    mockRecognize.mockResolvedValue({ data: { text: "ok" } });

    await loadImage(file);
    expect(mockTerminate).toHaveBeenCalledOnce();
  });
});
