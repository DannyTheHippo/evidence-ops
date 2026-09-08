import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sha256Hex } from '../../fixtures/lib/hash';
import type { Selection } from './allowlist';

export interface CorpusFile {
  readonly path: string;
  readonly role: 'primary' | 'exhibit';
  readonly exhibitHint: string | null;
  readonly sourceUrl: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly fetchedAt: string;
  /** An earlier manifest path with the same sha256. Such a file is never selected — Phase 3A
   *  dedupes identical bytes to one `Document`, so a second path could never be located by
   *  filename. */
  readonly duplicateOf: string | null;
}

export interface CorpusFiling {
  readonly cik: string;
  readonly registrant: string;
  readonly accession: string;
  readonly form: string;
  readonly filingDate: string;
  readonly reportDate: string | null;
  readonly primaryDocument: string;
  readonly selected: boolean;
  readonly files: readonly CorpusFile[];
}

/** A snapshot of the constants in `allowlist.ts` at fetch time, so a manifest names the rules it was built under. */
export interface AllowlistSnapshot {
  readonly registrants: readonly { readonly cik: string; readonly name: string }[];
  readonly forms: readonly string[];
  readonly filedFrom: string;
  readonly filedTo: string;
  readonly exhibitIncludeHints: readonly string[];
  readonly fileExtensions: readonly string[];
}

export interface CorpusManifest {
  readonly schemaVersion: 1;
  readonly allowlist: AllowlistSnapshot;
  readonly registrants: readonly {
    readonly cik: string;
    readonly name: string;
    readonly companyFacts: {
      readonly path: string;
      readonly sha256: string;
      readonly bytes: number;
    };
  }[];
  readonly filings: readonly CorpusFiling[];
}

export async function readCorpusManifest(path: string): Promise<CorpusManifest> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as CorpusManifest;
}

/** Atomic: written to `<path>.tmp` then renamed over `path`, so a killed write never leaves a partial manifest. */
export async function writeCorpusManifest(path: string, manifest: CorpusManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(tmpPath, path);
}

/** Recursively sorts object keys so the same manifest content hashes identically regardless of construction order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** First 8 hex characters of the sha256 over the manifest's canonical JSON — names the sizing/ingest reports. */
export function manifestSha8(manifest: CorpusManifest): string {
  const canonicalBytes = Buffer.from(JSON.stringify(canonicalize(manifest)), 'utf8');
  return sha256Hex(canonicalBytes).slice(0, 8);
}

/** Registrants in allowlist order; filings by registrant order, then `filingDate` descending, then accession; files by path. */
export function sortManifest(manifest: CorpusManifest): CorpusManifest {
  const registrantOrder = new Map(
    manifest.allowlist.registrants.map((entry, index) => [entry.cik, index]),
  );
  const orderOf = (cik: string): number => registrantOrder.get(cik) ?? Number.MAX_SAFE_INTEGER;

  const registrants = [...manifest.registrants].sort(
    (left, right) => orderOf(left.cik) - orderOf(right.cik),
  );

  const filings = [...manifest.filings]
    .map((filing) => ({
      ...filing,
      files: [...filing.files].sort((left, right) => left.path.localeCompare(right.path)),
    }))
    .sort((left, right) => {
      const cikOrder = orderOf(left.cik) - orderOf(right.cik);
      if (cikOrder !== 0) {
        return cikOrder;
      }
      if (left.filingDate !== right.filingDate) {
        return left.filingDate < right.filingDate ? 1 : -1;
      }
      return left.accession.localeCompare(right.accession);
    });

  return { ...manifest, registrants, filings };
}

/**
 * Marks `selected` on every filing: eligible when its registrant is among the first
 * `selection.registrantCount` in allowlist order, its `filingDate` falls in
 * `[selection.filedFrom, selection.filedTo]`, and it is within the first
 * `selection.maxFilingsPerRegistrantPerForm` filings of its (registrant, form) pair — counted in
 * the order `manifest.filings` is already in, so call `sortManifest` first. Pure: returns a new
 * manifest, never mutates the one passed in.
 */
export function applySelection(manifest: CorpusManifest, selection: Selection): CorpusManifest {
  const eligibleCiks = new Set(
    manifest.allowlist.registrants.slice(0, selection.registrantCount).map((entry) => entry.cik),
  );
  const countByRegistrantForm = new Map<string, number>();

  const filings = manifest.filings.map((filing) => {
    const inWindow =
      filing.filingDate >= selection.filedFrom && filing.filingDate <= selection.filedTo;
    if (!eligibleCiks.has(filing.cik) || !inWindow) {
      return { ...filing, selected: false };
    }

    const key = `${filing.cik}:${filing.form}`;
    const countSoFar = countByRegistrantForm.get(key) ?? 0;
    const withinCap = countSoFar < selection.maxFilingsPerRegistrantPerForm;
    countByRegistrantForm.set(key, countSoFar + 1);
    return { ...filing, selected: withinCap };
  });

  return { ...manifest, filings };
}

/** Every file under a `selected` filing, excluding a `duplicateOf` file — a duplicate is never selected. */
export function selectedFiles(manifest: CorpusManifest): readonly (CorpusFile & {
  readonly cik: string;
  readonly accession: string;
  readonly form: string;
})[] {
  const files: (CorpusFile & { cik: string; accession: string; form: string })[] = [];
  for (const filing of manifest.filings) {
    if (!filing.selected) {
      continue;
    }
    for (const file of filing.files) {
      if (file.duplicateOf) {
        continue;
      }
      files.push({ ...file, cik: filing.cik, accession: filing.accession, form: filing.form });
    }
  }
  return files;
}
