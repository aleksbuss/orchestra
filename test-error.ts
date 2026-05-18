import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const google = createGoogleGenerativeAI({ apiKey: "" });
async function test() {
  try {
    await generateText({ model: google("gemini-1.5-flash"), prompt: "hello" });
  } catch (e) {
    if (e instanceof Error) console.log(e.message);
  }
}
test();
