# Orchestra Observability

How the live Orchestra is observed and how an AI assistant (Claude Code) is wired into it.

This is the doc for the operator and for any future contributor who needs to debug a stuck chat, find why a Swarm crashed, or correlate a UI symptom to a server-side cause. The goal is **"under 60 seconds from `the chat broke` to `here is the trace id and here is the upstream 4xx that caused it`"**.

---

## What's wired up

### 1. Structured logger — `src/lib/observability/logger.ts`

JSON-per-line output to:

- **stdout** — captured by the Docker log driver, visible via `docker logs orchestra-app-1`. Always on.
- **`data/logs/orchestra-YYYY-MM-DD.jsonl`** — durable, JQ-friendly, daily-rotated. Enabled in production by `ORCHESTRA_LOG_TO_FILE=1` (set in `docker-compose.yml`). The MCP server below reads from these files.

Every line carries `{ts, level, event}` minimum, and `{traceId, chatId, projectId, module}` when an `withLogContext` block was active. Sensitive field names (`apiKey`, `passwordHash`, `token`, `secret`, `authorization`, `cookie`) are redacted at emit time.

Adding a new log line:

```ts
import { log } from "@/lib/observability/logger";

log.info("agent_started", { chatId, projectId, modelId });
log.error("upstream_failed", { err });        // Error → message + stack auto-lifted
```

### 2. Trace-id propagation

Every `POST /api/chat` request is wrapped in `withLogContext({ traceId, ... })`. The trace id is a UUID, and downstream `log.*` calls inside `runAgent`, MoA, tools, etc. carry it automatically (via `AsyncLocalStorage`).

- The trace id is exposed to the client as `X-Trace-Id` on the response, and embedded in every `chatError` SSE event (`src/lib/realtime/types.ts`).
- The chat-error banner in the UI (`src/components/chat/chat-error-banner.tsx`) renders a copy button next to the trace id so a user reporting "this broke" can paste exactly the right key into a bug report.

### 3. `/api/health` — structured probe

Active subsystem probes:

- `settings` — chat model is configured.
- `llm_provider` — provider's `/models` endpoint is reachable.
- `chat_model_tools` — currently-configured model permits tool calls (PM #17 startup probe).
- `daemon`, `event_bus`, `resource_guard`, `data_directory`.

Wire-format:

```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "subsystems": [{ "name": "...", "status": "ok|warn|error", "detail": "..." }, ...]
}
```

Docker `healthcheck` polls this every 10s.

### 4. `chat-error` SSE event

Server-side errors (`agent_stream_error` and `agent_fatal_error`) classify the upstream error and publish a structured payload over the existing `/api/events` SSE bus:

```ts
{
  traceId: "uuid",
  kind: "upstream_no_tools" | "upstream_rate_limit" | "upstream_4xx" | "upstream_5xx" | "abort" | "internal",
  message: "user-safe explanation",
  hint: "Switch to a tool-capable model in Settings → Models",
  recoverable: false
}
```

The UI subscribes via `useChatError(chatId)` and renders the structured banner. **No more "Swarm pропал в тишине."**

---

## MCP server — direct AI access (Sprint 4)

`scripts/mcp-orchestra-server.ts` is a stdio Model Context Protocol server that exposes Orchestra's logs, chats, and health to any MCP client (Claude Code, Cursor, etc.). It reads `data/logs/*.jsonl` and `data/chats/*.json` directly and calls `/api/health` over HTTP.

### Tools

| Tool | What it does |
|---|---|
| `orchestra_health` | Hit `/api/health` and return the JSON. First call in any incident. |
| `orchestra_tail_logs` | Recent structured log entries with filtering by `traceId`, `chatId`, `minLevel`, substring, time window. |
| `orchestra_recent_errors` | Newest-first warn+error entries from a tight default window (1h). |
| `orchestra_get_trace` | Every log line carrying a given `traceId` — the full server-side story of one chat turn. |
| `orchestra_get_chat` | The on-disk JSON for a chat (canonical state, see CLAUDE.md § 'Observability'). |
| `orchestra_list_chats` | Recent chats from the chat index, newest first. |

### Setup

1. Make sure `ORCHESTRA_LOG_TO_FILE=1` is set in your `docker-compose.yml` (Sprint 3 default). Without it the JSONL file doesn't exist and `tail_logs` returns nothing — only `orchestra_health` would still work via the HTTP probe.

2. Add to `~/.claude.json` (or your client's MCP config):

```json
{
  "mcpServers": {
    "orchestra": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/orchestra/scripts/mcp-orchestra-server.ts"]
    }
  }
}
```

   Optional env overrides:

   ```json
   "env": {
     "ORCHESTRA_DATA_DIR": "/path/to/data",
     "ORCHESTRA_HEALTH_URL": "http://localhost:3000/api/health"
   }
   ```

3. Restart your MCP client. The 6 `orchestra_*` tools should appear.

### Smoke test (no client required)

```bash
(
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  sleep 0.2
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 0.1
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 0.5
) | npx tsx scripts/mcp-orchestra-server.ts 2>/dev/null
```

You should see the `tools/list` response listing all six `orchestra_*` tools.

---

## The diagnostic loop (PM #17, retold post-Sprint-4)

The user reports: "Рой запускается, но потом всё пропадает."

Old loop (pre-Sprint-3):
1. Ask user for `docker logs --tail 400 orchestra-app-1` output.
2. User pastes it.
3. Grep for `error|MoA|generateText`.
4. Find the failure, but no way to correlate it to a specific chat.
5. Guess.

New loop (post-Sprint-4):
1. **Claude (in Claude Code) calls `orchestra_health`** — sees `chat_model_tools: warn` → already half the answer.
2. **Calls `orchestra_recent_errors`** — sees `agent_stream_error` with `kind: "upstream_no_tools"` and a trace id.
3. **Calls `orchestra_get_trace(traceId)`** — pulls the full timeline for that turn. Sees the MoA succeeded, then the `streamText` call to `qwen-2.5-coder` 404'd with the OpenRouter routing message.
4. **Tells the user**: "Switch to `openai/gpt-4o-mini` in Settings → Models. Trace id `xyz` if you need it for context."

The whole loop is one or two MCP calls. No `docker logs --tail` paste-bin dance. No grep guessing.

---

## Postmortem auto-dump + replay (Sprint 5)

When `runAgent` fails — either via the streamText `onError` path or the outer fatal `catch` — we write a single self-contained JSON file to `data/postmortems/<traceId>.json`. It carries:

- The sanitized request (user message, swarm flags, project, current path).
- A *secret-stripped* settings snapshot (provider/model intact, every key/hash dropped; provider-key PRESENCE listed as a string array).
- The structured `ChatErrorPayload` from the classifier.
- The raw error message + stack.
- Up to 200 recent log entries scoped to the trace id.
- A snapshot of `data/chats/<chatId>.json` at failure time (or null if missing/oversize, with a reason field).

The dump is **best-effort** — it never throws on its own writes, so a failed dump can never replace a successful chat-error event with a 500. If the trace id or chat id is malformed (path-traversal class), the dump quietly returns `null`.

### Replay harness

`src/lib/observability/replay.ts` reconstructs an upstream-error shape from each postmortem and re-classifies it. The vitest [`replay.test.ts`](../src/lib/observability/replay.test.ts) does this for every PM file on disk and asserts:

1. **No classifier drift** — today's classifier produces the same `kind` and `recoverable` flag as recorded. A drift means the classifier got better (update the PM) or got worse (regression — fix it).
2. **No secret leaks** — scans the persisted file for `scrypt$<salt>$<hash>` envelopes, `sk-…` / `sk-ant-…` / `AIza…` / `tvly-…` prefixes. The sanitizer is the primary guard; this scan is defense-in-depth.
3. **Schema version match** — early warning when the PM file shape changes incompatibly.

The live scan is `describe.skipIf(corpus.length === 0)` so a fresh checkout with no incidents is silent. Each captured failure becomes a permanent regression case at zero authoring cost.

### MCP tools (Sprint 4 + 5 = 9 tools total)

Adds three to the v1 set:

| Tool | What it does |
|---|---|
| `orchestra_list_postmortems` | Newest-first list of `{traceId, ts, kind, message}` for triage. |
| `orchestra_get_postmortem` | Full forensic file by trace id — request, settings, classification, logs, chat snapshot. |
| `orchestra_replay_postmortem` | Re-classifies the captured error against today's code; reports drift + scans for secret-shape leaks. |

---

## What's NOT yet covered (deliberate)

- **Live agent rerun** — the v5 replay rebuilds an *error shape* and pushes it through the classifier. It does NOT re-execute the actual chat turn against today's upstream provider — that would burn tokens, depend on rate-limit windows, and turn a deterministic regression test into a flaky one. The valuable invariant ("given THIS shape of upstream error, our handling stays correct") is what the harness pins down.
- **Frontend RTL component tests for the chat-error banner** — needs `@testing-library/react` + `jsdom` env in vitest. Pure logic of the banner (`styleForKind`, `pickChatErrorFromEvent`) is fully unit-tested in vitest today.
- **Integration tests for the MCP server's tools** — current coverage is the pure helpers (`log-query.test.ts`, `postmortem.test.ts`, `replay.test.ts`) plus a manual JSON-RPC smoke test. The MCP tool callbacks themselves are thin shells over the helpers; promote to integration tests once we have a stable MCP test harness.
