import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CacheManifest {
  readonly corpusFingerprint: string;
  readonly recordedAt: string;
}

/**
 * Duck-typed on `.code`, not `instanceof Error` — same realm gap `caching-model.provider.ts`'s
 * `isNotFoundError` documents (Node's `fs/promises` errors fail `instanceof Error` under this
 * project's Jest realm even though `.code` is set correctly). Duplicated rather than imported: that
 * helper is private to its module, and this repo's convention (ADR-0007, `retrieval-modes.ts`) is a
 * small duplicated helper with a note over reaching across a module boundary for one function.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function manifestPath(cacheDir: string): string {
  return path.join(cacheDir, 'manifest.json');
}

/** `undefined` means no cache has ever been recorded — distinct from a corpus-fingerprint
 * mismatch, and callers must report the two differently (see `run.ts`). */
export async function readCacheManifest(cacheDir: string): Promise<CacheManifest | undefined> {
  try {
    const raw = await readFile(manifestPath(cacheDir), 'utf-8');
    return JSON.parse(raw) as CacheManifest;
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function writeCacheManifest(cacheDir: string, manifest: CacheManifest): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(manifestPath(cacheDir), JSON.stringify(manifest, null, 2), 'utf-8');
}
