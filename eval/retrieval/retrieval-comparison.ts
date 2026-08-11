import type { mongo } from 'mongoose';
import type { EmbeddingProvider } from '../../src/providers/embedding/embedding-provider.interface';
import type { EvalCase } from '../dataset/schema';
import { chunkOverlapsAnyLocator } from '../metrics/locator-overlap';
import { computeMetrics, type CaseResult } from '../metrics/compute-metrics';
import type { RetrievalModeSummary } from '../report';
import { RETRIEVAL_MODES, searchByMode } from './retrieval-modes';

// Matches the recall@10 metric — every retrieval-mode comparison run uses the same top-k so the
// three modes' recall/MRR figures are comparable to each other and to the production pipeline's.
export const RETRIEVAL_COMPARISON_LIMIT = 10;

export type SearchByMode = typeof searchByMode;

export interface RunRetrievalComparisonParams {
  readonly db: mongo.Db;
  readonly embeddingProvider: EmbeddingProvider;
  readonly filenameByDocVersionId: ReadonlyMap<string, string>;
  readonly cases: readonly EvalCase[];
  readonly tenantId: string;
  /** Injected for tests only. `mongodb-memory-server` cannot run `$search`/`$vectorSearch`/
   * `$rankFusion` (Atlas-only aggregation stages), so a unit test replaces this with a fake instead
   * of requiring live Mongo. Defaults to the real `searchByMode` for `eval/run.ts`. */
  readonly search?: SearchByMode;
}

/**
 * Runs each retrieval mode against every locator-bearing case and scores the hits against the
 * dataset's ground-truth locators — the ADR-0007 comparison table (work item 3).
 *
 * Scores hits with the chunk's real text (`hit.text`, populated by `searchByMode`'s `toHit` off
 * the same document the search already fetched — no second query). Feeding an empty string here
 * previously made `chunkOverlapsLocator`'s pdf-page/docx-paragraph branches — which match by text
 * containment — structurally unable to ever score, silently confining the comparison to
 * `xlsx-cell` locators (matched structurally by cell/range address, not text) and reporting a
 * denominator that implied every locator kind was measured.
 */
export async function runRetrievalComparison(
  params: RunRetrievalComparisonParams,
): Promise<RetrievalModeSummary[]> {
  const {
    db,
    embeddingProvider,
    filenameByDocVersionId,
    cases,
    tenantId,
    search = searchByMode,
  } = params;
  const locatorBearing = cases.filter((evalCase) => evalCase.expectedLocators.length > 0);

  const summaries: RetrievalModeSummary[] = [];
  for (const mode of RETRIEVAL_MODES) {
    const results: CaseResult[] = [];
    for (const evalCase of locatorBearing) {
      const hits = await search(db, embeddingProvider, mode, {
        text: evalCase.question,
        tenantId,
        limit: RETRIEVAL_COMPARISON_LIMIT,
      });
      const overlaps = await Promise.all(
        hits.map((hit) =>
          chunkOverlapsAnyLocator(
            {
              filename: filenameByDocVersionId.get(hit.documentVersionId) ?? '',
              text: hit.text,
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
    // `computeRecallMetrics` excludes a case with an empty `retrievedOverlaps` array (a case this
    // mode returned zero hits for) from `retrieval.caseCount` — see that function's doc comment.
    // `totalCases` below is the denominator that would apply if every attempted case had scored,
    // so a reader can tell a mode that silently dropped cases from one that simply has a smaller
    // dataset to measure against.
    const { retrieval } = computeMetrics(results);
    summaries.push({
      mode,
      recallAt5: retrieval.recallAt5,
      recallAt10: retrieval.recallAt10,
      mrr: retrieval.mrr,
      caseCount: retrieval.caseCount,
      totalCases: locatorBearing.length,
    });
  }
  return summaries;
}
