import { UnknownModelPricingError } from '../../../src/providers/model/errors/unknown-model-pricing.error';
import type { AnthropicPricePerMillion } from '../../../src/providers/model/anthropic-pricing.table';
import type { Selection } from './allowlist';
import type { CorpusFiling, CorpusManifest } from './corpus-manifest';

/** One manifest file's chunked size, computed offline by `size-corpus.ts` — no embedding or model
 *  call, so the counts here are exact over whatever file was parsed, never extrapolated. */
export interface FileSizing {
  readonly path: string;
  readonly cik: string;
  readonly accession: string;
  readonly form: string;
  readonly role: 'primary' | 'exhibit';
  readonly elements: number;
  readonly chunks: number;
  readonly proseChunks: number;
  readonly tableChunks: number;
  readonly tokens: number;
  readonly numericTokens: number;
}

export interface SizingBounds {
  readonly maxChunks: number;
  readonly maxSpendUsd: number;
  readonly maxHours: number;
}

export interface CostModel {
  readonly usdPerProseChunk: number;
  readonly secondsPerProseChunk: number;
  readonly source: 'measured-ledger' | 'analytic';
}

/**
 * A per-pass cost model built from the pricing table rather than a sample ingest — used before any
 * document has been paid for. `passCount` passes run concurrently per chunk
 * (`extractProseFacts`'s `Promise.allSettled` over `PASS_COUNT` calls), so dollars scale with
 * `passCount` (one paid call each) while wall-clock time does not: one chunk's wall time is
 * `secondsPerPass` regardless of how many passes run over it, and `concurrency` chunks are worked
 * on at once (`EXTRACTION_CHUNK_CONCURRENCY`), so the per-chunk contribution to total wall-clock is
 * `secondsPerPass / concurrency`.
 */
export function analyticCostModel(
  model: string,
  pricing: Readonly<Record<string, AnthropicPricePerMillion>>,
  passCount: number,
  inputTokensPerPass: number,
  outputTokensPerPass: number,
  concurrency: number,
  secondsPerPass: number,
): CostModel {
  const perModelPricing = pricing[model];
  if (!perModelPricing) {
    throw new UnknownModelPricingError(model);
  }

  const usdPerPass =
    (inputTokensPerPass * perModelPricing.input + outputTokensPerPass * perModelPricing.output) /
    1_000_000;

  return {
    usdPerProseChunk: passCount * usdPerPass,
    secondsPerProseChunk: secondsPerPass / concurrency,
    source: 'analytic',
  };
}

/** Ranks a filing's `form` for the walk order below; a form absent from this table (never expected
 *  once `applySelection`'s `FORMS` allowlist holds) sorts after every known form. */
const FORM_WALK_PRIORITY: Readonly<Record<string, number>> = { '10-K': 0, '10-Q': 1 };

export interface WalkStep {
  readonly accession: string;
  readonly cumulativeChunks: number;
  readonly cumulativeSpendUsd: number;
  readonly cumulativeHours: number;
}

export interface WalkResult {
  readonly selection: Selection;
  readonly totals: {
    readonly documents: number;
    readonly chunks: number;
    readonly proseChunks: number;
    readonly spendUsd: number;
    readonly hours: number;
  };
  readonly stoppedBy: 'maxChunks' | 'maxSpendUsd' | 'maxHours' | 'exhausted';
  readonly walk: readonly WalkStep[];
}

/**
 * Walks `manifest.filings` in the pre-registered order — registrants in allowlist order, filings
 * by `filingDate` descending, `10-K` before `10-Q`, exhibits carried along with their own filing —
 * accumulating each filing's `FileSizing` totals until the next filing would push cumulative chunks
 * over `bounds.maxChunks`, cumulative prose-chunk spend over `bounds.maxSpendUsd`, or cumulative
 * prose-chunk wall-clock over `bounds.maxHours`. Stops before that filing (never partially) and
 * reports which bound stopped it; `stoppedBy: 'exhausted'` when every filing fit.
 *
 * `selection` is a conservative reading back into `Selection`'s four-field shape: only a
 * registrant whose filings the walk finished entirely (never the registrant the walk stopped
 * inside) counts toward `registrantCount`, and `maxFilingsPerRegistrantPerForm` is capped to the
 * fewest per-form filings any such registrant contributed. Replaying `applySelection` with this
 * `selection` over the full manifest can therefore only select a subset of what this walk approved
 * — never more.
 */
export function walkSelection(
  files: readonly FileSizing[],
  manifest: CorpusManifest,
  bounds: SizingBounds,
  cost: CostModel,
): WalkResult {
  const registrantIndex = new Map(
    manifest.allowlist.registrants.map((registrant, index) => [registrant.cik, index]),
  );
  const orderOf = (cik: string): number => registrantIndex.get(cik) ?? Number.MAX_SAFE_INTEGER;

  const filesByFiling = new Map<string, FileSizing[]>();
  for (const file of files) {
    const key = `${file.cik}:${file.accession}`;
    const bucket = filesByFiling.get(key);
    if (bucket) {
      bucket.push(file);
    } else {
      filesByFiling.set(key, [file]);
    }
  }

  const orderedFilings = [...manifest.filings].sort((left: CorpusFiling, right: CorpusFiling) => {
    const cikDiff = orderOf(left.cik) - orderOf(right.cik);
    if (cikDiff !== 0) {
      return cikDiff;
    }
    if (left.filingDate !== right.filingDate) {
      return left.filingDate < right.filingDate ? 1 : -1;
    }
    const formDiff =
      (FORM_WALK_PRIORITY[left.form] ?? Number.MAX_SAFE_INTEGER) -
      (FORM_WALK_PRIORITY[right.form] ?? Number.MAX_SAFE_INTEGER);
    if (formDiff !== 0) {
      return formDiff;
    }
    return left.accession.localeCompare(right.accession);
  });

  let cumulativeChunks = 0;
  let cumulativeProseChunks = 0;
  let cumulativeDocuments = 0;
  const walk: WalkStep[] = [];
  const perFormCountByRegistrant = new Map<string, Map<string, number>>();
  let stoppedBy: WalkResult['stoppedBy'] = 'exhausted';
  let stoppedAtCik: string | undefined;

  for (const filing of orderedFilings) {
    const filingFiles = filesByFiling.get(`${filing.cik}:${filing.accession}`) ?? [];
    if (filingFiles.length === 0) {
      continue;
    }

    const filingChunks = filingFiles.reduce((sum, file) => sum + file.chunks, 0);
    const filingProseChunks = filingFiles.reduce((sum, file) => sum + file.proseChunks, 0);
    const nextChunks = cumulativeChunks + filingChunks;
    const nextProseChunks = cumulativeProseChunks + filingProseChunks;
    const nextSpendUsd = nextProseChunks * cost.usdPerProseChunk;
    const nextHours = (nextProseChunks * cost.secondsPerProseChunk) / 3600;

    if (nextChunks > bounds.maxChunks) {
      stoppedBy = 'maxChunks';
      stoppedAtCik = filing.cik;
      break;
    }
    if (nextSpendUsd > bounds.maxSpendUsd) {
      stoppedBy = 'maxSpendUsd';
      stoppedAtCik = filing.cik;
      break;
    }
    if (nextHours > bounds.maxHours) {
      stoppedBy = 'maxHours';
      stoppedAtCik = filing.cik;
      break;
    }

    cumulativeChunks = nextChunks;
    cumulativeProseChunks = nextProseChunks;
    cumulativeDocuments += filingFiles.length;

    const formCounts = perFormCountByRegistrant.get(filing.cik) ?? new Map<string, number>();
    formCounts.set(filing.form, (formCounts.get(filing.form) ?? 0) + 1);
    perFormCountByRegistrant.set(filing.cik, formCounts);

    walk.push({
      accession: filing.accession,
      cumulativeChunks,
      cumulativeSpendUsd: cumulativeProseChunks * cost.usdPerProseChunk,
      cumulativeHours: (cumulativeProseChunks * cost.secondsPerProseChunk) / 3600,
    });
  }

  const fullyRepresentedCiks = [...perFormCountByRegistrant.keys()].filter(
    (cik) => cik !== stoppedAtCik,
  );
  const registrantCount =
    fullyRepresentedCiks.length > 0 ? Math.max(...fullyRepresentedCiks.map(orderOf)) + 1 : 0;

  let maxFilingsPerRegistrantPerForm = Number.POSITIVE_INFINITY;
  for (const cik of fullyRepresentedCiks) {
    const formCounts = perFormCountByRegistrant.get(cik);
    if (!formCounts) {
      continue;
    }
    for (const count of formCounts.values()) {
      maxFilingsPerRegistrantPerForm = Math.min(maxFilingsPerRegistrantPerForm, count);
    }
  }
  if (!Number.isFinite(maxFilingsPerRegistrantPerForm)) {
    maxFilingsPerRegistrantPerForm = 0;
  }

  return {
    selection: {
      registrantCount,
      filedFrom: manifest.allowlist.filedFrom,
      filedTo: manifest.allowlist.filedTo,
      maxFilingsPerRegistrantPerForm,
    },
    totals: {
      documents: cumulativeDocuments,
      chunks: cumulativeChunks,
      proseChunks: cumulativeProseChunks,
      spendUsd: cumulativeProseChunks * cost.usdPerProseChunk,
      hours: (cumulativeProseChunks * cost.secondsPerProseChunk) / 3600,
    },
    stoppedBy,
    walk,
  };
}
