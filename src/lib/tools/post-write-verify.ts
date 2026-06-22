import path from "path";

/**
 * Post-write source verification — the grounding signal (PM #80).
 *
 * `write_text_file` historically returned only `{ success: true, bytes }`. That
 * confirms the WRITE reached disk but says NOTHING about whether the CONTENT is
 * valid source. A model that emits corrupted code gets `success: true`, reads
 * the file back, sees garbage, decides "let me create a proper implementation",
 * rewrites — and loops forever, because nothing ever tells it WHAT is wrong.
 *
 * Observed live (qwen3-coder, 480B): while encoding a quote-heavy multi-line
 * TypeScript file into the JSON `content` tool-call argument, the model mangled
 * it into `[["spam' | 'links"...` with literal `\n`. It correctly DETECTED the
 * corruption on read-back but could only "fix" it by rewriting, which re-mangled
 * through the same broken encoder — an unbreakable loop. The byte-identical loop
 * guard (`tool-guard.ts`) misses this: each mangled rewrite differs, so the
 * `(tool+args)` key never repeats.
 *
 * This runs a cheap, local, SYNTAX-ONLY check after the write and returns a
 * signal the agent can act on: precise `line:col` diagnostics + a directive to
 * make a TARGETED fix instead of a blind full rewrite. It deliberately does NOT
 * type-check — no `Program` / tsconfig resolution (too slow and flaky for a
 * single out-of-project file). It only catches the corruption class: gross
 * syntax breakage and invalid JSON.
 *
 * Robust by construction: an unsupported extension, empty/oversized content, or
 * ANY internal error returns `null` and the write result is left untouched. The
 * checker must never block, fail, or false-alarm a write on its own bug.
 */
export interface PostWriteVerification {
  /** Whether the written content parsed without syntax errors. */
  valid: boolean;
  /** Language the check ran as (surfaced to the model for context). */
  language: string;
  /** First-N diagnostics with `line:col`. Present only when invalid. */
  diagnostics?: string;
  /** Directive telling the model how to recover without looping. Present only when invalid. */
  hint?: string;
}

/** Above this size skip the parse — corruption is small; parsing a huge dump isn't worth the CPU. */
const MAX_VERIFY_CHARS = 200_000;
const MAX_REPORTED_DIAGNOSTICS = 5;

const RECOVERY_HINT =
  "The file WAS written, but a syntax check found the error(s) above. " +
  "Do NOT rewrite the whole file from scratch — that is exactly how the rewrite loop starts. " +
  "Instead: read_text_file around the reported line(s), fix ONLY the broken syntax at those line:col positions, " +
  "then write the corrected file once. If the report is wrong and the code is actually valid, ignore it and proceed.";

type ScriptFlavor = "ts" | "tsx" | "js" | "jsx" | "json";

/** Map a file extension to a checkable flavor, or null to skip (non-source). */
function classify(filePath: string): ScriptFlavor | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts": // also covers `.d.ts` — path.extname returns ".ts"
    case ".mts":
    case ".cts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".json": // NB: not `.jsonc` — comments would false-fail JSON.parse
      return "json";
    default:
      return null;
  }
}

function verifyJson(content: string): PostWriteVerification {
  try {
    JSON.parse(content);
    return { valid: true, language: "json" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      language: "json",
      diagnostics: `Invalid JSON: ${msg}`,
      hint: RECOVERY_HINT,
    };
  }
}

async function verifyTsLike(
  content: string,
  flavor: Exclude<ScriptFlavor, "json">,
  fileName: string
): Promise<PostWriteVerification> {
  // `typescript` is CommonJS (`export = ts`); under esModuleInterop the runtime
  // value may sit on `.default`. Resolve both shapes. Dynamic import keeps the
  // ~8 MB compiler out of cold start and the client bundle (server-only path).
  const mod = await import("typescript");
  const ts =
    (mod as unknown as { default?: typeof import("typescript") }).default ??
    (mod as unknown as typeof import("typescript"));

  const scriptKind =
    flavor === "tsx"
      ? ts.ScriptKind.TSX
      : flavor === "jsx"
        ? ts.ScriptKind.JSX
        : flavor === "js"
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind
  );

  // `parseDiagnostics` holds SYNTACTIC parse errors only (never type errors).
  // Valid source ⇒ empty. It is an internal-but-stable field, hence the cast.
  const diagnostics =
    (sourceFile as unknown as { parseDiagnostics?: ReadonlyArray<import("typescript").Diagnostic> })
      .parseDiagnostics ?? [];

  if (diagnostics.length === 0) {
    return { valid: true, language: flavor };
  }

  const reported = diagnostics.slice(0, MAX_REPORTED_DIAGNOSTICS).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (typeof d.start === "number") {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start);
      return `  line ${line + 1}:${character + 1} — ${message}`;
    }
    return `  — ${message}`;
  });
  const more =
    diagnostics.length > MAX_REPORTED_DIAGNOSTICS
      ? `\n  …and ${diagnostics.length - MAX_REPORTED_DIAGNOSTICS} more`
      : "";

  return {
    valid: false,
    language: flavor,
    diagnostics: `Syntax error(s) (${diagnostics.length}):\n${reported.join("\n")}${more}`,
    hint: RECOVERY_HINT,
  };
}

/**
 * Run a syntax-only grounding check on freshly written content.
 * Returns null when the file is not a checkable source type, is empty, is
 * oversized, or the check itself fails — callers treat null as "no signal".
 */
export async function verifyWrittenSource(
  filePath: string,
  content: string
): Promise<PostWriteVerification | null> {
  try {
    if (!content.trim() || content.length > MAX_VERIFY_CHARS) {
      return null;
    }
    const flavor = classify(filePath);
    if (!flavor) {
      return null;
    }
    if (flavor === "json") {
      return verifyJson(content);
    }
    return await verifyTsLike(content, flavor, path.basename(filePath));
  } catch {
    // Never let the checker break or false-fail the write.
    return null;
  }
}
