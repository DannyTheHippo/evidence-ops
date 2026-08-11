import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection, Model } from 'mongoose';
import { bootstrapEvalApp, closeEvalApp, type EvalCacheMode } from './bootstrap';
import { readCacheManifest, writeCacheManifest } from './cache-manifest';
import { computeCorpusFingerprint } from './compute-corpus-fingerprint';
import casesJson from './dataset/cases.json';
import { EvalDatasetSchema, type EvalCase } from './dataset/schema';
import { ingestFixtures, type IngestedFixture } from './ingest-fixtures';
import { loadExistingCorpus } from './load-existing-corpus';
import { classifyCanaryLeak } from './metrics/classify-canary-leak';
import { computeMetrics, type CaseOutcomeKind, type CaseResult } from './metrics/compute-metrics';
import { chunkOverlapsAnyLocator } from './metrics/locator-overlap';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../src/providers/embedding/embedding-provider.interface';
import { assertAtlasSearchSupported } from '../src/providers/retrieval/atlas-search-capability.util';
import { buildMarkdownReport, type EvalRunResult, type PerCaseReport } from './report';
import { runRetrievalComparison } from './retrieval/retrieval-comparison';
import manifest from '../fixtures/data-room/manifest.json';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { ConflictsService } from '../src/features/evidence/conflicts/conflicts.service';
import { createActivities } from '../src/worker/activities';

const EVAL_TENANT_ID = 'eval';
const CACHE_DIR = path.join(__dirname, 'cache');
const MODEL_CACHE_DIR = path.join(CACHE_DIR, 'model');
const EMBEDDING_CACHE_DIR = path.join(CACHE_DIR, 'embedding');
const RESULTS_DIR = path.join(__dirname, 'results');

const CANARY_TOKENS: readonly string[] = manifest.canaries.map((canary) => canary.token);

interface CliOptions {
  readonly cacheMode: EvalCacheMode;
  readonly ingest: boolean;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  return {
    cacheMode: argv.includes('--record') ? 'record' : 'replay',
    ingest: argv.includes('--ingest'),
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

    const embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);

    console.log('eval: running retrieval-mode comparison (lexical / vector / hybrid)');
    const retrievalComparison = await runRetrievalComparison({
      db,
      embeddingProvider,
      filenameByDocVersionId,
      cases,
      tenantId: EVAL_TENANT_ID,
    });

    const metrics = computeMetrics(caseResults);
    const result: EvalRunResult = {
      gitSha: sha,
      generatedAt: new Date().toISOString(),
      cacheMode: options.cacheMode,
      corpusFingerprint,
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
