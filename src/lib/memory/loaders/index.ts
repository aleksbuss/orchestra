
import path from "path";
import type { LoadedDocument, FileLoader } from "./types";
import { loadText } from "./text-loader";
import { loadPdf } from "./pdf-loader";
import { loadImage } from "./image-loader";
import { loadDocx } from "./docx-loader";
import { loadXlsx } from "./xlsx-loader";

// Re-export the shared contract so existing `from "./index"` importers keep
// working; the canonical definition lives in ./types (breaks the madge cycle).
export type { LoadedDocument, FileLoader } from "./types";

const loaders: Record<string, FileLoader> = {
    ".txt": loadText,
    ".md": loadText,
    ".json": loadText,
    ".csv": loadText,
    ".html": loadText,
    ".xml": loadText,
    ".yaml": loadText,
    ".yml": loadText,
    ".js": loadText,
    ".ts": loadText,
    ".py": loadText,
    ".log": loadText,
    ".pdf": loadPdf,
    ".docx": loadDocx,
    ".xlsx": loadXlsx,
    ".xls": loadXlsx,
    ".png": loadImage,
    ".jpg": loadImage,
    ".jpeg": loadImage,
    ".gif": loadImage,
    ".bmp": loadImage,
    ".webp": loadImage,
};

export async function loadDocument(filePath: string): Promise<LoadedDocument | null> {
    const ext = path.extname(filePath).toLowerCase();
    const loader = loaders[ext];

    if (!loader) {
        console.warn(`No loader found for extension: ${ext}`);
        return null;
    }

    try {
        return await loader(filePath);
    } catch (error) {
        console.error(`Error loading file ${filePath}:`, error);
        return null;
    }
}
