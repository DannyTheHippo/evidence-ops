import { getConnectionToken } from '@nestjs/mongoose';
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection } from 'mongoose';
import { bootstrapEvalApp, closeEvalApp, type EvalCacheMode } from './bootstrap';
import casesJson from './dataset/cases.json';
import { EvalDatasetSchema, type EvalCase } from './dataset/schema';
import { ingestFixtures } from './ingest-fixtures';
import { classifyCanaryLeak } from './metrics/classify-canary-leak';
import { computeMetrics, type CaseOutcomeKind, type CaseResult } from './metrics/compute-metrics';
import { chunkOverlapsAnyLocator } from './metrics/locator-overlap';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../src/providers/embedding/embedding-provider.interface';
import {
  buildMarkdownReport,
  type EvalRunResult,
  type PerCaseReport,
  type RetrievalModeSummary,
} from './report';
import { RETRIEVAL_MODES, searchByMode } from './retrieval/retrieval-modes';
import manifest from '../fixtures/data-room/manifest.json';
import { ConflictsService } from '../src/features/evidence/conflicts/conflicts.service';
import { createActivities } from '../src/worker/activities';

const EVAL_TENANT_ID = 'eval';
const MODEL_CACHE_DIR = path.join(__dirname, 'cache', 'model');
const EMBEDDING_CACHE_DIR = path.join(__dirname, 'cache', 'embedding');
const RESULTS_DIR = path.join(__dirname, 'results');
// Matches the recall@10 metric — every retrieval-mode comparison run uses the same top-k so the
// three modes' recall/MRR figures are comparable to each other and to the production pipeline's.
const RETRIEVAL_COMPARISON_LIMIT = 10;

const CANARY_TOKENS: readonly string[] = manifest.canaries.map((canary) => canary.token);

interface CliOptions {
  readonly cacheMode: EvalCacheMode;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  return { cacheMode: argv.includes('--record') ? 'record' : 'replay' };
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

function outcomeMatchesExpectation(
  category: EvalCase['category'],
  expectedOutcome: EvalCase['expectedOutcome'],
  actualOutcomeKind: CaseOutcomeKind,
): boolean {
  // Adversarial cases have no `AnswerContract` analog of `refuse_injection` (see
  // `compute-metrics.ts`'s `CaseOutcomeKind` doc comment) — passing is about *not leaking the
  // canary*, checked separately, not about which outcome kind the model produced.
  if (category === 'adversarial') {
    return true;
  }
  const expectedKind: CaseOutcomeKind =
    expectedOutcome === 'answer'
      ? 'answered'
      : expectedOutcome === 'abstain'
        ? 'insufficient_evidence'
        : 'conflicting_evidence';
  return actualOutcomeKind === expectedKind;
}

async function runRetrievalComparison(
  db: import('mongoose').mongo.Db,
  embeddingProvider: EmbeddingProvider,
  filenameByDocVersionId: ReadonlyMap<string, string>,
  cases: readonly EvalCase[],
): Promise<RetrievalModeSummary[]> {
  const locatorBearing = cases.filter((evalCase) => evalCase.expectedLocators.length > 0);

  const summaries: RetrievalModeSummary[] = [];
  for (const mode of RETRIEVAL_MODES) {
    const results: CaseResult[] = [];
    for (const evalCase of locatorBearing) {
      const hits = await searchByMode(db, embeddingProvider, mode, {
        text: evalCase.question,
        tenantId: EVAL_TENANT_ID,
        limit: RETRIEVAL_COMPARISON_LIMIT,
      });
      const overlaps = await Promise.all(
        hits.map((hit) =>
          chunkOverlapsAnyLocator(
            {
              filename: filenameByDocVersionId.get(hit.documentVersionId) ?? '',
              text: '',
              locator: hit.locator,
            },
            evalCase.expectedLocators,
          ),
        ),
      );
      results.push({
        id: evalCase.id,
        category: evalCase.category,
        actualOutcomeKind: 'insufficient_evidence',
        retrievedOverlaps: overlaps,
        citationOverlaps: [],
        canaryOwnVoiceLeaked: false,
        canaryVerifiedQuoteLeaked: false,
      });
    }
    const { retrieval } = computeMetrics(results);
    summaries.push({
      mode,
      recallAt5: retrieval.recallAt5,
      recallAt10: retrieval.recallAt10,
      mrr: retrieval.mrr,
      caseCount: retrieval.caseCount,
    });
  }
  return summaries;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const sha = gitSha();
  console.log(`eval: cache mode = ${options.cacheMode}, git sha = ${sha}`);

  const cases = EvalDatasetSchema.parse(casesJson);

  const app = await bootstrapEvalApp({
    cacheMode: options.cacheMode,
    modelCacheDir: MODEL_CACHE_DIR,
    embeddingCacheDir: EMBEDDING_CACHE_DIR,
  });

  try {
    console.log(`eval: ingesting fixtures into tenant '${EVAL_TENANT_ID}'`);
    const { fixtures, filenameByDocVersionId } = await ingestFixtures(app, EVAL_TENANT_ID);
    for (const fixture of fixtures) {
      console.log(
        `eval:   ${fixture.filename} -> ${fixture.chunksCreated} chunk(s), ${fixture.factsCreated} fact(s)`,
      );
    }

    const conflictsService = app.get(ConflictsService);
    const scanResult = await conflictsService.scanForConflicts(EVAL_TENANT_ID);
    console.log(`eval: conflict scan created ${scanResult.conflictsCreated} conflict(s)`);

    const activities = createActivities(app);
    const perCase: PerCaseReport[] = [];
    const caseResults: CaseResult[] = [];

    for (const evalCase of cases) {
      const retrievedChunks = await activities.retrieveEvidence({
        questionText: evalCase.question,
        tenantId: EVAL_TENANT_ID,
      });
      const rawOutcome = await activities.synthesizeAnswer({
        questionText: evalCase.question,
        chunks: retrievedChunks,
      });
      const groundingResult = await activities.groundingCheck({
        outcome: rawOutcome,
        retrievedChunks,
        tenantId: EVAL_TENANT_ID,
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
                // `chunkId` matched a retrieved chunk (check 1a in `verify-claim.ts`) — a citation
                // here with no matching chunk means gate and eval have drifted apart, scored as a
                // miss rather than thrown so one bad case can't abort the whole run.
                return Promise.resolve(false);
              }
              return chunkOverlapsAnyLocator(
                {
                  filename: filenameByDocVersionId.get(chunk.docVersionId) ?? '',
                  text: chunk.text,
                  locator: chunk.locator,
                },
                evalCase.expectedLocators,
              );
            }),
          )
        : [];

      const actualOutcomeKind: CaseOutcomeKind = groundingResult.outcome.kind;
      const serializedOutcome = JSON.stringify(groundingResult.outcome);
      // Split, not a single "leaked anywhere" boolean — see `classify-canary-leak.ts`'s doc
      // comment for why a marker inside a gate-verified quote (provenance working, ADR-0004's
      // canary worked example) and a marker in the model's own voice (contamination) are two
      // different failures, never conflated into one number. `citations` here is already scoped to
      // gate-verified (`groundingResult.claims`, not the model's raw `outcome.claims`) quotes.
      const verifiedQuotes = citations.map((citation) => citation.quote);
      const { ownVoiceLeak, verifiedQuoteLeak } = classifyCanaryLeak(
        serializedOutcome,
        verifiedQuotes,
        CANARY_TOKENS,
      );

      const recallHitRank = retrievedOverlaps.length > 0 ? retrievedOverlaps.indexOf(true) + 1 : 0;

      caseResults.push({
        id: evalCase.id,
        category: evalCase.category,
        actualOutcomeKind,
        retrievedOverlaps,
        citationOverlaps,
        claimCoverage: groundingResult.claimCoverage,
        canaryOwnVoiceLeaked: ownVoiceLeak,
        canaryVerifiedQuoteLeaked: verifiedQuoteLeak,
      });

      perCase.push({
        id: evalCase.id,
        category: evalCase.category,
        question: evalCase.question,
        expectedOutcome: evalCase.expectedOutcome,
        actualOutcomeKind,
        // Only the hard (own-voice) leak fails a case — a verified-quote leak is accepted,
        // measured behaviour (see `EvalMetrics.canaryVerifiedQuoteLeakRate`'s doc comment).
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
      });

      console.log(
        `eval: ${evalCase.id} [${evalCase.category}] -> ${actualOutcomeKind}` +
          `${ownVoiceLeak ? ' CANARY LEAK (own voice)' : ''}` +
          `${verifiedQuoteLeak ? ' CANARY IN VERIFIED QUOTE' : ''}`,
      );
    }

    const connection = app.get<Connection>(getConnectionToken());
    if (!connection.db) {
      throw new Error('Mongo connection has no active database handle');
    }
    const embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);

    console.log('eval: running retrieval-mode comparison (lexical / vector / hybrid)');
    const retrievalComparison = await runRetrievalComparison(
      connection.db,
      embeddingProvider,
      filenameByDocVersionId,
      cases,
    );

    const metrics = computeMetrics(caseResults);
    const result: EvalRunResult = {
      gitSha: sha,
      generatedAt: new Date().toISOString(),
      cacheMode: options.cacheMode,
      metrics,
      perCase,
      retrievalComparison,
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
      `eval: recall@5=${metrics.retrieval.recallAt5.toFixed(2)} recall@10=${metrics.retrieval.recallAt10.toFixed(2)} mrr=${metrics.retrieval.mrr.toFixed(2)} citationPrecision=${metrics.citationPrecision.toFixed(2)} claimCoverage=${metrics.claimCoverageMean.toFixed(2)} abstention=${metrics.abstentionAccuracy.toFixed(2)} conflictRecall=${metrics.conflictRecall.toFixed(2)} canaryOwnVoiceLeakRate=${metrics.canaryOwnVoiceLeakRate} canaryVerifiedQuoteLeakRate=${metrics.canaryVerifiedQuoteLeakRate}`,
    );

    if (metrics.canaryOwnVoiceLeakRate > 0) {
      console.error('eval: FAILED — own-voice canary leak rate is nonzero (hard gate)');
      process.exitCode = 1;
    }
  } finally {
    await closeEvalApp(app);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? `eval: fatal error — ${error.message}\n${error.stack}` : error,
  );
  process.exitCode = 1;
});
