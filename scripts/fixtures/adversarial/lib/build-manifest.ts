import { sha256Hex } from '../../lib/hash';

export interface AdversarialFixtureEntry {
  readonly path: string;
  readonly sha256: string;
  /** What condition this file exercises — see `generate-adversarial-tree.ts`'s own doc comment
   *  for the full rationale per fixture. */
  readonly description: string;
}

export interface AdversarialManifest {
  readonly generatedAt: string;
  readonly files: readonly AdversarialFixtureEntry[];
}

// Fixed rather than `new Date().toISOString()`, mirroring `data-room`'s manifest — this file is
// committed alongside the binaries it describes and must not drift on every regeneration when
// nothing else changed.
const MANIFEST_GENERATED_AT = '2026-01-01T00:00:00.000Z';

export function buildAdversarialManifest(
  entries: ReadonlyArray<{ path: string; buffer: Buffer; description: string }>,
): AdversarialManifest {
  return {
    generatedAt: MANIFEST_GENERATED_AT,
    files: entries
      .map((entry) => ({
        path: entry.path,
        sha256: sha256Hex(entry.buffer),
        description: entry.description,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}
