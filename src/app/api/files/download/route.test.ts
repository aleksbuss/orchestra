/**
 * PM #6 regression — path traversal on GET /api/files/download.
 *
 * Same bug class as DELETE /api/files: this route inlined a broken
 * `startsWith(workDir)` guard (no `path.sep` suffix) and accepted sibling-
 * prefix paths. Read-paths are arguably *more* sensitive than write-paths
 * because they let an attacker exfiltrate any file the server can read,
 * including `data/settings/settings.json` (which carries the auth hash).
 *
 * The fix migrated this route to `assertPathInside`. Tests below lock the
 * invariant in: classic `..` traversal AND sibling-prefix bypass must both
 * 403, while a benign in-sandbox file downloads with 200.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/project-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storage/project-store")>(
    "@/lib/storage/project-store"
  );
  return {
    ...actual,
    getWorkDir: vi.fn(),
  };
});

import { GET } from "./route";
import { getWorkDir } from "@/lib/storage/project-store";

let tmpRoot: string;
let workDir: string;
let evilDir: string;
let secretFile: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-download-test-"));
  workDir = path.join(tmpRoot, "foo");
  evilDir = path.join(tmpRoot, "foo-evil");
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(evilDir, { recursive: true });
  secretFile = path.join(evilDir, "secrets.txt");
  await fs.writeFile(secretFile, "DO-NOT-LEAK", "utf-8");

  await fs.writeFile(path.join(workDir, "readme.txt"), "ok-to-download", "utf-8");

  vi.mocked(getWorkDir).mockReturnValue(workDir);
});

function downloadRequest(filePath: string): NextRequest {
  const url = new URL("http://localhost:3000/api/files/download");
  url.searchParams.set("project", "foo");
  url.searchParams.set("path", filePath);
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/files/download — PM #6 path traversal", () => {
  it("rejects classic ../../../etc/passwd traversal with 403", async () => {
    const res = await GET(downloadRequest("../../../../etc/passwd"));
    expect(res.status).toBe(403);
  });

  it("rejects sibling-prefix bypass — does NOT exfiltrate ../foo-evil/secrets.txt", async () => {
    const res = await GET(downloadRequest("../foo-evil/secrets.txt"));
    expect(res.status, "sibling-prefix path must be rejected").toBe(403);
    // The body must not contain the file's contents either.
    const body = await res.text();
    expect(body).not.toContain("DO-NOT-LEAK");
  });

  it("downloads a benign in-sandbox file with 200", async () => {
    const res = await GET(downloadRequest("readme.txt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment/);
    const body = await res.text();
    expect(body).toBe("ok-to-download");
  });
});
