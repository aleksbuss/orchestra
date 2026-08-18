# Observability Runbook

> Level 2 reference for [`CLAUDE.md`](../../CLAUDE.md). Moved **verbatim** 2026-08-02 — the text below is the original, unmodified.
> **Read this when:** a chat appears stuck, a chat vanished from the sidebar, or you need to reconstruct what happened in a run

---

## 🔭 Observability

There is no APM. Reconstructing what happened requires reading three things:

1. **Server stdout** — `npm run dev` writes everything to the terminal. For retroactive grep, run as `npm run dev 2>&1 | tee logs/dev-$(date +%F).log`. Logs are NOT shipped anywhere by default.
2. **`data/chats/<chatId>.json`** — the canonical chat state. If the file contains a complete assistant message but the user reports an empty response, the bug is in the frontend resync path (PM #5), not the backend.
3. **`/api/events` SSE stream** — `curl -N "http://localhost:3000/api/events?topic=chat&chatId=<id>"` to verify the bus is alive and what events the server is emitting. An immediate `event: ready` confirms the endpoint is healthy.

**Recommended postmortem checklist when a chat appears stuck:**
- **First command — one-shot diagnostic (PM #31):**
  ```bash
  curl -s --cookie "$(cat ~/.orchestra-cookie 2>/dev/null)" \
    http://localhost:3000/api/debug/chat/<chatId> | jq
  ```
  Returns `{ diskState, recentLogs, sseBusHealthy, activeJob, uptimeSec }` in one shot — replaces the four manual steps below for ~95% of cases. (Requires a session cookie; if you don't have one, log into the dashboard once and copy `orchestra_auth` out of dev-tools.)
- **Fallback manual steps** (use when the route is unreachable — server down, no session, or to corroborate the diagnostic):
  - `ps aux | grep next-server` → is the server even alive?
  - `curl -s -o /dev/null -w "%{http_code} %{time_total}\n" http://localhost:3000/` → does it respond?
  - Inspect the latest `data/chats/*.json` — look at the last message's `parts`, `status`, `finishReason`. A clean message with no pending parts means the backend finished; the bug is on the wire (PM #5).
  - `lsof -i :3000` → are SSE connections still open?
  - `curl -N "http://localhost:3000/api/events?topic=chat&chatId=<id>"` → bus health probe; immediate `event: ready` is the all-clear.

**When a chat reportedly "disappeared from the sidebar" (PM #30):**
- `curl http://localhost:3000/api/health | jq '.subsystems[] | select(.name == "chat_index_integrity")'` → if status is `warn`, the detail string names every chat file that failed to parse during the last index rebuild.
- `grep chat_index_broken_file data/logs/*.jsonl` (or stdout of `npm run dev`) → finds every skip with filename, size, and parse error.
- The corrupt file is still on disk under `data/chats/<id>.json` — usually a partial-write artifact from a crash mid-flush. The pending writes that survived are in `data/logs/` if structured logging was enabled before the crash. Hand-repair or accept the loss; the next `rebuildChatIndex` drops repaired files from the broken registry automatically.

---

