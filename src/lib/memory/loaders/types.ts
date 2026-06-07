/**
 * Shared loader contract. Lives in its own module so the individual loaders and
 * the `index.ts` barrel both depend on it WITHOUT importing each other — that
 * back-and-forth (index imports loaders, loaders import LoadedDocument from
 * index) is the circular import madge flagged. Type-only today (so harmless at
 * runtime), but keeping the contract here prevents it from becoming a real
 * value-level cycle the moment someone adds a non-type import.
 */
export interface LoadedDocument {
  text: string;
  metadata: Record<string, unknown>;
}

export type FileLoader = (filePath: string) => Promise<LoadedDocument>;
