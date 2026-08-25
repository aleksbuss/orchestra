/**
 * Structural gate — a route that hands a user-supplied chat id to the chat
 * store must validate it at the ROUTE layer first.
 *
 * Non-negotiable #2 requires `assertPathInside` on any user-supplied path
 * fragment "at the route layer AND pushed down into the library that does the
 * `fs.*` call". The chat store holds up its half: `chatFilePath()` guards
 * `<chatId>.json` against `CHATS_DIR` and its own comment tells callers to
 * "treat this as a hard error and 400 the request".
 *
 * Three route handlers did not. `getChat` / `deleteChat` call `chatFilePath`
 * outside any try/catch of their own, so a url-encoded traversal id threw
 * straight out of the handler and Next answered **500 with an empty body**:
 *
 *   GET  /api/debug/chat/..%2f..%2f..%2fetc%2fpasswd   → 500
 *   GET  /api/chat/history?id=..%2f..%2f..%2fetc%2fpasswd  → 500
 *   DELETE /api/chat/history?id=..%2f..%2f..%2fetc%2fpasswd → 500  ← a delete path
 *
 * No traversal ever happened — the guard is what threw, which is the system
 * working. What was broken is that a rejected input reported as a server fault,
 * and three handlers silently opted out of a rule the repo calls non-negotiable.
 *
 * A "did you remember the guard?" review is the control that gets skipped, so
 * this is a gate instead — same posture as `agent-preflight-gate.test.ts` and
 * `abort-contract.test.ts`. It scans the tree rather than a file list, so a new
 * route is covered the day it is written.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = "src/app/api";

/**
 * Routes that call the store with an id the CLIENT never supplies.
 *
 * Both were flagged when this gate first ran, and both were checked by hand
 * before being exempted rather than after. Add an entry only with a reason of
 * this shape — "where does the id come from, and who can influence it?"
 */
const ALLOWLIST = new Map<string, string>([
  [
    path.normalize("src/app/api/integrations/telegram/route.ts"),
    // The id is `session.activeChats[projectKey]` — written by this same route
    // from `crypto.randomUUID()` — or a fresh UUID when that lookup misses. No
    // request field reaches it. (The Telegram *chat* id in the update payload is
    // a number used for reply addressing, never as a filename.)
    "id comes from server-side session state or crypto.randomUUID(), never from the request",
  ],
  [
    path.normalize("src/app/api/projects/[id]/export/route.ts"),
    // `getChat(ref.id)` where `ref` is a row from the on-disk chat index, and
    // the call already carries `.catch(() => null)` — a throw is handled, not
    // propagated to a 500.
    "id comes from the chat index and the call is already .catch()-wrapped",
  ],
]);

/** Named import of a chat-store function that resolves a path from an id. */
const PATH_RESOLVING_IMPORT_RE =
  /import\s*\{[^}]*\b(getChat|deleteChat)\b[^}]*\}\s*from\s*["']@\/lib\/storage\/chat-store["']/;

/** The route-layer guard that must accompany it. */
const GUARD_IMPORT_RE =
  /import\s*\{[^}]*\bisValidChatId\b[^}]*\}\s*from\s*["']@\/lib\/storage\/chat-store["']/;

const GUARD_CALL_RE = /\bisValidChatId\s*\(/;

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRouteFiles(full));
    } else if (entry.name === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

describe("chat-id guard contract — a route must 400 a bad id, not 500", () => {
  const files = collectRouteFiles(ROOT);

  it("finds route files to scan (the scan itself must not silently pass on zero)", () => {
    // An empty glob is the classic way a structural gate degrades in the
    // passing direction. Assert the instrument found something first.
    expect(files.length).toBeGreaterThan(30);
  });

  it("every route that imports getChat/deleteChat also imports isValidChatId", () => {
    const offenders = files.filter((file) => {
      if (ALLOWLIST.has(path.normalize(file))) return false;
      const source = fs.readFileSync(file, "utf-8");
      if (!PATH_RESOLVING_IMPORT_RE.test(source)) return false;
      return !GUARD_IMPORT_RE.test(source);
    });

    expect(
      offenders,
      `These routes pass a user-supplied chat id to the store without the route-layer guard.\n` +
        `Import \`isValidChatId\` from "@/lib/storage/chat-store" and return 400 when it is false:\n` +
        offenders.map((f) => `  - ${f}`).join("\n")
    ).toEqual([]);
  });

  it("every route that imports the guard actually calls it", () => {
    const importedButUnused = files.filter((file) => {
      const source = fs.readFileSync(file, "utf-8");
      if (!GUARD_IMPORT_RE.test(source)) return false;
      // Strip the import line itself before looking for a call.
      const body = source.replace(GUARD_IMPORT_RE, "");
      return !GUARD_CALL_RE.test(body);
    });

    expect(
      importedButUnused,
      `These routes import the guard but never call it — an import is not a check:\n` +
        importedButUnused.map((f) => `  - ${f}`).join("\n")
    ).toEqual([]);
  });

  it("the routes the audit found are covered (mutation check on the gate itself)", () => {
    // Pins the gate against a regex that rots into matching nothing: if the
    // patterns break, this fails rather than the suite going quietly green.
    const covered = files.filter((file) =>
      GUARD_IMPORT_RE.test(fs.readFileSync(file, "utf-8"))
    );
    expect(covered.map((f) => path.normalize(f)).sort()).toEqual(
      [
        path.normalize("src/app/api/chat/route.ts"),
        path.normalize("src/app/api/chat/history/route.ts"),
        path.normalize("src/app/api/debug/chat/[id]/route.ts"),
      ].sort()
    );
  });

  it("every allowlisted route still imports the store — a stale exemption is a lie", () => {
    // If a route stops touching the chat store, its exemption is dead weight
    // that will silently cover a future re-introduction. Fail instead.
    const stale = [...ALLOWLIST.keys()].filter((file) => {
      if (!fs.existsSync(file)) return true;
      return !PATH_RESOLVING_IMPORT_RE.test(fs.readFileSync(file, "utf-8"));
    });
    expect(
      stale,
      `Allowlisted routes that no longer import getChat/deleteChat — remove the entry:\n` +
        stale.map((f) => `  - ${f}`).join("\n")
    ).toEqual([]);
  });
});
