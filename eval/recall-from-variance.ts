import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { readFile } from 'node:fs/promises';
import type { Connection, Model } from 'mongoose';
import { bootstrapEvalApp, closeEvalApp } from './bootstrap';
import { computeCorpusFingerprint } from './compute-corpus-fingerprint';
import { EvalDatasetSchema } from './dataset/schema';
import { EVAL_LANES, laneConfig, type EvalLane } from './lanes';
import { loadExistingCorpus } from './load-existing-corpus';
import { classifyOverlapScoringMethod, type OverlapScoringMethod } from './metrics/locator-overlap';
import { RECALL_AT_5_FLOOR } from './report';
import {
  assertCorpusFingerprintMatches,
  buildCorpusChunkById,
  isWithinSpread,
  recallFromVariance,
  type RecallFromVarianceResult,
  type RecallSpread,
} from './variance/recall-from-observations';
import type { VarianceCaseRun } from './variance/variance-report';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';

/**
 * The minimal shape this script reads off a variance result JSON — deliberately narrower than
 * `VarianceRunResult` (`eval/variance/variance-report.ts`): a result file this script is pointed
 * at is read straight off disk, not produced by `eval/run.ts` in the same process, so its shape is
 * asserted here rather than assumed.
 */
interface VarianceResultFile {
  readonly runCount: number;
  readonly corpusFingerprint: string;
  readonly observations: readonly VarianceCaseRun[];
}

function parseCliArgs(argv: readonly string[]): {
  readonly resultPath: string;
  readonly lane: EvalLane;
} {
  const [resultPath] = argv;
  if (!resultPath) {
    throw new Error(
      'recall-from-variance: usage: eval/recall-from-variance.ts <path-to-variance-result.json> ' +
        '[--lane <lane>]',
    );
  }
  const laneFlagIndex = argv.indexOf('--lane');
  const laneArg = laneFlagIndex === -1 ? undefined : argv[laneFlagIndex + 1];
  if (laneArg !== undefined && !EVAL_LANES.includes(laneArg as EvalLane)) {
    throw new Error(
      `recall-from-variance: unknown lane '${laneArg}' — expected one of ${EVAL_LANES.join(', ')}`,
    );
  }
  return { resultPath, lane: (laneArg as EvalLane | undefined) ?? 'synthetic' };
}

async function loadVarianceResult(resultPath: string): Promise<VarianceResultFile> {
  const raw = JSON.parse(await readFile(resultPath, 'utf-8')) as VarianceResultFile;
  if (!Array.isArray(raw.observations) || raw.observations.length === 0) {
    throw new Error(`recall-from-variance: '${resultPath}' has no observations to score`);
  }
  return raw;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function printSpread(label: string, valueSpread: RecallSpread): void {
  console.log(
    `  ${label}: min=${pct(valueSpread.min)} max=${pct(valueSpread.max)} mean=${pct(valueSpread.mean)}`,
  );
}

function printReport(
  result: RecallFromVarianceResult,
  runCount: number,
  scoringMethod: OverlapScoringMethod,
): void {
  console.log(
    `recall-from-variance: N = ${runCount} pass(es) — a spread over ${runCount} points describes ` +
      `a band, it does not establish a distribution.`,
  );
  console.log(
    `recall-from-variance: scoring method = ${scoringMethod} — the candidates below carry no ` +
      `retained 'elements', the same shape 'eval/run.ts's own retrievedOverlaps candidates carry, ` +
      `so this band is scored by the same method as the gate's own recall@5 figure and is directly ` +
      `comparable to it and to the floor.`,
  );
  console.log('');
  console.log('Per pass:');
  for (const pass of result.byPass) {
    console.log(
      `  pass ${pass.runIndex}: recall@5=${pct(pass.recall.recallAt5)} ` +
        `recall@10=${pct(pass.recall.recallAt10)} (${pass.recall.caseCount} locator-bearing case(s))`,
    );
  }
  console.log('');
  console.log('Across passes:');
  printSpread('recall@5', result.recallAt5Spread);
  printSpread('recall@10', result.recallAt10Spread);
  console.log('');

  const inBand = isWithinSpread(RECALL_AT_5_FLOOR, result.recallAt5Spread);
  console.log(
    `Floor ${pct(RECALL_AT_5_FLOOR)} ${inBand ? 'FALLS INSIDE' : 'FALLS OUTSIDE'} the observed ` +
      `[${pct(result.recallAt5Spread.min)}, ${pct(result.recallAt5Spread.max)}] recall@5 band.`,
  );
  console.log('');

  console.log(
    `Ground truth: ${result.locatorBearingCaseCount} case(s) contributed ` +
      `${result.totalExpectedLocatorCount} expected locator(s).`,
  );
  console.log(
    `Unmatched: ${result.unmatchedLocators.length} of ${result.totalExpectedLocatorCount} ` +
      `expected locator(s) matched NO retrieved chunk in ANY pass.`,
  );
  for (const { caseId, locator } of result.unmatchedLocators) {
    console.log(`  ${caseId}: ${JSON.stringify(locator)}`);
  }
}

async function main(): Promise<void> {
  const { resultPath, lane } = parseCliArgs(process.argv.slice(2));
  const {
    tenantId: EVAL_TENANT_ID,
    modelCacheDir: MODEL_CACHE_DIR,
    embeddingCacheDir: EMBEDDING_CACHE_DIR,
    datasetPath: DATASET_PATH,
    corpusDir: CORPUS_DIR,
  } = laneConfig(lane);
  const variance = await loadVarianceResult(resultPath);
  const cases = EvalDatasetSchema.parse(JSON.parse(await readFile(DATASET_PATH, 'utf-8')));

  const app = await bootstrapEvalApp({
    cacheMode: 'replay',
    embeddingCacheMode: 'replay',
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

    const { filenameByDocVersionId } = await loadExistingCorpus(app, EVAL_TENANT_ID);

    const chunks = await evidenceChunkModel
      .find({ tenantId: EVAL_TENANT_ID })
      .select({ text: 1, locator: 1, documentVersionId: 1 })
      .lean();
    if (chunks.length === 0) {
      throw new Error(
        `recall-from-variance: no evidence_chunks found for tenant '${EVAL_TENANT_ID}' — nothing ` +
          `to score the variance result against`,
      );
    }

    // A corpus drifted from the one the result was produced against would otherwise print a
    // confident, meaningless band — see `assertCorpusFingerprintMatches`'s doc comment. Computed
    // over the same chunk id set (`{ tenantId: EVAL_TENANT_ID }`, no further filter) that produced
    // `chunks` above, via the same `computeCorpusFingerprint` `eval/run.ts` stamps onto every result
    // file.
    const liveCorpusFingerprint = computeCorpusFingerprint(chunks.map((chunk) => chunk._id));
    assertCorpusFingerprintMatches(variance.corpusFingerprint, liveCorpusFingerprint);

    // No `elements` on any row — see `buildCorpusChunkById`'s doc comment for why this is what
    // makes the recomputed band comparable to the gate's own recall figure and to
    // `RECALL_AT_5_FLOOR`.
    const corpusChunkById = buildCorpusChunkById(
      chunks.map((chunk) => ({
        _id: chunk._id,
        text: chunk.text,
        locator: chunk.locator,
        documentVersionId: chunk.documentVersionId.toString(),
      })),
      filenameByDocVersionId,
    );

    const scoringMethod = classifyOverlapScoringMethod({ elements: undefined });
    const result = await recallFromVariance(
      variance.observations,
      cases,
      corpusChunkById,
      CORPUS_DIR,
    );
    printReport(result, variance.runCount, scoringMethod);
  } finally {
    await closeEvalApp(app);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? `recall-from-variance: fatal error — ${error.message}\n${error.stack}`
      : error,
  );
  process.exitCode = 1;
});
