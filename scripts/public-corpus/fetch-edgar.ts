import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXCLUDED_FILENAME_PATTERNS,
  EXHIBIT_INCLUDE_HINTS,
  FILE_EXTENSIONS,
  FILED_FROM,
  FILED_TO,
  FORMS,
  MIN_REQUEST_INTERVAL_MS,
  REIT_REGISTRANTS,
  SELECTION,
} from './lib/allowlist';
import {
  applySelection,
  manifestSha8,
  readCorpusManifest,
  sortManifest,
  writeCorpusManifest,
  type AllowlistSnapshot,
  type CorpusFile,
  type CorpusFiling,
  type CorpusManifest,
} from './lib/corpus-manifest';
import { EdgarClient } from './lib/edgar-client';
import { selectFilingFiles } from './lib/select-filing-files';
import { selectFilings, type SubmissionsJson } from './lib/select-filings';
import { sha256Hex } from '../fixtures/lib/hash';

/**
 * Fetches the candidate REIT corpus from SEC EDGAR: submissions → selected filings → each
 * accession's files → company facts, writing a tracked manifest that names every byte by sha256.
 * Resumable — a file already on disk whose sha256 matches the manifest's recorded value for that
 * path is never re-downloaded — and idempotent: re-running with the same allowlist and cache
 * produces a byte-identical manifest except for `fetchedAt` on newly fetched files.
 *
 *   npm run corpus:fetch -- --user-agent "<name> <email>" [--out <dir>] [--manifest <path>] [--dry-run]
 *
 * Every network call runs through `EdgarClient`, which enforces the fair-access pacing itself —
 * this file never issues a bare `fetch`.
 */

const DEFAULT_OUT_DIR = 'eval/public/corpus';
const DEFAULT_MANIFEST_PATH = 'eval/public/corpus-manifest.json';

interface FetchEdgarArgs {
  readonly userAgent: string;
  readonly outDir: string;
  readonly manifestPath: string;
  readonly dryRun: boolean;
}

function usage(): never {
  console.error(
    'usage: fetch-edgar.ts --user-agent "<name> <email>" [--out <dir>] [--manifest <path>] [--dry-run]',
  );
  process.exit(1);
}

function parseArgs(argv: readonly string[]): FetchEdgarArgs {
  let userAgent: string | undefined;
  let outDir = DEFAULT_OUT_DIR;
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--user-agent') {
      userAgent = argv[index + 1];
      index += 1;
    } else if (arg === '--out') {
      outDir = argv[index + 1];
      index += 1;
    } else if (arg === '--manifest') {
      manifestPath = argv[index + 1];
      index += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (!userAgent) {
    console.error('--user-agent is required — SEC EDGAR refuses unnamed automated traffic');
    usage();
  }

  return { userAgent, outDir, manifestPath, dryRun };
}

function buildAllowlistSnapshot(): AllowlistSnapshot {
  return {
    registrants: REIT_REGISTRANTS,
    forms: FORMS,
    filedFrom: FILED_FROM,
    filedTo: FILED_TO,
    exhibitIncludeHints: EXHIBIT_INCLUDE_HINTS,
    fileExtensions: FILE_EXTENSIONS,
  };
}

function submissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${cik}.json`;
}

function companyFactsUrl(cik: string): string {
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
}

// The Archives tree indexes by CIK without leading zeros, unlike the `data.sec.gov` JSON
// endpoints above, which take the zero-padded ten-digit form. Verified against real filings by
// the orchestrator's 5.11 run before any paid step depends on it (plan Assumptions 3).
function archivesCik(cik: string): string {
  return String(Number(cik));
}

function filingIndexUrl(cik: string, accessionNoDashes: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${archivesCik(cik)}/${accessionNoDashes}/index.json`;
}

function filingFileUrl(cik: string, accessionNoDashes: string, filename: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${archivesCik(cik)}/${accessionNoDashes}/${filename}`;
}

function mimeTypeFromExtension(filename: string): string {
  return filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html';
}

/** Fails CLOSED: the fetch stops rather than silently absorbing a filer under a different name than
 * the allowlist expects.
 *
 * Compared on letters and digits alone, because EDGAR's own rendering of a name differs from its
 * common form in punctuation and spacing that carry no identity — `Mid-America Apartment` against
 * `MID AMERICA APARTMENT COMMUNITIES INC.` is the same filer, and a hyphen is not evidence of a
 * different company. Substring containment either way still does the work of catching a CIK that
 * points at an unrelated filer, which is what this guard is for. */
function assertNameMatches(
  registrant: { readonly cik: string; readonly name: string },
  returnedName: string,
): void {
  const identityOnly = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowlisted = identityOnly(registrant.name);
  const returned = identityOnly(returnedName);
  if (!returned.includes(allowlisted) && !allowlisted.includes(returned)) {
    throw new Error(
      `EDGAR registrant name mismatch for CIK ${registrant.cik}: allowlist has ` +
        `"${registrant.name}", submissions returned "${returnedName}"`,
    );
  }
}

async function tryReadManifest(manifestPath: string): Promise<CorpusManifest | undefined> {
  try {
    return await readCorpusManifest(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function fileMatchesSha256(localPath: string, expectedSha256: string): Promise<boolean> {
  try {
    return sha256Hex(await readFile(localPath)) === expectedSha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function writeFileAtomically(filePath: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, filePath);
}

function printFetchPlan(args: FetchEdgarArgs): void {
  console.log('corpus:fetch — dry run, no network calls, nothing written\n');
  console.log(
    `registrants: ${REIT_REGISTRANTS.length} (${REIT_REGISTRANTS.map((r) => r.name).join(', ')})`,
  );
  console.log(`forms: ${FORMS.join(', ')}`);
  console.log(`filed window: ${FILED_FROM} .. ${FILED_TO}`);
  console.log(
    `selection: registrantCount=${SELECTION.registrantCount} maxFilingsPerRegistrantPerForm=${SELECTION.maxFilingsPerRegistrantPerForm}`,
  );
  console.log(`output directory: ${args.outDir}`);
  console.log(`manifest: ${args.manifestPath}`);
  console.log(
    `rate limit: ${MIN_REQUEST_INTERVAL_MS}ms between request starts (SEC fair-access cap: 10 req/s)`,
  );
}

type RegistrantSnapshot = CorpusManifest['registrants'][number];

async function fetchRegistrant(
  client: EdgarClient,
  registrant: { readonly cik: string; readonly name: string },
  args: FetchEdgarArgs,
  existingFilesByPath: ReadonlyMap<string, CorpusFile>,
  existingCompanyFactsByCik: ReadonlyMap<string, RegistrantSnapshot['companyFacts']>,
  seenShaToPath: Map<string, string>,
): Promise<{ registrant: RegistrantSnapshot; filings: CorpusFiling[] }> {
  const submissions = await client.fetchJson<SubmissionsJson>(submissionsUrl(registrant.cik));
  assertNameMatches(registrant, submissions.name);

  const selected = selectFilings(submissions, {
    forms: FORMS,
    filedFrom: FILED_FROM,
    filedTo: FILED_TO,
  });
  const filings: CorpusFiling[] = [];

  for (const filing of selected) {
    const accessionNoDashes = filing.accession.replace(/-/g, '');
    const index = await client.fetchJson<{
      directory: { item: readonly { name: string; size?: string }[] };
    }>(filingIndexUrl(registrant.cik, accessionNoDashes));
    const files = selectFilingFiles(index.directory.item, filing.primaryDocument, {
      extensions: FILE_EXTENSIONS,
      excluded: EXCLUDED_FILENAME_PATTERNS,
      includeHints: EXHIBIT_INCLUDE_HINTS,
    });

    const corpusFiles: CorpusFile[] = [];
    for (const file of files) {
      const relativePath = `${registrant.cik}/${accessionNoDashes}/${file.name}`;
      const localPath = path.join(args.outDir, relativePath);
      const existing = existingFilesByPath.get(relativePath);

      if (existing && (await fileMatchesSha256(localPath, existing.sha256))) {
        corpusFiles.push(existing);
        continue;
      }

      const bytes = await client.fetchBytes(
        filingFileUrl(registrant.cik, accessionNoDashes, file.name),
      );
      await writeFileAtomically(localPath, bytes);
      const sha256 = sha256Hex(bytes);
      const duplicateOf = seenShaToPath.get(sha256) ?? null;
      if (!duplicateOf) {
        seenShaToPath.set(sha256, relativePath);
      }

      corpusFiles.push({
        path: relativePath,
        role: file.role,
        exhibitHint: file.exhibitHint,
        sourceUrl: filingFileUrl(registrant.cik, accessionNoDashes, file.name),
        sha256,
        bytes: bytes.length,
        mimeType: mimeTypeFromExtension(file.name),
        fetchedAt: new Date().toISOString(),
        duplicateOf,
      });
    }

    filings.push({
      cik: registrant.cik,
      registrant: registrant.name,
      accession: filing.accession,
      form: filing.form,
      filingDate: filing.filingDate,
      reportDate: filing.reportDate,
      primaryDocument: filing.primaryDocument,
      selected: false, // recomputed by `applySelection` once every filing is known
      files: corpusFiles,
    });
  }

  const companyFactsPath = `xbrl/CIK${registrant.cik}.json`;
  const companyFactsLocal = path.join(args.outDir, companyFactsPath);
  const existingFacts = existingCompanyFactsByCik.get(registrant.cik);

  const companyFacts =
    existingFacts && (await fileMatchesSha256(companyFactsLocal, existingFacts.sha256))
      ? existingFacts
      : await (async () => {
          const bytes = await client.fetchBytes(companyFactsUrl(registrant.cik));
          await writeFileAtomically(companyFactsLocal, bytes);
          return { path: companyFactsPath, sha256: sha256Hex(bytes), bytes: bytes.length };
        })();

  return { registrant: { cik: registrant.cik, name: registrant.name, companyFacts }, filings };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    printFetchPlan(args);
    return;
  }

  const existingManifest = await tryReadManifest(args.manifestPath);
  const existingFilesByPath = new Map<string, CorpusFile>(
    (existingManifest?.filings ?? []).flatMap((filing) =>
      filing.files.map((file) => [file.path, file]),
    ),
  );
  const existingCompanyFactsByCik = new Map(
    (existingManifest?.registrants ?? []).map((entry) => [entry.cik, entry.companyFacts]),
  );
  // Duplicate detection carries across runs: a file already recorded (and not itself a
  // duplicate) seeds the seen-sha map before any new download runs.
  const seenShaToPath = new Map<string, string>();
  for (const [filePath, file] of existingFilesByPath) {
    if (!file.duplicateOf) {
      seenShaToPath.set(file.sha256, filePath);
    }
  }

  const client = new EdgarClient({
    userAgent: args.userAgent,
    minIntervalMs: MIN_REQUEST_INTERVAL_MS,
  });

  const registrants: RegistrantSnapshot[] = [];
  const filings: CorpusFiling[] = [];
  for (const registrant of REIT_REGISTRANTS) {
    const result = await fetchRegistrant(
      client,
      registrant,
      args,
      existingFilesByPath,
      existingCompanyFactsByCik,
      seenShaToPath,
    );
    registrants.push(result.registrant);
    filings.push(...result.filings);
  }

  const manifest: CorpusManifest = {
    schemaVersion: 1,
    allowlist: buildAllowlistSnapshot(),
    registrants,
    filings,
  };
  const withSelection = applySelection(sortManifest(manifest), SELECTION);
  await writeCorpusManifest(args.manifestPath, withSelection);

  const selectedFilingCount = withSelection.filings.filter((filing) => filing.selected).length;
  console.log(
    `corpus:fetch — ${withSelection.filings.length} filing(s) fetched, ${selectedFilingCount} selected, ` +
      `manifest sha8 ${manifestSha8(withSelection)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `corpus:fetch: fatal error — ${error.message}` : error);
  process.exitCode = 1;
});
