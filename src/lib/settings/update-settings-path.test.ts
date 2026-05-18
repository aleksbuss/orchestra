import { describe, it, expect } from "vitest";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import type { AppSettings } from "@/lib/types";

// Minimal mock settings for testing
const BASE_SETTINGS: AppSettings = {
  chatModel: {
    provider: "openai",
    model: "gpt-4o",
    authMethod: "api_key",
    temperature: 0.7,
    maxTokens: 4096,
  },
  utilityModel: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.3,
    maxTokens: 2048,
  },
  embeddingsModel: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  codeExecution: { enabled: true, timeout: 600, maxOutputLength: 120000 },
  memory: { enabled: true, similarityThreshold: 0.35, maxResults: 10, chunkSize: 400 },
  search: { enabled: false, provider: "none" },
  general: { darkMode: false, language: "en" },
  auth: { enabled: true, username: "admin", passwordHash: "hash", mustChangeCredentials: true },
};

describe("updateSettingsByPath", () => {
  it("should update a top-level nested field", () => {
    const updated = updateSettingsByPath(BASE_SETTINGS, "general.darkMode", true);
    expect(updated.general.darkMode).toBe(true);
    expect(BASE_SETTINGS.general.darkMode).toBe(false); // Original not mutated
  });

  it("should update deeply nested fields", () => {
    const updated = updateSettingsByPath(BASE_SETTINGS, "chatModel.temperature", 0.2);
    expect(updated.chatModel.temperature).toBe(0.2);
  });

  it("should update a string field", () => {
    const updated = updateSettingsByPath(BASE_SETTINGS, "chatModel.model", "gpt-5");
    expect(updated.chatModel.model).toBe("gpt-5");
  });

  it("should handle single-level paths", () => {
    // This would add a new top-level key (unusual but should not crash)
    const updated = updateSettingsByPath(BASE_SETTINGS, "newKey", "value");
    expect((updated as any).newKey).toBe("value");
  });

  it("should return settings unchanged for empty path", () => {
    const updated = updateSettingsByPath(BASE_SETTINGS, "", "value");
    expect(updated).toEqual(BASE_SETTINGS);
  });

  it("should create intermediate objects if needed", () => {
    const updated = updateSettingsByPath(BASE_SETTINGS, "deep.nested.value", 42);
    expect((updated as any).deep.nested.value).toBe(42);
  });

  it("should not mutate the original settings object", () => {
    const original = structuredClone(BASE_SETTINGS);
    updateSettingsByPath(BASE_SETTINGS, "chatModel.model", "changed");
    expect(BASE_SETTINGS).toEqual(original);
  });
});
