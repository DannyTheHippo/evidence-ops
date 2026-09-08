import type { EvidenceLocator } from '../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { EvalCase, Locator } from '../dataset/schema';
import {
  chunkOverlapsAnyLocator,
  chunkOverlapsLocator,
  type OverlapCandidateChunk,
} from '../metrics/locator-overlap';
import { computeMetrics, type CaseResult, type RecallMetrics } from '../metrics/compute-metrics';
import type { VarianceCaseRun } from './variance-report';

export interface RecallByPass {
  readonly runIndex: number;
  readonly recall: RecallMetrics;
}

export interface RecallSpread {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

export interface UnmatchedLocator {
  readonly caseId: string;
  readonly locator: Locator;
}

export interface RecallFromVarianceResult {
  readonly byPass: readonly RecallByPass[];
  readonly recallAt5Spread: RecallSpread;
  readonly recallAt10Spread: RecallSpread;
  /** Cases whose `expectedLocators` is non-empty — the denominator recall/MRR are computed over,
   * per `computeMetrics`' own `RecallMetrics.caseCount` doc comment. */
  readonly locatorBearingCaseCount: number;
  readonly totalExpectedLocatorCount: number;
  readonly unmatchedLocators: readonly UnmatchedLocator[];
}

/**
 * Every chunk id a variance pass recorded as retrieved must resolve against `corpusChunkById` —
 * built from a live Mongo read of the same tenant the pass ran retrieval against. A missing id
 * means the persisted result and the corpus it would be scored against have diverged (a chunk
 * deleted or re-chunked since the pass ran), which would otherwise silently narrow the overlap set
 * a recall figure is computed over to whatever happens to still resolve. Fails CLOSED: throws with
 * every missing id named, rather than skipping them and reporting a recall computed over a subset.
 */
export function assertRetrievedChunksResolve(
  observations: readonly VarianceCaseRun[],
  corpusChunkById: ReadonlyMap<string, OverlapCandidateChunk>,
): void {
  const missing = new Set<string>();
  for (const observation of observations) {
    for (const chunkId of observation.retrievedChunkIds) {
      if (!corpusChunkById.has(chunkId)) {
        missing.add(chunkId);
      }
    }
  }
  if (missing.size > 0) {
    const ids = [...missing].sort();
    throw new Error(
      `recall-from-observations: ${ids.length} retrieved chunk id(s) from the variance result are ` +
        `absent from the corpus read from Mongo — the result and the corpus have diverged: ` +
        `${ids.join(', ')}`,
    );
  }
}

/**
 * Every dataset case must have at least one observation in the variance result. Without this, a
 * case entirely absent from the result would still flow into `findUnmatchedLocators` with an
 * empty retrieved-chunk set, and every one of its locators would be counted as unmatched —
 * indistinguishable from "retrieval never found it" even though it was simply never run. Fails
 * CLOSED: throws with every such case id named, rather than silently inflating the
 * unmatched-locator count with cases that were never scored.
 */
export function assertEveryCaseObserved(
  cases: readonly EvalCase[],
  observations: readonly VarianceCaseRun[],
): void {
  const observedCaseIds = new Set(observations.map((observation) => observation.caseId));
  const missing = cases
    .map((evalCase) => evalCase.id)
    .filter((caseId) => !observedCaseIds.has(caseId));
  if (missing.length > 0) {
    throw new Error(
      `recall-from-observations: ${missing.length} dataset case(s) have no observation in the ` +
        `variance result — the dataset and the result have diverged: ${missing.join(', ')}`,
    );
  }
}

/**
 * The variance result and the live corpus must share a fingerprint. Without this, a result scored
 * against a corpus it was not produced from prints a confident, meaningless band — the result file
 * carries `corpusFingerprint` for exactly this comparison, and nothing checked it before this
 * function existed. Reuses `computeCorpusFingerprint` (`eval/compute-corpus-fingerprint.ts`) — the
 * same function `eval/run.ts` stamps onto every result file — so both sides of the comparison are
 * computed the same way. Fails CLOSED: throws naming both fingerprints.
 */
export function assertCorpusFingerprintMatches(
  resultCorpusFingerprint: string,
  liveCorpusFingerprint: string,
): void {
  if (resultCorpusFingerprint !== liveCorpusFingerprint) {
    throw new Error(
      `recall-from-observations: corpus fingerprint mismatch — the variance result was produced ` +
        `against '${resultCorpusFingerprint}', the live corpus is '${liveCorpusFingerprint}'. ` +
        `Scoring this result against a corpus it was not produced from would print a confident, ` +
        `meaningless band.`,
    );
  }
}

/** The minimal shape a lean `evidence_chunks` row needs to resolve into an `OverlapCandidateChunk`
 * via `buildCorpusChunkById` — narrower than the full Mongoose document, so that function stays
 * independently testable against a plain fixture rather than a live Mongo read. */
export interface CorpusChunkRow {
  readonly _id: string;
  readonly text: string;
  readonly locator: EvidenceLocator;
  readonly documentVersionId: string;
}

/**
 * Builds the `corpusChunkById` map `recallFromVariance` scores against, resolving each row's
 * `documentVersionId` to a filename via `filenameByDocVersionId`. Deliberately carries no
 * `elements` — the same shape `eval/run.ts`'s own `retrievedOverlaps` candidates carry (built from
 * `RetrievedChunk`, which has no such field) — so `chunkOverlapsLocator` always takes its
 * text-containment path here, the same path the gate's own recall figure is scored by; a candidate
 * carrying retained elements would score by the looser element-index path instead and produce a
 * band not comparable to the gate's number or to `RECALL_AT_5_FLOOR`.
 *
 * Fails CLOSED on a row whose `documentVersionId` does not resolve to a filename: a `?? ''`
 * fallback would give it filename `''`, and `chunkOverlapsLocator` short-circuits on
 * `chunk.filename !== locator.file` — every locator lookup against that chunk would silently score
 * a miss instead of surfacing the corruption, manufacturing the very recall regression this script
 * exists to catch. Mirrors `loadExistingCorpus`'s own corruption guard (`eval/load-existing-corpus.ts`).
 */
export function buildCorpusChunkById(
  chunks: readonly CorpusChunkRow[],
  filenameByDocVersionId: ReadonlyMap<string, string>,
): Map<string, OverlapCandidateChunk> {
  return new Map(
    chunks.map((chunk) => {
      const filename = filenameByDocVersionId.get(chunk.documentVersionId);
      if (filename === undefined) {
        throw new Error(
          `recall-from-observations: chunk '${chunk._id}' references documentVersionId ` +
            `'${chunk.documentVersionId}', which has no filename in the corpus — the corpus is ` +
            `corrupt.`,
        );
      }
      return [chunk._id, { filename, text: chunk.text, locator: chunk.locator }];
    }),
  );
}

function resolveChunk(
  chunkId: string,
  corpusChunkById: ReadonlyMap<string, OverlapCandidateChunk>,
): OverlapCandidateChunk {
  const chunk = corpusChunkById.get(chunkId);
  if (!chunk) {
    // `assertRetrievedChunksResolve` runs before any of this module's other exports and throws on
    // exactly this condition — reaching here means that guard was bypassed, not a normal input.
    throw new Error(
      `recall-from-observations: unresolved chunk id '${chunkId}' — call ` +
        `assertRetrievedChunksResolve first`,
    );
  }
  return chunk;
}

async function buildRetrievedOverlaps(
  observation: VarianceCaseRun,
  evalCase: EvalCase,
  corpusChunkById: ReadonlyMap<string, OverlapCandidateChunk>,
  corpusDir?: string,
): Promise<readonly boolean[]> {
  // Mirrors `eval/run.ts`'s own `hasGroundTruth` gate: a case with no expected locator has nothing
  // to score recall against, and an empty array (not a run of `false`s) is what keeps it out of
  // `computeMetrics`' locator-bearing denominator.
  if (evalCase.expectedLocators.length === 0) {
    return [];
  }
  return Promise.all(
    observation.retrievedChunkIds.map((chunkId) =>
      chunkOverlapsAnyLocator(
        resolveChunk(chunkId, corpusChunkById),
        evalCase.expectedLocators,
        corpusDir,
      ),
    ),
  );
}

/**
 * Rebuilds one pass's `CaseResult[]` from its raw ranked-retrieval observations and scores it
 * through the real `computeMetrics` — the same function `eval/run.ts` scores a live pass with — so
 * a recall figure computed here answers exactly the question the eval gate asks, not a hand-rolled
 * approximation of it. Citation/canary/answer-content/claim-count fields are inert placeholders:
 * this only ever reads `metrics.retrieval` off the result.
 */
export async function computeRecallForPass(
  runIndex: number,
  observations: readonly VarianceCaseRun[],
  cases: readonly EvalCase[],
  corpusChunkById: ReadonlyMap<string, OverlapCandidateChunk>,
  corpusDir?: string,
): Promise<RecallByPass> {
  const caseById = new Map(cases.map((evalCase) => [evalCase.id, evalCase]));
  const runObservations = observations.filter((observation) => observation.runIndex === runIndex);

  const caseResults: CaseResult[] = await Promise.all(
    runObservations.map(async (observation): Promise<CaseResult> => {
      const evalCase = caseById.get(observation.caseId);
      if (!evalCase) {
        throw new Error(
          `recall-from-observations: observation references case '${observation.caseId}', which ` +
            `is not in the current dataset — the variance result predates a dataset change`,
        );
      }
      return {
        id: evalCase.id,
        category: evalCase.category,
        actualOutcomeKind: observation.outcomeKind,
        retrievedOverlaps: await buildRetrievedOverlaps(
          observation,
          evalCase,
          corpusChunkById,
          corpusDir,
        ),
        citationOverlaps: [],
        canaryOwnVoiceLeaked: false,
        canaryVerifiedQuoteLeaked: false,
        answerContentCheck: null,
        conflictScopeCheck: null,
        totalClaimCount: 0,
        tabularClaimCount: 0,
        tabularGroundedCount: 0,
        atomDroppedClaimCount: 0,
        contradictionDroppedClaimCount: 0,
      };
    }),
  );

  return { runIndex, recall: computeMetrics(caseResults).retrieval };
}

function spread(values: readonly number[]): RecallSpread {
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

/** Whether `value` sits inside `[spread.min, spread.max]`, inclusive — the direct answer to "does
 * the floor fall inside the observed band". */
export function isWithinSpread(value: number, valueSpread: RecallSpread): boolean {
  return value >= valueSpread.min && value <= valueSpread.max;
}

/**
 * Whether an expected locator was ever hit by a retrieved chunk on any pass — the union across all
 * passes, not any single one, so a locator with a genuine but rare hit is not scored as unmatched
 * merely because one pass's retrieval missed it. A locator unmatched across every pass and every
 * chunk retrieved for its case is the signal a tight, sub-floor spread cannot itself distinguish
 * from a genuine regression: the dataset's ground truth no longer matches anything retrieval can
 * find, independent of run-to-run variance.
 */
export async function findUnmatchedLocators(
  observations: readonly VarianceCaseRun[],
  cases: readonly EvalCase[],
  corpusChunkById: ReadonlyMap<string, OverlapCandidateChunk>,
  corpusDir?: string,
): Promise<readonly UnmatchedLocator[]> {
  const retrievedChunkIdsByCaseId = new Map<string, Set<string>>();
  for (const observation of observations) {
    const existing = retrievedChunkIdsByCaseId.get(observation.caseId) ?? new Set<string>();
    for (const chunkId of observation.retrievedChunkIds) {
      existing.add(chunkId);
    }
    retrievedChunkIdsByCaseId.set(observation.caseId, existing);
  }

  const unmatched: UnmatchedLocator[] = [];
  for (const evalCase of cases) {
    const retrievedChunkIds = retrievedChunkIdsByCaseId.get(evalCase.id) ?? new Set<string>();
    const chunks = [...retrievedChunkIds].map((chunkId) => resolveChunk(chunkId, corpusChunkById));

    for (const locator of evalCase.expectedLocators) {
      const matches = await Promise.all(
        chunks.map((chunk) => chunkOverlapsLocator(chunk, locator, corpusDir)),
      );
      if (!matches.some(Boolean)) {
        unmatched.push({ caseId: evalCase.id, locator });
      }
    }
  }
  return unmatched;
}

/**
 * Top-level entry point: given one parsed variance result, the current dataset, and the eval
 * tenant's chunks read live from Mongo, computes recall@5/recall@10 per pass through the real
 * scoring path and the cross-pass spread, plus the unmatched-locator count that signals a stale
 * dataset rather than variance. Throws before computing anything if the dataset and the result
 * have diverged in either direction: a dataset case with no observation
 * (`assertEveryCaseObserved`), or a retrieved chunk id that does not resolve against the corpus
 * (`assertRetrievedChunksResolve`).
 */
export async function recallFromVariance(
  observations: readonly VarianceCaseRun[],
  cases: readonly EvalCase[],
  corpusChunkById: ReadonlyMap<string, OverlapCandidateChunk>,
  corpusDir?: string,
): Promise<RecallFromVarianceResult> {
  assertEveryCaseObserved(cases, observations);
  assertRetrievedChunksResolve(observations, corpusChunkById);

  const runIndexes = [...new Set(observations.map((observation) => observation.runIndex))].sort(
    (a, b) => a - b,
  );
  const byPass = await Promise.all(
    runIndexes.map((runIndex) =>
      computeRecallForPass(runIndex, observations, cases, corpusChunkById, corpusDir),
    ),
  );

  const unmatchedLocators = await findUnmatchedLocators(
    observations,
    cases,
    corpusChunkById,
    corpusDir,
  );

  return {
    byPass,
    recallAt5Spread: spread(byPass.map((pass) => pass.recall.recallAt5)),
    recallAt10Spread: spread(byPass.map((pass) => pass.recall.recallAt10)),
    locatorBearingCaseCount: cases.filter((evalCase) => evalCase.expectedLocators.length > 0)
      .length,
    totalExpectedLocatorCount: cases.reduce(
      (sum, evalCase) => sum + evalCase.expectedLocators.length,
      0,
    ),
    unmatchedLocators,
  };
}
