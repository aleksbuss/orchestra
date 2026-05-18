import path from "path";
import fs from "fs/promises";
import * as XLSX from "xlsx";
import type { LoadedDocument } from "./index";

/**
 * Load Excel (.xlsx, .xls) file and convert sheets to text (CSV-style) for vectorization.
 * Reads file via fs to avoid path encoding issues (e.g. Cyrillic filenames).
 *
 * Encoding note: we use `sheet_to_csv` (UTF-8) instead of `sheet_to_txt` —
 * `sheet_to_txt` emits UTF-16 LE with a BOM, which the rest of our
 * pipeline (chunker → embedder → vector store) treats as opaque bytes.
 * The result was unsearchable mojibake (`A·l·i·c·e` with NULL bytes
 * between every ASCII char). Switching to `sheet_to_csv` restores
 * proper UTF-8 round-tripping. Documented as a regression in
 * `xlsx-loader.test.ts`.
 *
 * The CSV output uses tab as the field separator (RAG-friendly: each
 * cell is a clearly bounded token) and newline as the record separator,
 * matching what the previous `sheet_to_txt` shape claimed to do.
 */
export async function loadXlsx(filePath: string): Promise<LoadedDocument> {
    const buffer = await fs.readFile(filePath);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const parts: string[] = [];

    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const text = XLSX.utils.sheet_to_csv(sheet, { FS: "\t", RS: "\n" });
        if (text.trim()) {
            parts.push(`[Sheet: ${sheetName}]\n${text}`);
        }
    }

    const fullText = parts.join("\n\n");

    return {
        text: fullText.trim(),
        metadata: {
            source: filePath,
            type: "xlsx",
            filename: path.basename(filePath),
            sheetCount: workbook.SheetNames.length,
        },
    };
}
