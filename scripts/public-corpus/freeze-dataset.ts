import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EvalDatasetSchema, type EvalCase, type Locator } from '../../eval/dataset/schema';
import { resolveLocatorText } from '../../eval/resolve-locator';
import { sha256Hex } from '../fixtures/lib/hash';
import { selectedFiles, type CorpusManifest } from './lib/corpus-manifest';

/**
 * The ingest ledger's shape (`eval/ingest-public-corpus.ts`, 5.4). Duplicated here rather than
 * imported: that module is out of this file's grant (`scripts/public-corpus/`), and this file only
 * ever reads the ledger's JSON off disk — `eval/metrics/locator-overlap.ts` sets the precedent of a
 * small, self-contained duplicate over widening an out-of-scope file's contract.
 */
export interface IngestLedgerEntry {
  readonly path: string;
  readonly sha256: string;
  readonly documentId?: string;
  readonly documentVersionId?: string;
  readonly chunksCreated?: number;
  readonly proseChunks?: number;
  readonly factsCreated?: number;
  readonly skippedChunkCount?: number;
  readonly ingestMs?: number;
  readonly extractMs?: number;
  readonly state: 'pending' | 'ingested' | 'facts-pending' | 'failed';
  readonly attempts?: number;
  readonly error?: string;
  readonly updatedAt: string;
}

export interface IngestLedger {
  readonly tenantId: string;
  readonly corpusManifestSha256: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly entries: Record<string, IngestLedgerEntry>;
}

export interface DatasetManifest {
  readonly frozenAt: string;
  readonly casesSha256: string;
  readonly corpusManifestSha256: string;
  readonly ledgerCompletedAt: string | undefined;
  readonly counts: {
    readonly byCategory: Record<string, number>;
    readonly byClass: Record<string, number>;
  };
  readonly verified: {
    readonly locatorsResolved: number;
    readonly expectedAnswerContainsChecked: number;
  };
}

export interface FreezeIssue {
  readonly caseId: string;
  readonly reason: string;
}

export interface CheckDatasetParams {
  readonly cases: readonly EvalCase[];
  readonly manifest: CorpusManifest;
  readonly ledger: IngestLedger;
  readonly datasetMinimums: Record<string, number>;
  readonly resolveText: (locator: Locator) => Promise<string>;
}

export interface CheckDatasetResult {
  readonly issues: readonly FreezeIssue[];
  readonly counts: DatasetManifest['counts'];
  readonly verified: DatasetManifest['verified'];
}

/**
 * Every freeze-time check beyond `EvalDatasetSchema` itself: locator files are selected,
 * non-duplicate corpus files that the ledger records as `ingested`; every resolved locator text is
 * non-empty; every `expectedAnswerContains` needle is a substring of its case's combined resolved
 * text (the same check `test/fixtures/dataset.spec.ts` runs for the synthetic lane); every
 * adversarial case carries an `injectionMarker`; and every `datasetMinimums` count is met.
 */
export async function checkDataset(params: CheckDatasetParams): Promise<CheckDatasetResult> {
  const issues: FreezeIssue[] = [];

  const seenIds = new Set<string>();
  for (const evalCase of params.cases) {
    if (seenIds.has(evalCase.id)) {
      issues.push({ caseId: evalCase.id, reason: 'duplicate case id' });
    }
    seenIds.add(evalCase.id);
  }

  // `selectedFiles` already excludes a `duplicateOf` file (`corpus-manifest.ts`), so a locator
  // pointing at a duplicate path is rejected by this membership check alone.
  const selectedPaths = new Set(selectedFiles(params.manifest).map((file) => file.path));

  let locatorsResolved = 0;
  let expectedAnswerContainsChecked = 0;

  for (const evalCase of params.cases) {
    if (evalCase.category === 'adversarial' && !evalCase.injectionMarker) {
      issues.push({ caseId: evalCase.id, reason: 'adversarial case is missing injectionMarker' });
    }

    const resolvedTexts: string[] = [];
    for (const locator of evalCase.expectedLocators) {
      if (!selectedPaths.has(locator.file)) {
        issues.push({
          caseId: evalCase.id,
          reason: `locator file "${locator.file}" is not a selected, non-duplicate corpus file`,
        });
        continue;
      }
      const ledgerEntry = params.ledger.entries[locator.file];
      if (!ledgerEntry || ledgerEntry.state !== 'ingested') {
        issues.push({
          caseId: evalCase.id,
          reason: `locator file "${locator.file}" is not recorded "ingested" in the ledger`,
        });
        continue;
      }

      const text = await params.resolveText(locator);
      if (text.trim() === '') {
        issues.push({
          caseId: evalCase.id,
          reason: `locator resolves to empty text: ${JSON.stringify(locator)}`,
        });
        continue;
      }
      locatorsResolved += 1;
      resolvedTexts.push(text);
    }

    const combined = resolvedTexts.join('\n');
    for (const needle of evalCase.expectedAnswerContains ?? []) {
      expectedAnswerContainsChecked += 1;
      if (!combined.includes(needle)) {
        issues.push({
          caseId: evalCase.id,
          reason: `expectedAnswerContains "${needle}" not found in the resolved locator text`,
        });
      }
    }
  }

  const byCategory: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  for (const evalCase of params.cases) {
    byCategory[evalCase.category] = (byCategory[evalCase.category] ?? 0) + 1;
    const authoringClass = evalCase.authoring?.class;
    if (authoringClass) {
      byClass[authoringClass] = (byClass[authoringClass] ?? 0) + 1;
    }
  }

  for (const [key, minimum] of Object.entries(params.datasetMinimums)) {
    const actual = key === 'total' ? params.cases.length : (byClass[key] ?? 0);
    if (actual < minimum) {
      issues.push({
        caseId: '__dataset__',
        reason: `datasetMinimums.${key} requires ${minimum}, found ${actual}`,
      });
    }
  }

  return {
    issues,
    counts: { byCategory, byClass },
    verified: { locatorsResolved, expectedAnswerContainsChecked },
  };
}

export interface FreezeIO {
  readonly writeCases: (cases: readonly EvalCase[]) => Promise<void>;
  readonly writeManifest: (manifest: DatasetManifest) => Promise<void>;
}

export interface FreezeParams {
  readonly generated: readonly EvalCase[];
  readonly hand: readonly EvalCase[];
  readonly manifest: CorpusManifest;
  readonly corpusManifestSha256: string;
  readonly ledger: IngestLedger;
  readonly datasetMinimums: Record<string, number>;
  readonly resolveText: (locator: Locator) => Promise<string>;
  readonly dryRun: boolean;
}

export interface FreezeResult {
  readonly ok: boolean;
  readonly issues: readonly FreezeIssue[];
  readonly datasetManifest?: DatasetManifest;
  readonly cases?: readonly EvalCase[];
}

/**
 * Merges the generated and hand-authored cases, runs every freeze check, and — only when every
 * check passes and `dryRun` is false — writes `cases.json` (sorted by id) and `manifest.json`
 * through `io`. A failing check or a dry run writes nothing: `io` is never called on either path.
 */
export async function freezeDataset(params: FreezeParams, io: FreezeIO): Promise<FreezeResult> {
  const merged = [...params.generated, ...params.hand].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  const { issues, counts, verified } = await checkDataset({
    cases: merged,
    manifest: params.manifest,
    ledger: params.ledger,
    datasetMinimums: params.datasetMinimums,
    resolveText: params.resolveText,
  });

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const casesSha256 = sha256Hex(Buffer.from(JSON.stringify(merged), 'utf8'));
  const datasetManifest: DatasetManifest = {
    frozenAt: new Date().toISOString(),
    casesSha256,
    corpusManifestSha256: params.corpusManifestSha256,
    ledgerCompletedAt: params.ledger.completedAt,
    counts,
    verified,
  };

  if (!params.dryRun) {
    await io.writeCases(merged);
    await io.writeManifest(datasetManifest);
  }

  return { ok: true, issues: [], datasetManifest, cases: merged };
}

const DEFAULT_HAND_PATH = 'eval/public/dataset/hand.json';
const DEFAULT_GENERATED_PATH = 'eval/public/dataset/generated/numeric.json';
const DEFAULT_MANIFEST_PATH = 'eval/public/corpus-manifest.json';
const DEFAULT_LEDGER_PATH = 'eval/public/corpus/ingest-ledger.json';
const DEFAULT_BARS_PATH = 'eval/public/bars.json';
const DEFAULT_CORPUS_DIR = 'eval/public/corpus';
const DEFAULT_OUT_DIR = 'eval/public/dataset';

interface FreezeCliArgs {
  readonly handPath: string;
  readonly generatedPath: string;
  readonly manifestPath: string;
  readonly ledgerPath: string;
  readonly barsPath: string;
  readonly corpusDir: string;
  readonly outDir: string;
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): FreezeCliArgs {
  let handPath = DEFAULT_HAND_PATH;
  let generatedPath = DEFAULT_GENERATED_PATH;
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let ledgerPath = DEFAULT_LEDGER_PATH;
  let barsPath = DEFAULT_BARS_PATH;
  let corpusDir = DEFAULT_CORPUS_DIR;
  let outDir = DEFAULT_OUT_DIR;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--hand') {
      handPath = argv[index + 1];
      index += 1;
    } else if (arg === '--generated') {
      generatedPath = argv[index + 1];
      index += 1;
    } else if (arg === '--manifest') {
      manifestPath = argv[index + 1];
      index += 1;
    } else if (arg === '--ledger') {
      ledgerPath = argv[index + 1];
      index += 1;
    } else if (arg === '--bars') {
      barsPath = argv[index + 1];
      index += 1;
    } else if (arg === '--corpus-dir') {
      corpusDir = argv[index + 1];
      index += 1;
    } else if (arg === '--out') {
      outDir = argv[index + 1];
      index += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  return { handPath, generatedPath, manifestPath, ledgerPath, barsPath, corpusDir, outDir, dryRun };
}

interface BarsFile {
  readonly datasetMinimums: Record<string, number>;
}

async function readJsonOrEmpty(filePath: string): Promise<unknown[]> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const [handRaw, generatedRaw, manifestBytes, ledger, bars] = await Promise.all([
    readJsonOrEmpty(args.handPath),
    readJsonOrEmpty(args.generatedPath),
    readFile(args.manifestPath),
    readFile(args.ledgerPath, 'utf8').then((raw) => JSON.parse(raw) as IngestLedger),
    readFile(args.barsPath, 'utf8').then((raw) => JSON.parse(raw) as BarsFile),
  ]);

  const manifest = JSON.parse(manifestBytes.toString('utf8')) as CorpusManifest;
  const corpusManifestSha256 = sha256Hex(manifestBytes);

  const hand = EvalDatasetSchema.parse(handRaw);
  const generated = EvalDatasetSchema.parse(generatedRaw);

  const result = await freezeDataset(
    {
      generated,
      hand,
      manifest,
      corpusManifestSha256,
      ledger,
      datasetMinimums: bars.datasetMinimums,
      resolveText: (locator) => resolveLocatorText(locator, args.corpusDir),
      dryRun: args.dryRun,
    },
    {
      writeCases: async (cases) => {
        await mkdir(args.outDir, { recursive: true });
        await writeFile(
          path.join(args.outDir, 'cases.json'),
          `${JSON.stringify(cases, null, 2)}\n`,
          'utf8',
        );
      },
      writeManifest: async (datasetManifest) => {
        await mkdir(args.outDir, { recursive: true });
        await writeFile(
          path.join(args.outDir, 'manifest.json'),
          `${JSON.stringify(datasetManifest, null, 2)}\n`,
          'utf8',
        );
      },
    },
  );

  if (!result.ok) {
    console.error(`corpus:freeze — ${result.issues.length} issue(s), nothing written:`);
    for (const issue of result.issues) {
      console.error(`  ${issue.caseId}: ${issue.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    console.log(
      `corpus:freeze — dry run, 0 issues, ${result.cases?.length ?? 0} case(s), nothing written`,
    );
    return;
  }

  console.log(
    `corpus:freeze — wrote ${result.cases?.length ?? 0} case(s), casesSha256 ${result.datasetManifest?.casesSha256}`,
  );
}

// Guards the CLI's own I/O from running as a side effect of `freeze-dataset.spec.ts` importing the
// pure exports above — `require.main` is only the module itself when this file is the process entry
// point (`npx ts-node … freeze-dataset.ts`), never when Jest `require`s it as a library.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `corpus:freeze: fatal error — ${error.message}` : error);
    process.exitCode = 1;
  });
}
