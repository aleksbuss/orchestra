# Realtime (SSE) + AbortSignal Propagation Contracts

> Level 2 reference for [`CLAUDE.md`](../../CLAUDE.md). Moved **verbatim** 2026-08-02 — the text below is the original, unmodified.
> **Read this when:** touching SSE, useBackgroundSync, or any generate/stream/embed callsite

---

## 🔄 Realtime & Frontend Resilience Contract

The frontend runs a **single shared `EventSource`** per tab (`src/hooks/use-background-sync.ts`). The SSE bus is fire-and-forget — it has no replay buffer, so any event missed during a network blink is gone. The disk JSON in `data/chats/<id>.json` is the source of truth; the frontend must reconcile against it after every gap.

**Already implemented (do not regress):**
- **Single connection invariant** — never instantiate `new EventSource(...)` in components. Browsers cap at 6 HTTP/1.1 connections per origin; one runaway component takes down the bus. Always go through `useBackgroundSync`. **CI-enforced** by [`frontend-invariants.test.ts`](src/components/frontend-invariants.test.ts), which fails the build on any `new EventSource` outside `use-background-sync.ts` (tree-wide scan — no file list to drift).
- **Subscribe-time debounce** — 1-second teardown delay on the shared `EventSource` to absorb React Strict Mode unmount/mount cycles (see `use-background-sync.ts`, search for `debounce for React Strict Mode`).
- **`EventSource.onerror` recovery** — exponential backoff (1s → 15s, capped) recreates the socket once the browser gives up retrying (`readyState === CLOSED`). Implemented in `ensureSharedEventSource()` + `scheduleReconnect()`.
- **Visibility/focus resync** — `visibilitychange === "visible"` and `window.focus` call `ensureSharedEventSource()`, which is idempotent on healthy connections and forces a fresh socket if the previous one was dropped while the tab was hidden.
- **Synthetic resync broadcast** — on every `ready` event from the server (initial connect or post-reconnect), the hook fans out a synthetic `{ topic: "global", reason: "reconnect-resync" }` event to all subscribers. This bumps `syncTick`, and consumers like `chat-panel.tsx` already refetch `GET /api/chat/history?id=<chatId>` on tick changes — reconciliation against the canonical on-disk JSON is automatic. See PM #5 for the bug this prevents.

**Regression coverage for PM #5 — closed at two layers:**
- **Unit** ([`src/hooks/use-background-sync.dom.test.tsx`](src/hooks/use-background-sync.dom.test.tsx)) — 9 happy-dom tests pin every branch of the fix: single shared EventSource, server `ready` → broadcast → tick bump on ALL subscribers (regardless of topic — the Defect #1 bypass), regular sync events still respect scope, `visibilitychange === "visible"` and `window.focus` both force immediate reconnect + tick bump, CLOSED EventSource on visibility return triggers fresh connection, `onerror` doesn't crash the React tree.
- **Browser smoke** ([`tests/e2e/pm-5-visibility-resync.spec.ts`](tests/e2e/pm-5-visibility-resync.spec.ts)) — 4 Playwright tests verify the browser-level primitives the fix depends on are intact: `EventSource` constructor available, `visibilitychange` + `focus` events dispatchable without breaking the page, `/api/events` rejects anonymous requests with 401, EventSource against a rejected endpoint doesn't explode.

**Future enhancement (tracked separately):**
- **Stream watchdog** — if a chat is locally marked `running` and no SSE event arrives for ~30s, force a resync. Useful for the case where SSE *appears* alive but events are silently dropped between server emit and client receive. Not yet implemented; add when there is concrete evidence of need.
- **Full end-to-end regression for PM #5** — long generation + mid-stream visibility toggle + assert final message renders. Requires deterministic LLM mocking infrastructure (test-only API route). Deferred; the unit + browser-smoke layers above cover the actual fix logic.

---

## 🛑 AbortSignal Propagation Contract

PM #1 was a P0 outage caused by zombie streams. The contract that prevents recurrence:

```ts
// src/app/api/chat/route.ts (canonical pattern)
export async function POST(req: Request) {
  return runAgent({
    /* ...inputs */,
    abortSignal: req.signal, // MUST be req.signal, not a new AbortController
  });
}
```

- Every `generateText` call receives `abortSignal`. **Every `generateObject`, `streamText`, AND `embed`/`embedMany` call too** (PM #23 — the original contract said "generateText"; the inner Router uses `generateObject`, which silently leaked for six months. QA audit F-12/F-13 — `embedTexts` wrapping `embed`/`embedMany` for RAG, disagreement detection, and trace few-shots was a *second* blind spot: the embedding HTTP request ran to completion after an abort, and the audit grep below didn't even check for it).
- Every tool implementation receives and respects `abortSignal` (long `fetch`, child processes, sleeps).
- Every iteration of `src/lib/agent/daemon.ts` and `src/lib/cron/runtime.ts` checks `signal.aborted` between hops.
- Background tasks that outlive a single request use a **separate `AbortController`** owned by `daemon.ts`, NOT `req.signal` — the request finishes, but the daemon keeps running. This is the one exception.

**Pre-merge audit (PM #23) — now a CI gate, not a hand-run grep.** [`abort-contract.test.ts`](src/lib/agent/abort-contract.test.ts) runs the bracket-balanced scan below over EVERY non-test file under `src/` and fails the build on any generate/stream/embed callsite missing `abortSignal`. It scans the whole tree precisely because a hardcoded file list drifts: F-13 caught `blackboard.ts` outside the list, and standing the gate up caught three MORE unlisted callers (`agent-response.ts`, `tournament-aggregator.ts`, `web-task.ts`). The Node variant below is the same logic, kept for a quick local spot-check on the legacy file set:
```bash
for f in src/lib/agent/agent.ts src/lib/agent/moa.ts src/lib/agent/compressor.ts src/lib/agent/reflection.ts src/lib/agent/moa-router.ts src/lib/memory/embeddings.ts src/lib/memory/blackboard.ts; do
  node -e "
    const fs = require('fs');
    const src = fs.readFileSync('$f', 'utf8').split('\n');
    let inCall=false, depth=0, callStart=0, hasSignal=false, total=0, missing=[];
    for (let i=0; i<src.length; i++) {
      const L = src[i];
      if (!inCall && /(await\s+generateText|await\s+generateObject|streamText|await\s+embedMany|await\s+embed)\s*\(/.test(L)) {
        inCall=true; depth=0; callStart=i+1; hasSignal=false; total++;
      }
      if (inCall) {
        if (/abortSignal/.test(L)) hasSignal=true;
        for (const c of L) {
          if (c==='(') depth++;
          else if (c===')') { depth--; if (depth===0) { if (!hasSignal) missing.push(callStart); inCall=false; break; } }
        }
      }
    }
    console.log('$f: total=' + total + ', missing=' + missing.length + (missing.length ? ' at L' + missing.join(',L') : ''));
  "
done
```
These seven are the legacy spot-check list, but the **source of truth is `abort-contract.test.ts`, which scans all of `src/`** — so a new callsite in a new file is covered automatically, with nothing to keep in sync. Today's real surface is ~10 files (the seven + `agent-response.ts`, `tournament-aggregator.ts`, `web-task.ts`); all must report `missing=0`. The fixed list drifted twice (blackboard via F-13; the three extras via the F-21 gate) — which is why the gate scans the tree, not a list. Lesson: scope abort audits to the SDK primitive (`embed`/`embedMany`/`generate*`), tree-wide, not a hand-maintained file list or a single in-house wrapper.

**PM #23 closed (2026-05-28 audit):** both `runAgentText` ([agent.ts:1833](src/lib/agent/agent.ts#L1833)) and `runSubordinateAgent` ([agent.ts:1992](src/lib/agent/agent.ts#L1992)) accept `abortSignal?: AbortSignal` and plumb it into their inner `generateText` calls. Callers (`cron/service.ts`, `external/handle-external-message.ts`, `tools/call-subordinate.ts`) thread the appropriate signal — daemon's `AbortController` for cron, `req.signal` for the rest. Don't reintroduce the gap.

**QA audit F-12/F-13 closed (2026-06-14):** `embedTexts` ([embeddings.ts](src/lib/memory/embeddings.ts)) now accepts `options.abortSignal` and forwards it to `embed`/`embedMany` (+ a `throwIfAborted()` short-circuit and a raw re-throw on abort so cancellation stays distinguishable from a provider error). In-loop callers thread the signal: `detectDisagreement` (was silently dropping it as `_abortSignal`), the MoA reflection convergence check, and `runAgent`'s RAG search + history-archive insert. `searchMemory`/`insertMemory`/`insertManyMemories` gained an optional trailing `abortSignal`. A skeptical re-audit then caught a SECOND family of embed calls the first pass missed: **`blackboard.ts` calls the SDK `embed()` directly** (write_fact/search_facts tools), bypassing `embedTexts` entirely — now fixed with its own `abortSignal` param threaded from `tool.ts`. Lower-frequency callers where the param now exists but the signal isn't yet threaded (incremental follow-up, NOT a regression): the `memory_save`/`memory_load` tool wrappers, bulk knowledge import, and the fire-and-forget trace capture. The audit grep + file list above were extended to `embed`/`embedMany` so this surface can't silently regress again. Regression tests: [`embeddings.test.ts`](src/lib/memory/embeddings.test.ts) (forwarding + already-aborted short-circuit + raw re-throw), [`disagreement.test.ts`](src/lib/agent/disagreement.test.ts) (forwards to `embedTexts`).

If you cannot answer "what cancels this stream?" you MUST NOT merge the change.

---

