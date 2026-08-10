/**
 * FRESH-INSTALL DRILL — the journey a first-time user actually takes.
 *
 * WHY THIS FILE EXISTS. PM #99 made every fresh install 100% unusable: a key
 * stored in Settings → API Keys Vault never reached the agent, so the first
 * turn died with "API Key is missing" — an error telling you to do the thing
 * you had just done. 3878 unit tests, a full CI pipeline and months of daily
 * use all missed it, because a developer machine has the key in `.env.local`
 * and `createModel`'s environment fallback silently covers for the broken
 * vault path. The bug was found by a human installing the app cold.
 *
 * The existing e2e could not have caught it either. `send-message.spec.ts`
 * declares LLM response content out of scope precisely because it "depends on
 * whether an API key is present — would be flaky in any CI", so the suite
 * stopped one step short of the thing that broke.
 *
 * HOW THIS CLOSES IT WITHOUT A VENDOR. The drill points the brain at a local
 * OpenAI-compatible STUB and stores the key ONLY in the vault. That buys three
 * things at once:
 *   - determinism: the answer is whatever the stub says, so response content
 *     becomes assertable instead of flaky;
 *   - no network, no cost, no secret in CI;
 *   - the machine's own environment becomes IRRELEVANT — `custom` has no env
 *     key to fall back to, so the vault is the only possible source. The
 *     confound that hid PM #99 cannot hide it here.
 *
 * The assertion that matters is on the STUB's `Authorization` header. Asserting
 * merely that the turn "did not error" would pass just as well if the key
 * arrived from somewhere else — which is exactly how this went unnoticed. It is
 * also the ONLY assertion that catches the regression on a `custom` provider:
 * that provider does not require a key, so a lost vault key does not throw, it
 * silently sends `Authorization: Bearer` with nothing after it. Mutation-
 * verified against the real PM #99 revert — the stub received exactly that.
 *
 * RUNS SERIALLY. Every spec shares one server and one settings file, and this
 * one has to repoint the brain, so it restores `chatModel` and `freeMode` when
 * it is done. Restoring is not enough under `fullyParallel`, where another spec
 * can read settings mid-drill — run the suite with `--workers=1`, which is what
 * CI already does.
 */
import { test, expect, request as pwRequest } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loginViaApi, BASE_URL, TEST_PASSWORD } from "./helpers";

/** The key exists ONLY in the vault. If it reaches the stub, the wiring works. */
const VAULT_ONLY_KEY = "sk-vault-only-4c1f2b";
/** Deterministic answer, so the assertion is on content rather than absence of error. */
const STUB_ANSWER = "FRESH_INSTALL_OK";

interface CapturedRequest {
  authorization: string | undefined;
  body: string;
}

/**
 * Minimal OpenAI-compatible chat-completions endpoint.
 *
 * Streams, because `/api/chat` runs through `streamText` and the provider asks
 * for SSE. Records every request so the test can assert what the server sent
 * rather than infer it from a happy outcome.
 */
function startStubProvider(captured: CapturedRequest[]): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured.push({ authorization: req.headers.authorization, body });

      if (!req.url?.includes("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "stub-1",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "stub-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant" }, null));
      res.write(chunk({ content: STUB_ANSWER }, null));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    // Port 0 = let the OS pick a free one; a hardcoded port collides with
    // whatever else the developer is running and turns into a phantom failure.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test.describe("fresh-install drill", () => {
  test("a key stored ONLY in the vault reaches the provider, and the turn answers", async () => {
    const captured: CapturedRequest[] = [];
    const stub = await startStubProvider(captured);

    try {
      // ── 1. Onboarding: default credentials, forced rotation ────────────
      // `loginViaApi` performs exactly what a first-time user is forced through
      // (admin/admin, then the mandatory credential change) and fails loudly if
      // that path breaks — which would itself brick a fresh install.
      await loginViaApi();

      const api = await pwRequest.newContext({ baseURL: BASE_URL });
      const login = await api.post("/api/auth/login", {
        data: { username: "admin", password: TEST_PASSWORD },
      });
      expect(login.status(), "post-onboarding login must succeed").toBe(200);

      // Every spec shares ONE server and ONE settings file. This drill has to
      // repoint the brain, so it must put back what it found or it breaks the
      // specs that rely on the seeded operator config. Only the two fields this
      // test changes are restored — the vault entry is a harmless leftover in a
      // throwaway dir, and re-writing a MASKED key readback would be worse than
      // leaving it.
      const before = await (await api.get("/api/settings")).json();
      const priorChatModel = before.chatModel;
      const priorFreeMode = before.freeMode ?? { enabled: false };

      // ── 2. Configure the way the UI does: key in the VAULT, not on the model ─
      // The model config deliberately carries NO apiKey. That is the shape the
      // model wizard writes, and the shape Free Mode's overlay produces.
      const settings = await api.put("/api/settings", {
        data: {
          providerApiKeys: { custom: VAULT_ONLY_KEY },
          chatModel: {
            provider: "custom",
            model: "stub-model",
            baseUrl: `http://127.0.0.1:${stub.port}/v1`,
          },
          // Explicitly OFF. `global-setup.ts` copies the OPERATOR'S real
          // settings.json into the isolated dir "so model-dependent specs have
          // working providers locally" — so a local e2e run is NOT a fresh
          // install, it inherits whatever the developer has configured. If
          // Free Mode happens to be on, its overlay REPLACES chatModel with a
          // free OpenRouter model at the agent chokepoint and the turn is
          // answered by a real vendor while the persisted settings still read
          // `custom`. That is what happened on the first run of this drill:
          // the settings assertions passed and a live model answered "pong".
          // The seeded config is exactly the confound that hid PM #99, so this
          // drill opts out of it instead of hoping it is absent.
          freeMode: { enabled: false },
        },
      });
      expect(settings.status(), "storing a vault key must succeed").toBe(200);

      // The API masks keys on read, so confirm the vault field exists rather
      // than comparing values — a masked readback proves it persisted.
      const readback = await (await api.get("/api/settings")).json();
      expect(readback.providerApiKeys?.custom, "vault key must persist").toBeTruthy();
      // The settings we WROTE must be the settings in force. Without this, a
      // silently-ignored write leaves the turn running on whatever the default
      // model is — which looks like a passing drill answered by a real vendor.
      expect(readback.chatModel?.provider, "brain provider must be the stub").toBe(
        "custom"
      );
      expect(readback.chatModel?.baseUrl, "brain must point at the stub").toContain(
        String(stub.port)
      );
      expect(
        readback.freeMode?.enabled,
        "Free Mode must be off, or its overlay silently replaces the brain"
      ).toBe(false);

      // ── 3. The first turn ──────────────────────────────────────────────
      const chat = await api.post("/api/chat", {
        data: {
          chatId: `drill-${Date.now()}`,
          message: "ping",
          swarmEnabled: false,
        },
        timeout: 60_000,
      });

      const responseText = await chat.text();
      expect(
        responseText,
        "PM #99: a vault-only key must not produce a missing-key error"
      ).not.toContain("API Key is missing");
      expect(chat.status(), "the first turn must not error").toBe(200);
      expect(responseText, "the stub's answer must reach the client").toContain(
        STUB_ANSWER
      );

      // ── 4. The assertion that actually pins PM #99 ─────────────────────
      // Everything above would still pass if the key had come from the
      // environment. This is the only step that says WHERE it came from.
      expect(captured.length, "the provider must have been called").toBeGreaterThan(0);
      const authHeaders = captured.map((c) => c.authorization);
      expect(
        authHeaders,
        "the vault key must arrive as the provider credential"
      ).toContain(`Bearer ${VAULT_ONLY_KEY}`);

      await api.put("/api/settings", {
        data: { chatModel: priorChatModel, freeMode: priorFreeMode },
      });
      await api.dispose();
    } finally {
      await stub.close();
    }
  });
});
