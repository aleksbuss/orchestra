/**
 * Drift check for Free Mode's COLD-BOOT fallback lists.
 *
 * `FREE_ROUTER_FALLBACKS` / `FREE_GENERAL_FALLBACKS` are the ids Free Mode
 * seats when the live catalogue has not loaded. Nothing in the unit suite can
 * tell whether those ids still exist — OpenRouter withdraws free endpoints
 * without notice, and a withdrawn id only shows up as a cold-boot 404 on the
 * operator's machine. Three of the seven ids the list carried on 2026-09-12
 * had already been withdrawn upstream, and two of them had been stale since
 * before that.
 *
 * Run it whenever you touch either list, and periodically otherwise:
 *
 *     npm run verify:free-fallbacks
 *
 * Exits non-zero on any drift, so it can be wired into a cron or a pre-release
 * check. It is deliberately NOT a vitest test: it needs the network, and a
 * unit suite that fails when a third party changes its catalogue is a suite
 * people learn to ignore.
 */
import {
  FREE_ROUTER_FALLBACKS,
  FREE_GENERAL_FALLBACKS,
  isGeneralChatModel,
  isHarnessGatedModel,
} from "../src/lib/agent/free-mode";

const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";

interface CatalogueEntry {
  id: string;
  supported_parameters?: string[];
}

async function fetchCatalogue(): Promise<Map<string, CatalogueEntry>> {
  const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`OpenRouter catalogue fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data?: CatalogueEntry[] };
  const entries = body.data ?? [];
  if (entries.length === 0) throw new Error("OpenRouter catalogue came back empty");
  return new Map(entries.map((m) => [m.id, m]));
}

function check(
  label: string,
  ids: readonly string[],
  catalogue: Map<string, CatalogueEntry>,
  requiredParameter: string
): string[] {
  const problems: string[] = [];

  if (ids.length === 0) problems.push(`${label}: the list is EMPTY — cold boot has nothing to seat`);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const d of new Set(dupes)) problems.push(`${label}: duplicate id ${d}`);

  for (const id of ids) {
    const entry = catalogue.get(id);
    if (!entry) {
      problems.push(`${label}: ${id} — WITHDRAWN (not in the live catalogue)`);
      continue;
    }
    const params = entry.supported_parameters ?? [];
    if (!params.includes(requiredParameter)) {
      problems.push(`${label}: ${id} — no \`${requiredParameter}\` (has: ${params.join(", ") || "none"})`);
    }
    if (isHarnessGatedModel(id)) problems.push(`${label}: ${id} — harness-gated, would 403 (PM #127)`);
    if (!isGeneralChatModel(id)) problems.push(`${label}: ${id} — not a general chat model`);
    if (!id.endsWith(":free")) problems.push(`${label}: ${id} — not a \`:free\` id, Free Mode would bill it`);
  }
  return problems;
}

async function main(): Promise<void> {
  const catalogue = await fetchCatalogue();
  const free = [...catalogue.keys()].filter((id) => id.endsWith(":free"));
  console.log(`OpenRouter catalogue: ${catalogue.size} models, ${free.length} free.\n`);

  const problems = [
    // The Router runs `generateObject`; without `structured_outputs` it drops
    // to static personas, which is a SILENT degradation (PM #135).
    ...check("FREE_ROUTER_FALLBACKS", FREE_ROUTER_FALLBACKS, catalogue, "structured_outputs"),
    // The brain has to be able to call tools or the turn cannot do any work.
    ...check("FREE_GENERAL_FALLBACKS", FREE_GENERAL_FALLBACKS, catalogue, "tools"),
  ];

  for (const list of [FREE_ROUTER_FALLBACKS, FREE_GENERAL_FALLBACKS] as const) {
    for (const id of list) {
      const mark = catalogue.has(id) ? "ok  " : "GONE";
      console.log(`  ${mark}  ${id}`);
    }
    console.log("");
  }

  if (problems.length > 0) {
    console.error(`FAIL — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\nPick replacements from the live free catalogue above, keeping vendor families spread.`
    );
    process.exit(1);
  }
  console.log("PASS — every cold-boot fallback id exists and carries the capability its list promises.");
}

main().catch((err) => {
  console.error("verify:free-fallbacks crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
