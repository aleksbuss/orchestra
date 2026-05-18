/**
 * Tests for `loadText` — the simplest loader, used as a fallback for
 * 12+ extensions (.txt, .md, .json, .csv, ...). A regression here means
 * none of those formats can be ingested into the knowledge base.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadText } from "./text-loader";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-textloader-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("loadText", () => {
  it("reads UTF-8 content verbatim", async () => {
    const file = path.join(tmpRoot, "doc.txt");
    await fs.writeFile(file, "Hello, world!\nLine 2", "utf-8");

    const out = await loadText(file);
    expect(out.text).toBe("Hello, world!\nLine 2");
  });

  it("preserves Cyrillic / multi-byte content (no encoding clobber)", async () => {
    const file = path.join(tmpRoot, "doc.txt");
    const cyrillic = "Привет, 你好, مرحبا, 🎉";
    await fs.writeFile(file, cyrillic, "utf-8");

    const out = await loadText(file);
    expect(out.text).toBe(cyrillic);
  });

  it("attaches source path + type='text' to metadata", async () => {
    const file = path.join(tmpRoot, "doc.md");
    await fs.writeFile(file, "# Title", "utf-8");

    const out = await loadText(file);
    expect(out.metadata.source).toBe(file);
    expect(out.metadata.type).toBe("text");
  });

  it("returns empty text for an empty file (does NOT throw)", async () => {
    const file = path.join(tmpRoot, "empty.txt");
    await fs.writeFile(file, "", "utf-8");

    const out = await loadText(file);
    expect(out.text).toBe("");
  });

  it("propagates ENOENT for a missing file (caller is responsible for fallback)", async () => {
    await expect(
      loadText(path.join(tmpRoot, "no-such.txt"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
