/**
 * Lightweight schema-version stamping for the JSON-on-disk store.
 *
 * NOT a migration engine (deliberately — over-engineering for a solo local
 * tool; see the data-backup rationale in storage/backup.ts). This is a single
 * version stamp + a defensive read check:
 *
 *  - On WRITE, `stampSchemaVersion(record)` tags the serialized object with the
 *    current schema version.
 *  - On READ, `warnIfFutureSchema(record, label)` detects a record written by a
 *    NEWER build than this one (`schemaVersion > CURRENT`) and warns LOUDLY.
 *    That is the dangerous direction: the older code understands fewer fields,
 *    so a subsequent save silently drops the newer ones (a lossy downgrade
 *    round-trip). The OLDER direction (`schemaVersion < CURRENT`, or absent on
 *    pre-stamp files) is normal forward-compat — handled silently, since the
 *    typed loaders already treat new fields as optional.
 *
 * The stamp is a PERSISTENCE-ENVELOPE field, not part of the domain types — it
 * lives only in the on-disk JSON. (chat-store's Zod `ChatSchema` strips it on
 * read; settings-store strips it explicitly.) Recovery from a detected
 * downgrade is the operator's `data-backups/` (storage/backup.ts), NOT an
 * auto-migration — by design.
 *
 * **When to bump `CURRENT_SCHEMA_VERSION`:** only on a BACKWARD-INCOMPATIBLE
 * change — a field renamed, removed, or re-typed such that an older build would
 * mishandle it (drop it, crash, or misinterpret). Purely ADDITIVE optional
 * fields do NOT need a bump; they're forward-compatible by construction.
 */

export const CURRENT_SCHEMA_VERSION = 1;

const VERSION_KEY = "schemaVersion";

/** Tag a record with the current schema version for serialization. */
export function stampSchemaVersion<T extends object>(
  record: T
): T & { schemaVersion: number } {
  return { ...record, [VERSION_KEY]: CURRENT_SCHEMA_VERSION } as T & {
    schemaVersion: number;
  };
}

/** Read the stamped version off a parsed record (undefined on pre-stamp files). */
export function readSchemaVersion(record: unknown): number | undefined {
  if (record && typeof record === "object" && VERSION_KEY in record) {
    const v = (record as Record<string, unknown>)[VERSION_KEY];
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}

/**
 * Loud-warn when a parsed record is from a FUTURE schema (a newer build wrote
 * it). Returns `true` if from-future. Never throws — purely advisory; the
 * operator restores from `data-backups/` if a downgrade actually dropped
 * fields. Safe to call on every read.
 */
export function warnIfFutureSchema(record: unknown, label: string): boolean {
  const v = readSchemaVersion(record);
  if (v !== undefined && v > CURRENT_SCHEMA_VERSION) {
    console.warn(
      `[schema] ${label} was written by a NEWER Orchestra schema ` +
        `(v${v} > v${CURRENT_SCHEMA_VERSION}). You appear to be running an OLDER build. ` +
        `Saving may DROP fields this build doesn't understand — restore from ` +
        `data-backups/ before continuing if that data matters.`
    );
    return true;
  }
  return false;
}
