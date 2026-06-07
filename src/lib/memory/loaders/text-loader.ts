
import fs from "fs/promises";
import type { LoadedDocument } from "./types";

export async function loadText(filePath: string): Promise<LoadedDocument> {
    const content = await fs.readFile(filePath, "utf-8");
    return {
        text: content,
        metadata: {
            source: filePath,
            type: "text",
        },
    };
}
