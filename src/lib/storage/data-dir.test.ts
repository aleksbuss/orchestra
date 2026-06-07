/**
 * PM #62 — the data root must be overridable via ORCHESTRA_DATA_DIR so tests /
 * E2E / throwaway dev runs isolate WITHOUT ever moving the real `data/`.
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { getDataDir, dataPath } from "./data-dir";

describe("getDataDir / dataPath (PM #62)", () => {
  const orig = process.env.ORCHESTRA_DATA_DIR;
  afterEach(() => {
    if (orig === undefined) delete process.env.ORCHESTRA_DATA_DIR;
    else process.env.ORCHESTRA_DATA_DIR = orig;
  });

  it("defaults to <cwd>/data when ORCHESTRA_DATA_DIR is unset", () => {
    delete process.env.ORCHESTRA_DATA_DIR;
    expect(getDataDir()).toBe(path.join(process.cwd(), "data"));
    expect(dataPath("chats", "x.json")).toBe(
      path.join(process.cwd(), "data", "chats", "x.json")
    );
  });

  it("honors an absolute ORCHESTRA_DATA_DIR", () => {
    process.env.ORCHESTRA_DATA_DIR = "/tmp/orchestra-iso";
    expect(getDataDir()).toBe("/tmp/orchestra-iso");
    expect(dataPath("settings", "settings.json")).toBe(
      "/tmp/orchestra-iso/settings/settings.json"
    );
  });

  it("resolves a relative ORCHESTRA_DATA_DIR against cwd", () => {
    process.env.ORCHESTRA_DATA_DIR = ".playwright-data";
    expect(getDataDir()).toBe(path.resolve(process.cwd(), ".playwright-data"));
  });

  it("falls back to the default for an empty / whitespace override", () => {
    process.env.ORCHESTRA_DATA_DIR = "   ";
    expect(getDataDir()).toBe(path.join(process.cwd(), "data"));
  });

  it("re-reads the env on each call (no cached module-load value)", () => {
    process.env.ORCHESTRA_DATA_DIR = "/tmp/a";
    expect(getDataDir()).toBe("/tmp/a");
    process.env.ORCHESTRA_DATA_DIR = "/tmp/b";
    expect(getDataDir()).toBe("/tmp/b");
  });
});
