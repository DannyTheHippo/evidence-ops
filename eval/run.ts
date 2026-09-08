import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection, Model } from 'mongoose';
import { bootstrapEvalApp, closeEvalApp, type EvalCacheMode } from './bootstrap';
import { readCacheManifest, writeCacheManifest } from './cache-manifest';
import { computeCorpusFingerprint } from './compute-corpus-fingerprint';
import { EvalDatasetSchema, type EvalCase } from './dataset/schema';
import { ingestFixtures, type IngestedFixture } from './ingest-fixtures';
import { EVAL_LANES, laneConfig, type EvalLane } from './lanes';
import { loadExistingCorpus } from './load-existing-corpus';
import {
  answerContainsExpectedStrings,
  conflictValuesContainExpectedStrings,
} from './metrics/answer-content-check';
import { classifyCanaryLeak } from './metrics/classify-canary-leak';
import { compareToBaseline, readBaselineFile } from './metrics/compare-baseline';
import { computeMetrics, type CaseOutcomeKind, type CaseResult } from './metrics/compute-metrics';
import { conflictValuesOverlapExpectedLocators } from './metrics/conflict-scope-check';
import {
  chunkOverlapsAnyLocator,
  classifyOverlapScoringMethod,
  type OverlapCandidateChunk,
} from './metrics/locator-overlap';
import { outcomeMatchesExpectation } from './metrics/outcome-match-check';
import { assertAtlasSearchSupported } from '../src/providers/retrieval/atlas-search-capability.util';
import { assertRequiredSearchIndexesExist } from '../src/providers/retrieval/required-search-indexes.util';
import {
  ANSWER_CONTENT_ACCURACY_FLOOR,
  RECALL_AT_5_FLOOR,
  buildMarkdownReport,
  evaluateBars,
  failingCases,
  hasBaselineRegression,
  hasConflictScopeGap,
  hasMissedBar,
  hasMixedScoringMethods,
  hasOwnVoiceLeak,
  isBelowAnswerContentFloor,
  isBelowRecallAt5Floor,
  type EvalRunResult,
  type LaneBars,
  type PerCaseReport,
  type ScoringMethodSplit,
} from './report';
import { aggregateVariance } from './variance/aggregate-variance';
import {
  assertResumable,
  baseSha,
  completeObservations,
  completedPassCount,
  nextObservationSlots,
} from './variance/variance-resume';
import {
  buildVarianceMarkdownReport,
  type VarianceCaseRun,
  type VarianceRunResult,
} from './variance/variance-report';
import manifest from '../fixtures/data-room/manifest.json';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { ConflictsService } from '../src/features/evidence/conflicts/conflicts.service';
import { createActivities, type Activities } from '../src/worker/activities';

const CANARY_TOKENS: readonly string[] = manifest.canaries.map((canary) => canary.token);

const DEFAULT_VARIANCE_RUNS = 5;

interface CliOptions {
  readonly cacheMode: EvalCacheMode;
  /** The variance lane holds the model live on every pass (`cacheMode: 'off'`) but keeps serving
   * query embeddings from the recorded cache — see `BootstrapEvalAppOptions.embeddingCacheMode`. */
  readonly embeddingCacheMode: EvalCacheMode;
  readonly ingest: boolean;
  readonly lane: EvalLane;
  /** `undefined` outside the variance lane; a pass count of at least 1 inside it. */
  readonly varianceRuns: number | undefined;
  /** Path to a committed baseline file (`--compare <path>`), compared against this run's metrics
   * after `computeMetrics`. `undefined` when the flag was not passed — no comparison runs. */
  readonly compare?: string;
  /** `--resume`: continue an existing `variance-<baseSha>.json` progress file instead of starting a
   * fresh one. Only valid alongside `--variance`. */
  readonly resume: boolean;
}

/**
 * Refuses at parse time, before a single model call, for the two combinations that would silently
 * measure something other than variance: `--ingest` changes the corpus between what a variance pass
 * measures and what the recorded embedding cache was keyed against, and `--record` would serve pass
 * 2 onward from pass 1's fixture, reporting perfect stability that was never measured.
 */
function parseCliOptions(argv: readonly string[]): CliOptions {
  const laneFlagIndex = argv.indexOf('--lane');
  const laneArg = laneFlagIndex === -1 ? undefined : argv[laneFlagIndex + 1];
  if (laneArg !== undefined && !EVAL_LANES.includes(laneArg as EvalLane)) {
    throw new Error(`eval: unknown lane '${laneArg}' — expected one of ${EVAL_LANES.join(', ')}`);
  }
  // The public lane's corpus is built by `eval:public:ingest`, resumable at document granularity —
  // `--ingest` here would re-run the eval harness's own synthetic/benchmark ingest path against it,
  // which is not what that path does.
  if (laneArg === 'public' && argv.includes('--ingest')) {
    throw new Error(
      'eval: --ingest is not supported on the public lane — use npm run eval:public:ingest',
    );
  }

  const variance = argv.includes('--variance');
  if (variance && argv.includes('--ingest')) {
    throw new Error(
      'eval: --variance cannot be combined with --ingest — the corpus must stay fixed across ' +
        'passes, or the spread measures re-ingestion rather than run-to-run variance.',
    );
  }
  if (variance && argv.includes('--record')) {
    throw new Error(
      'eval: --variance cannot be combined with --record — a recorded model response would be ' +
        'replayed from pass 2 onward, reporting a stability that was never measured.',
    );
  }

  const compareFlagIndex = argv.indexOf('--compare');
  const compareArg = compareFlagIndex === -1 ? undefined : argv[compareFlagIndex + 1];
  if (compareFlagIndex !== -1 && compareArg === undefined) {
    throw new Error('eval: --compare requires a path');
  }
  if (variance && compareArg !== undefined) {
    throw new Error(
      'eval: --variance cannot be combined with --compare — the variance lane reports a spread ' +
        'over repeated passes, not a single scored run, so there is no one result to compare ' +
        'against a baseline.',
    );
  }

  const runsFlagIndex = argv.indexOf('--runs');
  const runsArg = runsFlagIndex === -1 ? undefined : argv[runsFlagIndex + 1];
  const varianceRuns = runsArg === undefined ? DEFAULT_VARIANCE_RUNS : Number(runsArg);
  if (variance && (!Number.isInteger(varianceRuns) || varianceRuns < 1)) {
    throw new Error(`eval: --runs must be a positive integer, got '${runsArg}'`);
  }

  const resume = argv.includes('--resume');
  if (resume && !variance) {
    throw new Error('eval: --resume is only valid alongside --variance');
  }

  return {
    cacheMode: variance ? 'off' : argv.includes('--record') ? 'record' : 'replay',
    embeddingCacheMode: variance ? 'replay' : argv.includes('--record') ? 'record' : 'replay',
    ingest: argv.includes('--ingest'),
    lane: (laneArg as EvalLane | undefined) ?? 'synthetic',
    varianceRuns: variance ? varianceRuns : undefined,
    compare: compareArg,
    resume,
  };
}

/**
 * A results file is only useful if its label identifies the code that produced it. A bare
 * `rev-parse HEAD` does not: a run against a dirty working tree gets stamped with the last commit's
 * sha while executing something else entirely. That already caused a real misattribution — a run
 * labelled with a pre-chunking sha was used to blame a retrieval change on chunking, when the
 * chunking commit was not yet made.
 *
 * Appending `-dirty` (and listing what was modified alongside it) makes the ambiguity visible in
 * the filename and the JSON rather than silently plausible. Fails OPEN: this is a labelling aid,
 * not a gate, so a repo with no git available still runs and reports `unknown` rather than blocking
 * an eval on provenance metadata.
 */
function gitSha(): string {
  try {
    const sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty =
      execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

interface VarianceLaneOptions {
  readonly activities: Pick<
    Activities,
    | 'retrieveEvidence'
    | 'synthesizeAnswer'
    | 'decomposeClaims'
    | 'checkContradictions'
    | 'groundingCheck'
    | 'resolveFromLedger'
  >;
  readonly cases: readonly EvalCase[];
  readonly tenantId: string;
  readonly resultsDir: string;
  readonly gitSha: string;
  readonly datasetFingerprint: string;
  readonly corpusFingerprint: string;
  readonly requestedRunCount: number;
  readonly modelCacheMode: EvalCacheMode;
  readonly embeddingCacheMode: EvalCacheMode;
  /** `--resume`: continue `variance-<baseSha>.json` from its `nextObservationSlots` instead of
   * starting a fresh progress file. */
  readonly resume: boolean;
}

/**
 * Runs the fixed question set `requestedRunCount` times over one already-ingested corpus, with the
 * model live on every pass, and reports the spread (`eval/variance/aggregate-variance.ts`).
 *
 * Reports, never gates: a missed bar leaves the exit code at 0. This lane measures the system's own
 * nondeterminism rather than asserting a threshold on it, and a measurement that fails the build is
 * a measurement that stops being taken.
 *
 * Named and resumed by `baseSha(options.gitSha)` (the `-dirty` suffix stripped) rather than the raw
 * label, so a run that goes from clean to dirty (or back) between passes still resumes the same
 * file. The progress file is rewritten after every observed case, not every completed pass — each
 * case spends real money, so a lane stopped part-way must leave every case that did finish on disk,
 * not just the passes that happened to complete before the stop.
 */
async function runVarianceLane(options: VarianceLaneOptions): Promise<void> {
  const base = baseSha(options.gitSha);
  const jsonPath = path.join(options.resultsDir, `variance-${base}.json`);
  const mdPath = path.join(options.resultsDir, `variance-${base}.md`);

  let observations: VarianceCaseRun[] = [];
  let passLabels: { runIndex: number; gitSha: string; startedAt: string }[] = [];

  if (options.resume) {
    const existing = JSON.parse(await readFile(jsonPath, 'utf-8')) as VarianceRunResult;
    assertResumable(existing, {
      datasetFingerprint: options.datasetFingerprint,
      corpusFingerprint: options.corpusFingerprint,
      requestedRunCount: options.requestedRunCount,
    });
    // Untracked result files (this progress file among them) must not block a resume — only a
    // tracked-file change means the code that would produce the next pass has moved since the last
    // one ran, which is the condition `--resume` exists to catch.
    const dirtyTrackedFiles = execSync('git status --porcelain --untracked-files=no', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (dirtyTrackedFiles.length > 0) {
      throw new Error(
        `eval: --resume refused — tracked files differ from the last recorded pass: ` +
          `${dirtyTrackedFiles
            .split('\n')
            .map((line) => line.trim())
            .join(', ')}`,
      );
    }
    observations = [...existing.observations];
    passLabels = [...existing.passLabels];
  }

  const caseIds = options.cases.map((evalCase) => evalCase.id);
  const caseById = new Map(options.cases.map((evalCase) => [evalCase.id, evalCase]));
  const slots = nextObservationSlots(observations, caseIds, options.requestedRunCount);

  let currentRunIndex: number | undefined;

  for (const slot of slots) {
    if (slot.runIndex !== currentRunIndex) {
      currentRunIndex = slot.runIndex;
      console.log(`eval: variance pass ${currentRunIndex}/${options.requestedRunCount}`);
      passLabels.push({
        runIndex: currentRunIndex,
        gitSha: options.gitSha,
        startedAt: new Date().toISOString(),
      });
    }

    const evalCase = caseById.get(slot.caseId);
    if (!evalCase) {
      throw new Error(`eval: variance slot references unknown case '${slot.caseId}'`);
    }

    const retrievedChunks = await options.activities.retrieveEvidence({
      questionText: evalCase.question,
      tenantId: options.tenantId,
    });
    const { contract: rawOutcome } = await options.activities.synthesizeAnswer({
      questionText: evalCase.question,
      chunks: retrievedChunks,
      tenantId: options.tenantId,
    });
    // Mirrors `answer-question.workflow.ts`'s decompose-then-check-contradictions ordering
    // between synthesis and grounding, so this lane measures the same production path the
    // scoring lane below does.
    const { atoms } = await options.activities.decomposeClaims({
      outcome: rawOutcome,
      tenantId: options.tenantId,
    });
    const { contradictedClaimIndexes } = await options.activities.checkContradictions({
      outcome: rawOutcome,
      atoms,
      retrievedChunks,
      tenantId: options.tenantId,
    });
    // `questionText` is load-bearing, exactly as in the scoring lane's identical call above: without
    // it `groundingCheck` names no question entity and every conflict-attachment fork fails closed
    // to abstention, which would shift this lane's whole outcome distribution.
    const groundingResult = await options.activities.groundingCheck({
      outcome: rawOutcome,
      retrievedChunks,
      tenantId: options.tenantId,
      questionText: evalCase.question,
      atoms,
      contradictedClaimIndexes,
    });

    const citations =
      groundingResult.outcome.kind === 'answered'
        ? groundingResult.claims.flatMap((claim) => claim.citations)
        : [];

    observations.push({
      runIndex: slot.runIndex,
      caseId: evalCase.id,
      question: evalCase.question,
      outcomeKind: groundingResult.outcome.kind,
      citedChunkIds: citations.map((citation) => citation.chunkId),
      claimCount: groundingResult.outcome.kind === 'answered' ? groundingResult.claims.length : 0,
      retrievedChunkIds: retrievedChunks.map((chunk) => chunk.chunkId),
      citations: citations.map((citation) => ({
        chunkId: citation.chunkId,
        quote: citation.quote,
      })),
    });

    console.log(
      `eval: variance ${slot.runIndex}/${options.requestedRunCount} ${evalCase.id} -> ` +
        `${groundingResult.outcome.kind}`,
    );

    const runCount = completedPassCount(observations, caseIds);
    const complete = completeObservations(observations, caseIds);
    const result: VarianceRunResult = {
      baseGitSha: base,
      datasetFingerprint: options.datasetFingerprint,
      corpusFingerprint: options.corpusFingerprint,
      requestedRunCount: options.requestedRunCount,
      passLabels,
      observations,
      generatedAt: new Date().toISOString(),
      runCount,
      modelCacheMode: options.modelCacheMode,
      embeddingCacheMode: options.embeddingCacheMode,
      // Absent until the first pass completes — `aggregateVariance` throws on a case missing a
      // pass, and this file is written after every case, so it can be read back mid-pass with no
      // complete pass yet to aggregate over.
      aggregate: runCount > 0 ? aggregateVariance(complete, runCount) : undefined,
    };

    await mkdir(options.resultsDir, { recursive: true });
    await writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
    await writeFile(mdPath, buildVarianceMarkdownReport(result), 'utf-8');

    if (result.aggregate) {
      const { summary } = result.aggregate;
      console.log(
        `eval: wrote variance-${base}.json/.md — after ${runCount} pass(es): ` +
          `flips=${summary.flippedCaseIds.length} ` +
          `citationStability=${summary.citationStabilityRate ?? 'n/a'} ` +
          `answeredEveryPass=${summary.answeredEveryRunCaseCount}/${summary.caseCount}`,
      );
    } else {
      console.log(
        `eval: wrote variance-${base}.json/.md — pass ${slot.runIndex} in progress, no complete ` +
          `pass yet`,
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const {
    tenantId: EVAL_TENANT_ID,
    cacheDir: CACHE_DIR,
    modelCacheDir: MODEL_CACHE_DIR,
    embeddingCacheDir: EMBEDDING_CACHE_DIR,
    resultsDir: RESULTS_DIR,
    datasetPath: DATASET_PATH,
    datasetManifestPath: DATASET_MANIFEST_PATH,
    corpusDir: CORPUS_DIR,
    ledgerPath: LEDGER_PATH,
    barsPath: BARS_PATH,
  } = laneConfig(options.lane);
  const sha = gitSha();
  console.log(
    `eval: cache mode = ${options.cacheMode} (embeddings ${options.embeddingCacheMode}), ` +
      `lane = ${options.lane}, git sha = ${sha}` +
      `${options.varianceRuns === undefined ? '' : `, variance passes = ${options.varianceRuns}`}`,
  );

  const datasetBytes = await readFile(DATASET_PATH);
  const datasetFingerprint = createHash('sha256').update(datasetBytes).digest('hex');
  const cases = EvalDatasetSchema.parse(JSON.parse(datasetBytes.toString('utf-8')));

  if (DATASET_MANIFEST_PATH !== undefined) {
    // The public lane's dataset is frozen against `casesSha256` before any run
    // (`scripts/public-corpus/freeze-dataset.ts`) — a case file edited after freezing would
    // otherwise score silently against ground truth nobody re-verified.
    const datasetManifest = JSON.parse(await readFile(DATASET_MANIFEST_PATH, 'utf-8')) as {
      casesSha256?: string;
    };
    if (datasetManifest.casesSha256 !== datasetFingerprint) {
      throw new Error(
        `eval: dataset fingerprint mismatch — '${DATASET_MANIFEST_PATH}' recorded ` +
          `'${datasetManifest.casesSha256}', '${DATASET_PATH}' hashes to '${datasetFingerprint}'. ` +
          `Run 'npm run corpus:freeze' after any dataset edit.`,
      );
    }
  }

  // The public lane has no planted canaries of its own — its leak-check tokens are the union of
  // the fixture-manifest canaries (harmless no-ops against a corpus that never contains them) and
  // every case's own `injectionMarker`. Unconditional rather than gated on `canarySource`: no
  // synthetic/benchmark case carries an `injectionMarker`, so the union is a no-op there and this
  // stays one code path for every lane.
  const canaryTokens: readonly string[] = [
    ...CANARY_TOKENS,
    ...cases.flatMap((evalCase) => (evalCase.injectionMarker ? [evalCase.injectionMarker] : [])),
  ];

  const app = await bootstrapEvalApp({
    cacheMode: options.cacheMode,
    embeddingCacheMode: options.embeddingCacheMode,
    modelCacheDir: MODEL_CACHE_DIR,
    embeddingCacheDir: EMBEDDING_CACHE_DIR,
  });

  try {
    const evidenceChunkModel = app.get<Model<EvidenceChunkDocument>>(
      getModelToken(EvidenceChunk.name),
    );

    const connection = app.get<Connection>(getConnectionToken());
    if (!connection.db) {
      throw new Error('Mongo connection has no active database handle');
    }
    const db = connection.db;
    // Before `ingestFixtures`/`loadExistingCorpus` and therefore before any embedding or model
    // call: `--ingest` is what spends real Voyage/Anthropic budget (and burns Voyage's 3 RPM
    // cap), so a server that can't serve $search/$vectorSearch/$rankFusion must be caught here,
    // not after a full corpus has already been paid for and embedded — see
    // `AtlasSearchUnavailableError`'s doc comment for the incident this exists to prevent.
    // Unconditional, not gated on RETRIEVAL_FUSION: see `MongoHybridRetrievalStore.search`'s
    // identical guard for why both fusion modes need it.
    await assertAtlasSearchSupported(db);
    // Same fail-CLOSED direction as `MongoHybridRetrievalStore` (see
    // `required-search-indexes.util.ts`'s doc comment) — capability alone is not enough here
    // either: this is the exact check that was missing when a recreated `mongot` container lost
    // its index files and every eval question silently recorded `insufficient_evidence` instead
    // of a loud failure. An eval run over a corpus with no working indexes doesn't just answer
    // wrong, it *records* a wrong recall/precision number as if it were real — a loud stop here
    // beats a quietly false metric in `eval/results/`.
    await assertRequiredSearchIndexesExist(db);

    let fixtures: readonly IngestedFixture[];
    let filenameByDocVersionId: ReadonlyMap<string, string>;

    if (options.ingest) {
      console.log(`eval: ingesting fixtures into tenant '${EVAL_TENANT_ID}'`);
      const ingestResult = await ingestFixtures(app, EVAL_TENANT_ID, db);
      fixtures = ingestResult.fixtures;
      filenameByDocVersionId = ingestResult.filenameByDocVersionId;
      for (const fixture of fixtures) {
        console.log(
          `eval:   ${fixture.filename} -> ${fixture.chunksCreated} chunk(s), ${fixture.factsCreated} fact(s)`,
        );
      }
    } else {
      const existingChunkCount = await evidenceChunkModel.countDocuments({
        tenantId: EVAL_TENANT_ID,
      });
      if (existingChunkCount === 0) {
        // Fails CLOSED: falling back to a silent ingest here would reintroduce the exact
        // nondeterminism `--ingest` exists to make opt-in — Atlas Search is free to reorder a
        // freshly-ingested corpus, which changes the assembled prompt, which breaks the replay
        // cache key (see ADR-0007 / this change's motivation).
        throw new Error(
          `eval: no evidence_chunks found for tenant '${EVAL_TENANT_ID}' — reuse mode never ` +
            `ingests. Run 'npm run eval -- --ingest --record' first.`,
        );
      }
      console.log(
        `eval: reusing existing corpus for tenant '${EVAL_TENANT_ID}' (pass --ingest to re-ingest)`,
      );
      const reuseResult = await loadExistingCorpus(app, EVAL_TENANT_ID);
      fixtures = reuseResult.fixtures;
      filenameByDocVersionId = reuseResult.filenameByDocVersionId;
      for (const fixture of fixtures) {
        console.log(
          `eval:   ${fixture.filename} -> ${fixture.chunksCreated} chunk(s), ${fixture.factsCreated} fact(s) (reused)`,
        );
      }
    }

    // Corpus-wide chunk resolver for the conflict-scope check (see its call site further below):
    // built once here, from every chunk under the eval tenant, not per case —
    // `groundingCheck`'s `conflicting_evidence` outcome can name a `sourceChunkId` this question's
    // own retrieval never surfaced (`findConflictedFactGroupsForChunks` returns every side of a
    // matched conflict group, not only the sides that touched a retrieved chunk), and resolving
    // against only `retrievedChunks` would make the check measure retrieval breadth as much as
    // conflict scoping — a metric retrieval recall (`retrievedOverlaps`/`recallHitRank`) already
    // covers on its own. `chunkByChunkId` inside the per-case loop stays scoped to that question's
    // `retrievedChunks` for retrieval/citation overlap scoring, unchanged.
    const allEvalChunks = await evidenceChunkModel
      .find({ tenantId: EVAL_TENANT_ID })
      .select({ text: 1, locator: 1, documentVersionId: 1, elements: 1 })
      .lean();
    const corpusChunkById = new Map<string, OverlapCandidateChunk>(
      allEvalChunks.map((chunk) => [
        chunk._id,
        {
          filename: filenameByDocVersionId.get(chunk.documentVersionId.toString()) ?? '',
          text: chunk.text,
          locator: chunk.locator,
          // Absent on a row ingested before this field existed (`.lean()` skips schema defaults) —
          // `chunkOverlapsLocator` falls back to text containment for those, unchanged.
          elements: chunk.elements,
        },
      ]),
    );

    // Xlsx chunks are excluded: `chunkOverlapsLocator`'s xlsx-cell path is always the structural
    // range-intersection check, never element-index/text-containment, so folding them in here would
    // double-count against a split that only ever describes the pdf/docx path (S8).
    const proseEvalChunks = allEvalChunks.filter(
      (chunk) =>
        chunk.locator.kind === 'pdf-page' ||
        chunk.locator.kind === 'docx-paragraph' ||
        chunk.locator.kind === 'text-block',
    );
    const scoringMethodSplit: ScoringMethodSplit = {
      elementIndexChunks: proseEvalChunks.filter(
        (chunk) => classifyOverlapScoringMethod(chunk) === 'element-index',
      ).length,
      textContainmentChunks: proseEvalChunks.filter(
        (chunk) => classifyOverlapScoringMethod(chunk) === 'text-containment',
      ).length,
    };
    // Describes the conflict-scope check's chunk resolution only (`corpusChunkById`, consumed by
    // `conflictValuesOverlapExpectedLocators` below) — recall and citation precision always score
    // via text-containment regardless of this split, because their own candidates
    // (`retrievedOverlaps`/`citationOverlaps`, further below) never carry `elements`. See
    // `classifyOverlapScoringMethod`'s doc comment.
    console.log(
      `eval: conflict-scope check corpus scoring method split — ` +
        `${scoringMethodSplit.elementIndexChunks} element-index, ` +
        `${scoringMethodSplit.textContainmentChunks} text-containment` +
        `${hasMixedScoringMethods(scoringMethodSplit) ? ' (MIXED RUN)' : ''} (recall/citation ` +
        `precision are unaffected — see the comment above)`,
    );

    const conflictsService = app.get(ConflictsService);
    const scanResult = await conflictsService.scanForConflicts(EVAL_TENANT_ID);
    console.log(`eval: conflict scan created ${scanResult.conflictsCreated} conflict(s)`);

    const chunkIds = await evidenceChunkModel.distinct('_id', { tenantId: EVAL_TENANT_ID });
    const corpusFingerprint = computeCorpusFingerprint(chunkIds);
    console.log(`eval: corpus fingerprint = ${corpusFingerprint}`);

    if (options.cacheMode === 'record') {
      await writeCacheManifest(CACHE_DIR, {
        corpusFingerprint,
        recordedAt: new Date().toISOString(),
      });
    } else {
      const cacheManifest = await readCacheManifest(CACHE_DIR);
      if (!cacheManifest) {
        throw new Error(
          `eval: no cache manifest at eval/cache/manifest.json — this cache has never been ` +
            `recorded. Run 'npm run eval -- --ingest --record' first.`,
        );
      }
      if (cacheManifest.corpusFingerprint !== corpusFingerprint) {
        throw new Error(
          `eval: corpus fingerprint mismatch — recorded '${cacheManifest.corpusFingerprint}', ` +
            `current '${corpusFingerprint}'. The evidence corpus changed since this cache was ` +
            `recorded (re-ingested, re-chunked, or a different fixture set), so a confusing ` +
            `per-prompt replay-cache miss further down would misattribute the real cause. ` +
            `Re-record with 'npm run eval -- --ingest --record' before replaying.`,
        );
      }
    }

    if (LEDGER_PATH !== undefined) {
      // The public lane's ingest is resumable at document granularity — a ledger without
      // `completedAt` means some selected file is still `pending`/`facts-pending`, and scoring
      // against a partial corpus would silently record a retrieval/recall figure for a corpus that
      // was never actually finished.
      const ledger = JSON.parse(await readFile(LEDGER_PATH, 'utf-8')) as { completedAt?: string };
      if (!ledger.completedAt) {
        throw new Error(
          `eval: ingest ledger '${LEDGER_PATH}' has no completedAt — the public corpus ingest is ` +
            `not finished. Run 'npm run eval:public:ingest' until it reports complete.`,
        );
      }
    }

    const activities = createActivities(app);

    if (options.varianceRuns !== undefined) {
      await runVarianceLane({
        activities,
        cases,
        tenantId: EVAL_TENANT_ID,
        resultsDir: RESULTS_DIR,
        gitSha: sha,
        datasetFingerprint,
        corpusFingerprint,
        requestedRunCount: options.varianceRuns,
        modelCacheMode: options.cacheMode,
        embeddingCacheMode: options.embeddingCacheMode,
        resume: options.resume,
      });
      return;
    }

    const perCase: PerCaseReport[] = [];
    const caseResults: CaseResult[] = [];

    for (const evalCase of cases) {
      // Runs for every case, independent of the retrieval/synthesis path below: the eval always
      // scores the synthesis path regardless of what the ledger resolves, so this only measures
      // whether the ledger path *would* have answered and survived the gate
      // (`ledgerResolvedRate`/`ledgerGateSurvivalRate`) without moving any existing metric.
      const ledgerResolution = await activities.resolveFromLedger({
        questionText: evalCase.question,
        tenantId: EVAL_TENANT_ID,
      });
      const ledgerResolved = ledgerResolution.kind === 'resolved';
      let ledgerSurvived: boolean | undefined;
      if (ledgerResolution.kind === 'resolved') {
        // Mirrors `answer-question.workflow.ts`'s ledger branch: `groundingCheck` over the
        // server-built outcome and its own retrieved chunks, no atoms or contradiction indexes —
        // the ledger claim is whole-statement verified, same as the live workflow.
        const ledgerGroundingResult = await activities.groundingCheck({
          outcome: ledgerResolution.outcome,
          retrievedChunks: ledgerResolution.retrievedChunks,
          tenantId: EVAL_TENANT_ID,
          questionText: evalCase.question,
        });
        ledgerSurvived = ledgerGroundingResult.outcome.kind !== 'insufficient_evidence';
      }

      // Timed only on a lane with a `barsPath` — `CaseResult.retrievalMs` stays `undefined` on the
      // synthetic lane, which is what keeps `EvalMetrics.retrievalLatency` unset and the synthetic
      // lane's committed results stable under replay.
      const retrievalStartedAt = BARS_PATH === undefined ? undefined : Date.now();
      const retrievedChunks = await activities.retrieveEvidence({
        questionText: evalCase.question,
        tenantId: EVAL_TENANT_ID,
      });
      const retrievalMs =
        retrievalStartedAt === undefined ? undefined : Date.now() - retrievalStartedAt;
      const { contract: rawOutcome } = await activities.synthesizeAnswer({
        questionText: evalCase.question,
        chunks: retrievedChunks,
        tenantId: EVAL_TENANT_ID,
      });
      // Mirrors `answer-question.workflow.ts`'s decompose-then-check-contradictions ordering
      // between synthesis and grounding, so this lane measures the same production path.
      const { atoms } = await activities.decomposeClaims({
        outcome: rawOutcome,
        tenantId: EVAL_TENANT_ID,
      });
      const { contradictedClaimIndexes } = await activities.checkContradictions({
        outcome: rawOutcome,
        atoms,
        retrievedChunks,
        tenantId: EVAL_TENANT_ID,
      });
      // `questionText` is what lets `groundingCheck` (`scopeConflictToQuestion`/
      // `resolveQuestionEntity`, `src/features/evidence/qa/scope-conflict-to-question.ts`) name the
      // question's own entity — omitted, `resolveQuestionEntity` sees an empty string, names no
      // entity, and every conflict-attachment fork fails closed to abstention regardless of what the
      // retrieved evidence and canonical-entity registry actually support. The production workflow
      // (`answer-question.workflow.ts`) always threads it through; this activity call must match.
      const groundingResult = await activities.groundingCheck({
        outcome: rawOutcome,
        retrievedChunks,
        tenantId: EVAL_TENANT_ID,
        questionText: evalCase.question,
        atoms,
        contradictedClaimIndexes,
      });

      const chunkByChunkId = new Map(retrievedChunks.map((chunk) => [chunk.chunkId, chunk]));
      const hasGroundTruth = evalCase.expectedLocators.length > 0;

      const retrievedOverlaps = hasGroundTruth
        ? await Promise.all(
            retrievedChunks.map((chunk) =>
              chunkOverlapsAnyLocator(
                {
                  filename: filenameByDocVersionId.get(chunk.docVersionId) ?? '',
                  text: chunk.text,
                  locator: chunk.locator,
                },
                evalCase.expectedLocators,
                CORPUS_DIR,
              ),
            ),
          )
        : [];

      const citations =
        groundingResult.outcome.kind === 'answered'
          ? groundingResult.claims.flatMap((claim) => claim.citations)
          : [];

      const citationOverlaps = hasGroundTruth
        ? await Promise.all(
            citations.map((citation) => {
              const chunk = chunkByChunkId.get(citation.chunkId);
              if (!chunk) {
                // Invariant guard: the grounding gate only ever survives a citation whose
                // `chunkId` matched a retrieved chunk (check 1a in `verify-claim.ts`) — a
                // citation here with no matching chunk means gate and eval have drifted apart,
                // scored as a miss rather than thrown so one bad case can't abort the whole run.
                return Promise.resolve(false);
              }
              return chunkOverlapsAnyLocator(
                {
                  filename: filenameByDocVersionId.get(chunk.docVersionId) ?? '',
                  text: chunk.text,
                  locator: chunk.locator,
                },
                evalCase.expectedLocators,
                CORPUS_DIR,
              );
            }),
          )
        : [];

      const actualOutcomeKind: CaseOutcomeKind = groundingResult.outcome.kind;
      const serializedOutcome = JSON.stringify(groundingResult.outcome);
      // Split, not a single "leaked anywhere" boolean — see `classify-canary-leak.ts`'s doc
      // comment for why a marker inside a gate-verified quote (provenance working, ADR-0004's
      // canary worked example) and a marker in the model's own voice (contamination) are two
      // different failures, never conflated into one number. `citations` here is already scoped
      // to gate-verified (`groundingResult.claims`, not the model's raw `outcome.claims`) quotes.
      const verifiedQuotes = citations.map((citation) => citation.quote);
      const { ownVoiceLeak, verifiedQuoteLeak } = classifyCanaryLeak(
        serializedOutcome,
        verifiedQuotes,
        canaryTokens,
      );

      const recallHitRank = retrievedOverlaps.length > 0 ? retrievedOverlaps.indexOf(true) + 1 : 0;

      // Two measured checks (see `outcomeMatchesExpectation`'s doc comment and the hard-gate block
      // near the end of `main` for how each ends up gated): `answerContentCheck` scores answer
      // *correctness* — the answer text for an `answerable` case, or the attached values for a
      // `conflicting` case's `conflicting_evidence` outcome (there is no answer prose to check
      // there) — and `conflictScopeCheck` scores whether a surfaced conflict is the case's own fact
      // rather than any conflict at all. Both are `null` — a third state, not `false` — outside
      // their applicable category/outcome combination; see
      // `CaseResult.answerContentCheck`/`conflictScopeCheck`'s doc comments.
      const answerContentCheck: boolean | null =
        evalCase.category === 'answerable' && actualOutcomeKind === 'answered'
          ? answerContainsExpectedStrings(
              groundingResult.claims.map((claim) => claim.statement).join(' '),
              evalCase.expectedAnswerContains ?? [],
            )
          : evalCase.category === 'conflicting' &&
              groundingResult.outcome.kind === 'conflicting_evidence'
            ? conflictValuesContainExpectedStrings(
                groundingResult.outcome.values,
                evalCase.expectedAnswerContains ?? [],
              )
            : null;

      // Resolves against `corpusChunkById` (every chunk under the eval tenant), not
      // `chunkByChunkId` (this question's `retrievedChunks`) — this scores whether every side of
      // the attached conflict lives where the case's `expectedLocators` says that conflict lives,
      // independent of whether this turn's retrieval happened to surface all of them. It
      // deliberately does NOT measure retrieval breadth — `retrievedOverlaps`/`recallHitRank`
      // already cover that on their own — so a `sourceChunkId` failing to resolve here means it
      // does not exist anywhere in the corpus, a genuine conflict-scoping failure, not a missed
      // retrieval hit.
      const conflictScopeCheck: boolean | null =
        evalCase.category === 'conflicting' &&
        groundingResult.outcome.kind === 'conflicting_evidence'
          ? await conflictValuesOverlapExpectedLocators(
              groundingResult.outcome.values.map((value) => value.sourceChunkId),
              (chunkId) => corpusChunkById.get(chunkId),
              evalCase.expectedLocators,
              CORPUS_DIR,
            )
          : null;

      const totalClaimCount = rawOutcome.kind === 'answered' ? rawOutcome.claims.length : 0;
      const rawTabularClaims =
        rawOutcome.kind === 'answered'
          ? rawOutcome.claims.filter((claim) =>
              claim.citations.some(
                (citation) =>
                  citation.locator.kind === 'xlsx-region' || citation.locator.kind === 'xlsx-cell',
              ),
            )
          : [];
      const groundedStatements = new Set(groundingResult.claims.map((claim) => claim.statement));
      const tabularGroundedCount = rawTabularClaims.filter((claim) =>
        groundedStatements.has(claim.statement),
      ).length;
      const atomization = groundingResult.verificationReport?.atomization;

      caseResults.push({
        id: evalCase.id,
        category: evalCase.category,
        actualOutcomeKind,
        retrievedOverlaps,
        citationOverlaps,
        claimCoverage: groundingResult.claimCoverage,
        canaryOwnVoiceLeaked: ownVoiceLeak,
        canaryVerifiedQuoteLeaked: verifiedQuoteLeak,
        answerContentCheck,
        conflictScopeCheck,
        totalClaimCount,
        tabularClaimCount: rawTabularClaims.length,
        tabularGroundedCount,
        atomDroppedClaimCount: atomization?.atomDroppedClaimCount ?? 0,
        contradictionDroppedClaimCount: atomization?.contradictionDroppedClaimCount ?? 0,
        ledgerResolved,
        ledgerSurvived,
        retrievalMs,
      });

      perCase.push({
        id: evalCase.id,
        category: evalCase.category,
        question: evalCase.question,
        expectedOutcome: evalCase.expectedOutcome,
        actualOutcomeKind,
        // Only the hard (own-voice) leak fails a case — a verified-quote leak is accepted,
        // measured behaviour (see `EvalMetrics.canaryVerifiedQuoteLeakRate`'s doc comment).
        // `answerContentCheck`/`conflictScopeCheck` are never folded into this per-case `pass` —
        // they gate at the aggregate rate instead (`answerContentAccuracy`/`conflictScopeAccuracy`,
        // checked against `ANSWER_CONTENT_ACCURACY_FLOOR`/`hasConflictScopeGap` near the end of
        // `main`), so one wrong figure in an otherwise-correct answer doesn't flip a case's outcome
        // gate.
        pass:
          outcomeMatchesExpectation(
            evalCase.category,
            evalCase.expectedOutcome,
            actualOutcomeKind,
          ) && !ownVoiceLeak,
        claimCoverage: groundingResult.claimCoverage,
        retrievedChunkCount: retrievedChunks.length,
        recallHitRank: recallHitRank > 0 ? recallHitRank : null,
        citationCount: citations.length,
        citationOverlapCount: citationOverlaps.filter(Boolean).length,
        canaryOwnVoiceLeaked: ownVoiceLeak,
        canaryVerifiedQuoteLeaked: verifiedQuoteLeak,
        answerContentCheck,
        conflictScopeCheck,
      });

      console.log(
        `eval: ${evalCase.id} [${evalCase.category}] -> ${actualOutcomeKind}` +
          `${ownVoiceLeak ? ' CANARY LEAK (own voice)' : ''}` +
          `${verifiedQuoteLeak ? ' CANARY IN VERIFIED QUOTE' : ''}`,
      );
    }

    const metrics = computeMetrics(caseResults);

    // `--compare` is resolved here, before `result` is built, so both the JSON report
    // (`baselineComparison`) and the sixth hard gate below read the same comparison rather than
    // recomputing it. `undefined` when the flag was not passed — no comparison runs, and the
    // sixth gate below is a no-op.
    const baselinePath = options.compare === undefined ? undefined : path.resolve(options.compare);
    const baselineComparison =
      baselinePath === undefined
        ? undefined
        : compareToBaseline(metrics, (await readBaselineFile(baselinePath)).metrics);

    // The public lane's pre-registered bars, read from a tracked file rather than a constant —
    // absent on a lane with no `barsPath`, which is what leaves the synthetic lane's fixed floors
    // below as the only gate.
    const bars =
      BARS_PATH === undefined
        ? undefined
        : (JSON.parse(await readFile(BARS_PATH, 'utf-8')) as LaneBars);
    const barOutcomes = bars === undefined ? undefined : evaluateBars(metrics, bars);

    const result: EvalRunResult = {
      gitSha: sha,
      generatedAt: new Date().toISOString(),
      lane: options.lane,
      cacheMode: options.cacheMode,
      corpusFingerprint,
      datasetFingerprint,
      metrics,
      perCase,
      scoringMethodSplit,
      baselineComparison,
      baselinePath,
      barOutcomes,
    };

    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      path.join(RESULTS_DIR, `${sha}.json`),
      JSON.stringify(result, null, 2),
      'utf-8',
    );
    await writeFile(path.join(RESULTS_DIR, `${sha}.md`), buildMarkdownReport(result), 'utf-8');

    console.log(`eval: wrote eval/results/${sha}.json and eval/results/${sha}.md`);
    console.log(
      `eval: recall@5=${metrics.retrieval.recallAt5.toFixed(2)} recall@10=${metrics.retrieval.recallAt10.toFixed(2)} mrr=${metrics.retrieval.mrr.toFixed(2)} citationPrecision=${metrics.citationPrecision.toFixed(2)} claimCoverage=${metrics.claimCoverageMean.toFixed(2)} abstention=${metrics.abstentionAccuracy.toFixed(2)} conflictRecall=${metrics.conflictRecall.toFixed(2)} canaryOwnVoiceLeakRate=${metrics.canaryOwnVoiceLeakRate} canaryVerifiedQuoteLeakRate=${metrics.canaryVerifiedQuoteLeakRate} tabularGrounded=${metrics.tabularGroundedRate.toFixed(2)} coverageDrop=${metrics.coverageDropRate.toFixed(2)} contradictionDrop=${metrics.contradictionDropRate.toFixed(2)} ledgerResolvedRate=${metrics.ledgerResolvedRate.toFixed(2)} ledgerGateSurvivalRate=${metrics.ledgerGateSurvivalRate.toFixed(2)}`,
    );

    // `hasOwnVoiceLeak` (`./report`) is the same predicate `buildMarkdownReport`'s gate line
    // reads, so "the report says FAILED" and "the run exits nonzero" can never drift apart.
    if (hasOwnVoiceLeak(metrics)) {
      console.error(
        `eval: FAILED — own-voice canary leak rate is nonzero: ${metrics.canaryOwnVoiceLeakRate} (hard gate)`,
      );
      process.exitCode = 1;
    }

    // The fourth hard gate, on the same `./report` predicate the markdown gate line reads. Gated at
    // exactly 1 — a mis-scoped conflict is the exact defect `conflictScopeAccuracy` exists to
    // catch, so any rate below 1 fails the run rather than being averaged away. Unconditional, same
    // as the own-voice gate above: `bars.json`'s `conflictScopeAccuracy` bound is the same 1.00, so
    // this and the bar loop below never disagree on the public lane.
    if (hasConflictScopeGap(metrics)) {
      console.error(
        `eval: FAILED — conflict scope accuracy ${metrics.conflictScopeAccuracy} is below 1 ` +
          `(hard gate)`,
      );
      process.exitCode = 1;
    }

    if (barOutcomes === undefined) {
      // The second hard gate, on the same `./report` predicate the markdown gate line reads. A case
      // whose expected outcome did not happen fails the run: replay serves every model and
      // embedding response from a committed fixture, so the outcome is reproducible — a wrong
      // answer here is a regression in the dataset, the prompts, or retrieval, never sampling
      // noise. Applies in record mode too, where the same wrong answer is what a re-record would
      // freeze into the cache. Skipped on a lane with `barOutcomes`: n≈180 over a single run would
      // be red by construction on a per-case count, so `failingCases` is informational there (see
      // `bars.json`'s `reported` list).
      const failing = failingCases(perCase);
      if (failing.length > 0) {
        console.error(
          `eval: FAILED — ${failing.length} case(s) did not produce their expected outcome ` +
            `(hard gate): ${failing.map((row) => row.id).join(', ')}`,
        );
        process.exitCode = 1;
      }

      // The third hard gate, on the same `./report` predicate the markdown gate line reads. Gated
      // at a floor (`ANSWER_CONTENT_ACCURACY_FLOOR`), not 1 — `expectedAnswerContains` is scored
      // against free-form model prose and rendered conflict values, so a floor at the dataset's own
      // baseline catches a regression without demanding perfection this metric was never meant to
      // reach. Skipped on a lane with `barOutcomes`: the public lane's own bar is registered lower
      // (0.90, `bars.json`) than this synthetic-lane floor (0.95) — applying this floor there would
      // fail a run the pre-registered bar actually passed.
      if (isBelowAnswerContentFloor(metrics)) {
        console.error(
          `eval: FAILED — answer content accuracy ${metrics.answerContentAccuracy} is below the ` +
            `${ANSWER_CONTENT_ACCURACY_FLOOR} floor (hard gate)`,
        );
        process.exitCode = 1;
      }

      // The fifth hard gate, on the same `./report` predicate the markdown gate line reads. Gated
      // at a floor (`RECALL_AT_5_FLOOR`), not 1 — recall depends on chunking and embedding
      // behaviour this dataset was never meant to hold to 100%, so a floor at the dataset's own
      // baseline catches a retrieval regression without demanding perfection this metric was never
      // meant to reach. Skipped on a lane with `barOutcomes`: `bars.json`'s `recallAt5` bound
      // covers it there instead.
      if (isBelowRecallAt5Floor(metrics)) {
        console.error(
          `eval: FAILED — recall@5 ${metrics.retrieval.recallAt5} is below the ` +
            `${RECALL_AT_5_FLOOR} floor (hard gate)`,
        );
        process.exitCode = 1;
      }
    } else {
      // A lane scored against pre-registered bars (`bars.json`) rather than the synthetic lane's
      // fixed floors — one MET/MISSED line per bar, and `hasMissedBar` is the single predicate both
      // this exit code and `buildMarkdownReport`'s "## Pre-registered bars" section read.
      for (const outcome of barOutcomes) {
        const bound = [
          outcome.bound.min === undefined ? undefined : `min=${outcome.bound.min}`,
          outcome.bound.max === undefined ? undefined : `max=${outcome.bound.max}`,
        ]
          .filter((part): part is string => part !== undefined)
          .join(' ');
        console.log(
          `eval: bar ${outcome.metric} ${outcome.met ? 'MET' : 'MISSED'} ` +
            `observed=${outcome.observed} bound=${bound}`,
        );
      }
      if (hasMissedBar(barOutcomes)) {
        console.error(
          `eval: FAILED — ${barOutcomes.filter((outcome) => !outcome.met).length} pre-registered ` +
            `bar(s) missed (hard gate)`,
        );
        process.exitCode = 1;
      }
    }

    // The sixth hard gate, present only when `--compare` was passed, on both the synthetic and the
    // public lane. Read from `baselineComparison.regressions`, never from the process exit code of
    // anything else — the gates above already exit nonzero on this repo's own pre-existing absolute
    // floors (e.g. recall@5 below `RECALL_AT_5_FLOOR`), which is expected and orthogonal to whether
    // this run regressed against its baseline. `hasBaselineRegression` is the same anti-drift
    // predicate `buildMarkdownReport`'s Baseline comparison section reads.
    if (result.baselineComparison) {
      const { regressions, held, absentFromBaseline, absentFromCurrent } =
        result.baselineComparison;
      console.log(
        `eval: baseline comparison — ${regressions.length} regression(s), ${held.length} held, ` +
          `${absentFromBaseline.length} absent from baseline, ${absentFromCurrent.length} absent ` +
          `from current`,
      );
      if (hasBaselineRegression(result)) {
        console.error(
          `eval: FAILED — ${regressions.length} metric(s) regressed against ` +
            `${result.baselinePath}: ` +
            regressions.map((r) => `${r.metric} ${r.baseline}→${r.current}`).join(', '),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await closeEvalApp(app);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? `eval: fatal error — ${error.message}\n${error.stack}` : error,
  );
  // `process.exit`, not `process.exitCode`: a failure inside `createEvalApp` throws before `main`'s
  // own `try` binds `app`, so its `finally` never runs and nothing closes the partially built Nest
  // context. Setting an exit code only asks Node to leave once the event loop drains, and the
  // orphaned Mongo handles mean it never does — the process then sits idle forever instead of
  // failing. A hang is worse than a failure here: CI waits out its wall-clock timeout and reports
  // nothing about the cause. The error is already on stderr, which is synchronous for files and
  // pipes, so there is nothing left to flush.
  process.exit(1);
});
