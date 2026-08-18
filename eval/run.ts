import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { QdrantClient } from '@qdrant/js-client-rest';
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
import { answerContainsExpectedStrings } from './metrics/answer-content-check';
import { classifyCanaryLeak } from './metrics/classify-canary-leak';
import { computeMetrics, type CaseOutcomeKind, type CaseResult } from './metrics/compute-metrics';
import { conflictValuesOverlapExpectedLocators } from './metrics/conflict-scope-check';
import { chunkOverlapsAnyLocator } from './metrics/locator-overlap';
import { populateQdrantCollection, searchQdrantVector } from './qdrant/qdrant-benchmark-store';
import { makeQdrantAwareSearch, type QdrantSearch } from './qdrant/qdrant-aware-search';
import type { RawEvidenceChunkRow } from './qdrant/chunk-to-point.util';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../src/providers/embedding/embedding-provider.interface';
import { assertAtlasSearchSupported } from '../src/providers/retrieval/atlas-search-capability.util';
import { assertRequiredSearchIndexesExist } from '../src/providers/retrieval/required-search-indexes.util';
import {
  buildMarkdownReport,
  failingCases,
  leakingStrategies,
  type EvalRunResult,
  type PerCaseReport,
  type RetrievalModeSummary,
  type StrategyMetrics,
} from './report';
import {
  EVAL_RETRIEVAL_STRATEGIES,
  gatherEvidenceForStrategy,
  type EvalRetrievalStrategy,
} from './retrieval/gather-evidence-for-strategy';
import { runRetrievalComparison, type SearchByMode } from './retrieval/retrieval-comparison';
import { QDRANT_MODES, RETRIEVAL_MODES, searchByMode } from './retrieval/retrieval-modes';
import manifest from '../fixtures/data-room/manifest.json';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../src/database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { AgenticRetrievalService } from '../src/features/evidence/qa/agentic-retrieval.service';
import { ConflictsService } from '../src/features/evidence/conflicts/conflicts.service';
import { UserRole } from '../src/shared/enums/user-role.enum';
import { createActivities } from '../src/worker/activities';

const EVAL_TENANT_ID = 'eval';
// Server-derived identity `gatherEvidenceForStrategy`'s agentic branch needs for
// `ToolExecutionContext` — `StepPolicyAuthzHook`'s minimum role for the `agentic-retrieval` step is
// `UserRole.Member`, so this is the lowest role that still exercises the same policy check
// production traffic goes through.
const EVAL_ACTOR_ID = 'eval-actor';
const EVAL_ACTOR_ROLE = UserRole.Member;
const CACHE_DIR = path.join(__dirname, 'cache');
const MODEL_CACHE_DIR = path.join(CACHE_DIR, 'model');
const EMBEDDING_CACHE_DIR = path.join(CACHE_DIR, 'embedding');
const RESULTS_DIR = path.join(__dirname, 'results');
const DEFAULT_QDRANT_URL = 'http://localhost:6333';
// Keeps an unflagged `npm run eval` on today's cost profile — the agentic strategy spends real
// model budget per turn (`AgenticRetrievalService.gatherEvidence`), so a caller only pays for it by
// asking via `--strategies`.
const DEFAULT_STRATEGIES: readonly EvalRetrievalStrategy[] = ['single-shot'];

// Duplicated from `retrieval-modes.ts`'s own (unexported) `COLLECTION` constant, not imported —
// same convention that file's header comment already establishes for the `src`/`eval` boundary,
// applied here one file further out: the collection name is copied, not shared, across the two
// eval modules that read it.
const MONGO_EVIDENCE_CHUNKS_COLLECTION = 'evidence_chunks';

const CANARY_TOKENS: readonly string[] = manifest.canaries.map((canary) => canary.token);

interface CliOptions {
  readonly cacheMode: EvalCacheMode;
  readonly ingest: boolean;
  readonly qdrant: boolean;
  readonly qdrantUrl: string;
  readonly strategies: readonly EvalRetrievalStrategy[];
}

function readFlagValue(argv: readonly string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  return argv[index + 1] ?? fallback;
}

function isEvalRetrievalStrategy(value: string): value is EvalRetrievalStrategy {
  return (EVAL_RETRIEVAL_STRATEGIES as readonly string[]).includes(value);
}

/** `--strategies single-shot,agentic` (comma-separated); absent keeps `DEFAULT_STRATEGIES`, which
 * is what preserves today's cost profile for an unflagged run (see that constant's doc comment).
 * Fails CLOSED on an unrecognized value rather than silently dropping it — a typo'd strategy name
 * would otherwise run fewer strategies than the caller asked for without any signal. */
function parseStrategies(argv: readonly string[]): readonly EvalRetrievalStrategy[] {
  const index = argv.indexOf('--strategies');
  if (index === -1) {
    return DEFAULT_STRATEGIES;
  }
  const raw = argv[index + 1] ?? '';
  const requested = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const invalid = requested.filter((value) => !isEvalRetrievalStrategy(value));
  if (invalid.length > 0) {
    throw new Error(
      `eval: unknown --strategies value(s): ${invalid.join(', ')} — valid values are ` +
        `${EVAL_RETRIEVAL_STRATEGIES.join(', ')}`,
    );
  }
  if (requested.length === 0) {
    throw new Error('eval: --strategies was passed with no value');
  }
  return requested.filter(isEvalRetrievalStrategy);
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  return {
    cacheMode: argv.includes('--record') ? 'record' : 'replay',
    ingest: argv.includes('--ingest'),
    qdrant: argv.includes('--qdrant'),
    qdrantUrl: readFlagValue(argv, '--qdrant-url', DEFAULT_QDRANT_URL),
    strategies: parseStrategies(argv),
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
  console.log(
    `eval: cache mode = ${options.cacheMode}, git sha = ${sha}, strategies = ${options.strategies.join(', ')}`,
  );

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
    const agenticRetrievalService = app.get(AgenticRetrievalService);
    const perCase: PerCaseReport[] = [];
    // One `CaseResult[]` per strategy, not one shared array: `computeMetrics` is called once per
    // strategy below so each strategy's recall/citation/canary numbers are its own, never averaged
    // together across strategies that ran fundamentally different retrieval.
    const caseResultsByStrategy: Record<EvalRetrievalStrategy, CaseResult[]> = {
      'single-shot': [],
      agentic: [],
    };

    for (const evalCase of cases) {
      for (const strategy of options.strategies) {
        const retrieval = await gatherEvidenceForStrategy(
          {
            strategy,
            questionText: evalCase.question,
            tenantId: EVAL_TENANT_ID,
            actorId: EVAL_ACTOR_ID,
            role: EVAL_ACTOR_ROLE,
          },
          {
            retrieveEvidence: (input) => activities.retrieveEvidence(input),
            gatherEvidence: (input) => agenticRetrievalService.gatherEvidence(input),
          },
        );
        const retrievedChunks = retrieval.chunks;
        const { contract: rawOutcome } = await activities.synthesizeAnswer({
          questionText: evalCase.question,
          chunks: retrievedChunks,
          tenantId: EVAL_TENANT_ID,
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
          CANARY_TOKENS,
        );

        const recallHitRank =
          retrievedOverlaps.length > 0 ? retrievedOverlaps.indexOf(true) + 1 : 0;

        // Two measured-only checks (never folded into `pass` — see the D2/P2 note on
        // `outcomeMatchesExpectation` below): `answerContentCheck` scores answer *correctness* for
        // `answerable` cases, and `conflictScopeCheck` scores whether a surfaced conflict is the
        // case's own fact rather than any conflict at all. Both are `null` — a third state, not
        // `false` — outside their applicable category/outcome combination; see
        // `CaseResult.answerContentCheck`/`conflictScopeCheck`'s doc comments.
        const answerContentCheck: boolean | null =
          evalCase.category === 'answerable' && actualOutcomeKind === 'answered'
            ? answerContainsExpectedStrings(
                groundingResult.claims.map((claim) => claim.statement).join(' '),
                evalCase.expectedAnswerContains ?? [],
              )
            : null;

        const conflictScopeCheck: boolean | null =
          evalCase.category === 'conflicting' &&
          groundingResult.outcome.kind === 'conflicting_evidence'
            ? await conflictValuesOverlapExpectedLocators(
                groundingResult.outcome.values.map((value) => value.sourceChunkId),
                (chunkId) => {
                  const chunk = chunkByChunkId.get(chunkId);
                  return chunk
                    ? {
                        filename: filenameByDocVersionId.get(chunk.docVersionId) ?? '',
                        text: chunk.text,
                        locator: chunk.locator,
                      }
                    : undefined;
                },
                evalCase.expectedLocators,
              )
            : null;

        caseResultsByStrategy[strategy].push({
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
        });

        perCase.push({
          id: evalCase.id,
          category: evalCase.category,
          question: evalCase.question,
          expectedOutcome: evalCase.expectedOutcome,
          strategy,
          actualOutcomeKind,
          // Only the hard (own-voice) leak fails a case — a verified-quote leak is accepted,
          // measured behaviour (see `EvalMetrics.canaryVerifiedQuoteLeakRate`'s doc comment).
          // `answerContentCheck`/`conflictScopeCheck` are measured and reported only, never folded
          // in here — a later phase gates on them once the baseline is known.
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
          turns: retrieval.turns,
          costUsd: retrieval.costUsd,
          canaryOwnVoiceLeaked: ownVoiceLeak,
          canaryVerifiedQuoteLeaked: verifiedQuoteLeak,
          answerContentCheck,
          conflictScopeCheck,
        });

        console.log(
          `eval: ${evalCase.id} [${evalCase.category}] (${strategy}) -> ${actualOutcomeKind}` +
            `${ownVoiceLeak ? ' CANARY LEAK (own voice)' : ''}` +
            `${verifiedQuoteLeak ? ' CANARY IN VERIFIED QUOTE' : ''}`,
        );
      }
    }

    const embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);

    let retrievalComparison: readonly RetrievalModeSummary[];
    if (options.qdrant) {
      console.log(
        `eval: running retrieval-mode comparison (lexical / vector / hybrid / qdrant-vector) ` +
          `against ${options.qdrantUrl}`,
      );
      const qdrantClient = new QdrantClient({ url: options.qdrantUrl });
      try {
        await qdrantClient.getCollections();
      } catch (cause) {
        // Fails LOUDLY, same posture as `assertAtlasSearchSupported`/
        // `assertRequiredSearchIndexesExist` above: a benchmark that silently reports nothing for
        // 'qdrant-vector' is worse than one that refuses to start.
        throw new Error(
          `eval: Qdrant is unreachable at ${options.qdrantUrl} — start it with ` +
            `'docker compose --profile qdrant up -d' before passing --qdrant.`,
          { cause },
        );
      }

      const rows = await db
        .collection<RawEvidenceChunkRow>(MONGO_EVIDENCE_CHUNKS_COLLECTION)
        .find({ tenantId: EVAL_TENANT_ID })
        .toArray();
      await populateQdrantCollection(qdrantClient, rows);
      const qdrantSearch: QdrantSearch = (provider, query) =>
        searchQdrantVector(qdrantClient, provider, query);
      // `searchByMode` itself stays narrowed to `MongoRetrievalMode` (see `retrieval-modes.ts`'s
      // doc comment on that choice); `makeQdrantAwareSearch` requires the wider `SearchByMode`
      // seam, so this adapter bridges the two the same way `retrieval-comparison.ts`'s own
      // (unexported) `defaultSearch` does. The 'qdrant-vector' branch is unreachable —
      // `makeQdrantAwareSearch` routes that mode to `qdrantSearch` before ever calling this
      // adapter — but the parameter type still has to accept it.
      const mongoSearch: SearchByMode = (db_, provider, mode, query) => {
        if (mode === 'qdrant-vector') {
          throw new Error(
            "mongoSearch adapter received 'qdrant-vector', which makeQdrantAwareSearch should " +
              'have intercepted first',
          );
        }
        return searchByMode(db_, provider, mode, query);
      };

      retrievalComparison = await runRetrievalComparison({
        db,
        embeddingProvider,
        filenameByDocVersionId,
        cases,
        tenantId: EVAL_TENANT_ID,
        modes: [...RETRIEVAL_MODES, ...QDRANT_MODES],
        search: makeQdrantAwareSearch(mongoSearch, qdrantSearch),
      });
    } else {
      console.log('eval: running retrieval-mode comparison (lexical / vector / hybrid)');
      retrievalComparison = await runRetrievalComparison({
        db,
        embeddingProvider,
        filenameByDocVersionId,
        cases,
        tenantId: EVAL_TENANT_ID,
      });
    }

    const metricsByStrategy: StrategyMetrics[] = options.strategies.map((strategy) => ({
      strategy,
      metrics: computeMetrics(caseResultsByStrategy[strategy]),
    }));
    const result: EvalRunResult = {
      gitSha: sha,
      generatedAt: new Date().toISOString(),
      cacheMode: options.cacheMode,
      corpusFingerprint,
      strategies: options.strategies,
      metricsByStrategy,
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
    for (const { strategy, metrics } of metricsByStrategy) {
      console.log(
        `eval: [${strategy}] recall@5=${metrics.retrieval.recallAt5.toFixed(2)} recall@10=${metrics.retrieval.recallAt10.toFixed(2)} mrr=${metrics.retrieval.mrr.toFixed(2)} citationPrecision=${metrics.citationPrecision.toFixed(2)} claimCoverage=${metrics.claimCoverageMean.toFixed(2)} abstention=${metrics.abstentionAccuracy.toFixed(2)} conflictRecall=${metrics.conflictRecall.toFixed(2)} canaryOwnVoiceLeakRate=${metrics.canaryOwnVoiceLeakRate} canaryVerifiedQuoteLeakRate=${metrics.canaryVerifiedQuoteLeakRate}`,
      );
    }

    // The canary hard gate applies to every strategy (work item 2): a leak under any one of them
    // fails the whole run. `leakingStrategies` (`./report`) is the same predicate
    // `buildMarkdownReport`'s gate line reads, so "the report says FAILED" and "the run exits
    // nonzero" can never drift apart.
    const strategiesLeaking = leakingStrategies(metricsByStrategy);
    if (strategiesLeaking.length > 0) {
      console.error(
        `eval: FAILED — own-voice canary leak rate is nonzero under: ${strategiesLeaking.join(', ')} (hard gate)`,
      );
      process.exitCode = 1;
    }

    // The second hard gate, on the same `./report` predicate the markdown gate line reads. A case
    // whose expected outcome did not happen fails the run: replay serves every model and embedding
    // response from a committed fixture, so the outcome is reproducible — a wrong answer here is a
    // regression in the dataset, the prompts, or retrieval, never sampling noise. Applies in record
    // mode too, where the same wrong answer is what a re-record would freeze into the cache.
    const failing = failingCases(perCase);
    if (failing.length > 0) {
      console.error(
        `eval: FAILED — ${failing.length} case(s) did not produce their expected outcome ` +
          `(hard gate): ${failing.map((row) => `${row.id} (${row.strategy})`).join(', ')}`,
      );
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
