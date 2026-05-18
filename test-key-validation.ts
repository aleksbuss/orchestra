import { createModel } from "./src/lib/providers/llm-provider";

try {
  createModel({ provider: "google", model: "gemini-2.5-pro", authMethod: "api_key", apiKey: "" });
  console.log("FAIL: Expected an error!");
} catch (e: any) {
  console.log("SUCCESS: Caught error ->", e.message);
}
