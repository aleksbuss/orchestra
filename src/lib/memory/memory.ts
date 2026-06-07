import fs from "fs/promises";
import path from "path";
import { embedTexts } from "@/lib/memory/embeddings";
import type { VectorDocument, AppSettings } from "@/lib/types";
import { agentSemaphore } from "@/lib/agent/semaphore";
import { withFileLock, safeWriteFile, assertPathInside } from "@/lib/storage/fs-utils";
import { getDataDir } from "@/lib/storage/data-dir";

const DATA_DIR = getDataDir();
const MEMORY_ROOT = path.join(DATA_DIR, "memory");

interface MemoryDB {
  documents: VectorDocument[];
  metadata: {
    lastUpdated: string;
    count: number;
  };
}

// In-memory cache of loaded databases (limit size to prevent RAM bloat)
const dbCache: Map<string, MemoryDB> = new Map();
const MAX_CACHE_SIZE = 10;

/**
 * Resolve the on-disk vectors file for a memory subdir.
 *
 * Defense-in-depth against path traversal (PM #6 Defect #2): callers that
 * accept `subdir` from a user request — e.g. `POST /api/knowledge` via
 * `importKnowledge(memorySubdir, …)` — are expected to validate it at the
 * entry point. This guard catches anything that slips through, so a stray
 * `../../etc/passwd` cannot pivot through the memory layer to escape
 * `data/memory/`.
 */
function getDbPath(subdir: string): string {
  const subdirPath = assertPathInside(MEMORY_ROOT, subdir);
  return path.join(subdirPath, "vectors.json");
}

/** Remove subdir from in-memory cache (e.g. when project is deleted). */
export function clearMemoryCache(subdir: string): void {
  dbCache.delete(subdir);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Load or create a vector database
 */
async function loadDB(subdir: string): Promise<MemoryDB> {
  if (dbCache.has(subdir)) {
    return dbCache.get(subdir)!;
  }

  // Basic cache eviction (LRU-ish)
  if (dbCache.size >= MAX_CACHE_SIZE) {
    const firstKey = dbCache.keys().next().value;
    if (firstKey) dbCache.delete(firstKey);
  }

  const dbPath = getDbPath(subdir);
  try {
    const content = await fs.readFile(dbPath, "utf-8");
    const db: MemoryDB = JSON.parse(content);
    dbCache.set(subdir, db);
    return db;
  } catch {
    const db: MemoryDB = {
      documents: [],
      metadata: { lastUpdated: new Date().toISOString(), count: 0 },
    };
    dbCache.set(subdir, db);
    return db;
  }
}

/**
 * Save the database to disk via tmp+rename so partial writes never leave a
 * corrupted vectors.json. Concurrency is the caller's responsibility — wrap
 * load+mutate+save in `withFileLock(getDbPath(subdir), …)` to prevent the
 * read-modify-write race that drops embeddings (see `insertManyMemories`).
 */
async function saveDB(subdir: string, db: MemoryDB): Promise<void> {
  const dbPath = getDbPath(subdir);
  await ensureDir(path.dirname(dbPath));
  db.metadata.lastUpdated = new Date().toISOString();
  db.metadata.count = db.documents.length;
  await safeWriteFile(dbPath, JSON.stringify(db));
  dbCache.set(subdir, db);
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Insert text into the vector database
 */
export async function insertMemory(
  text: string,
  area: string,
  subdir: string,
  settings: AppSettings,
  additionalMetadata: Record<string, unknown> = {}
): Promise<string> {
  const [id] = await insertManyMemories([text], area, subdir, settings, additionalMetadata);
  return id;
}

/**
 * Insert multiple texts into the vector database in a single atomic operation.
 * SIGNIFICANTLY faster than calling insertMemory in a loop (O(N) vs O(N^2)).
 */
export async function insertManyMemories(
  texts: string[],
  area: string,
  subdir: string,
  settings: AppSettings,
  additionalMetadata: Record<string, unknown> = {}
): Promise<string[]> {
  if (texts.length === 0) return [];

  // Generate embeddings for the entire batch in one call, respecting system resource limits
  const embeddings = await agentSemaphore.run(() => 
    embedTexts(texts, settings.embeddingsModel)
  );
  if (!embeddings || embeddings.length !== texts.length) {
    throw new Error("Failed to generate embeddings for batch");
  }

  const ids: string[] = [];
  const now = new Date().toISOString();

  // Atomic load+mutate+save — prevents the read-modify-write race where two
  // concurrent inserts on the same subdir each load a stale snapshot, push
  // their own batch, and then overwrite each other on save.
  await withFileLock(getDbPath(subdir), async () => {
    const db = await loadDB(subdir);
    for (let i = 0; i < texts.length; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      db.documents.push({
        id,
        text: texts[i],
        embedding: embeddings[i],
        metadata: {
          area,
          createdAt: now,
          ...additionalMetadata,
        },
      });
    }
    await saveDB(subdir, db);
  });
  return ids;
}

/**
 * Search for similar documents
 */
export async function searchMemory(
  query: string,
  limit: number,
  threshold: number,
  subdir: string,
  settings: AppSettings,
  areaFilter?: string
): Promise<{ id: string; text: string; score: number; metadata: Record<string, unknown> }[]> {
  const db = await loadDB(subdir);
  if (db.documents.length === 0) return [];

  const embeddings = await agentSemaphore.run(() => 
    embedTexts([query], settings.embeddingsModel)
  );
  if (!embeddings || embeddings.length === 0) return [];

  const queryEmbedding = embeddings[0];

  // Calculate similarities
  let results = db.documents
    .map((doc) => ({
      id: doc.id,
      text: doc.text,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
      metadata: doc.metadata,
    }))
    .filter((r) => r.score >= threshold);

  // Apply area filter
  if (areaFilter) {
    results = results.filter((r) => r.metadata.area === areaFilter);
  }

  // Sort by score descending and limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Delete documents by query (finds similar and removes)
 */
export async function deleteMemoryByQuery(
  query: string,
  subdir: string,
  settings: AppSettings
): Promise<number> {
  const matches = await searchMemory(query, 5, 0.8, subdir, settings);
  if (matches.length === 0) return 0;

  const idsToDelete = new Set(matches.map((m) => m.id));
  await withFileLock(getDbPath(subdir), async () => {
    const db = await loadDB(subdir);
    db.documents = db.documents.filter((d) => !idsToDelete.has(d.id));
    await saveDB(subdir, db);
  });
  return idsToDelete.size;
}

/**
 * Delete a specific document by ID
 */
export async function deleteMemoryById(
  id: string,
  subdir: string
): Promise<boolean> {
  let removed = false;
  await withFileLock(getDbPath(subdir), async () => {
    const db = await loadDB(subdir);
    const before = db.documents.length;
    db.documents = db.documents.filter((d) => d.id !== id);
    if (db.documents.length < before) {
      await saveDB(subdir, db);
      removed = true;
    }
  });
  return removed;
}

/**
 * Delete documents by metadata key/value match
 */
export async function deleteMemoryByMetadata(
  key: string,
  value: unknown,
  subdir: string
): Promise<number> {
  let deleted = 0;
  await withFileLock(getDbPath(subdir), async () => {
    const db = await loadDB(subdir);
    const before = db.documents.length;
    db.documents = db.documents.filter((d) => d.metadata[key] !== value);
    deleted = before - db.documents.length;
    if (deleted > 0) {
      await saveDB(subdir, db);
    }
  });
  return deleted;
}

/**
 * Get all memory entries (for dashboard)
 */
export async function getAllMemories(
  subdir: string
): Promise<{ id: string; text: string; metadata: Record<string, unknown> }[]> {
  const db = await loadDB(subdir);
  return db.documents.map((d) => ({
    id: d.id,
    text: d.text,
    metadata: d.metadata,
  }));
}

const KNOWLEDGE_AREA = "knowledge";
const FILENAME_META = "filename";

/**
 * Get chunk counts per filename for knowledge area
 */
export async function getChunkCountsByFilename(
  subdir: string
): Promise<Record<string, number>> {
  const db = await loadDB(subdir);
  const counts: Record<string, number> = {};
  for (const doc of db.documents) {
    if (doc.metadata?.area !== KNOWLEDGE_AREA) continue;
    const name = doc.metadata[FILENAME_META];
    if (typeof name === "string") {
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Get all chunks for a given knowledge file (by filename)
 */
export async function getChunksByFilename(
  subdir: string,
  filename: string
): Promise<{ id: string; text: string; index: number }[]> {
  const db = await loadDB(subdir);
  const chunks = db.documents.filter(
    (d) =>
      d.metadata?.area === KNOWLEDGE_AREA &&
      d.metadata[FILENAME_META] === filename
  );
  return chunks.map((d, i) => ({
    id: d.id,
    text: d.text,
    index: i + 1,
  }));
}
