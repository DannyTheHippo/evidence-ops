import type { VerifyClaimsResult } from '../../../src/features/evidence/qa/contracts/verify-claims.contract';
import type { RetrievedChunk } from '../../../src/features/evidence/qa/types/retrieved-chunk.type';
import { batchClaims } from './batch-claims';
import { buildWorksheet } from './build-worksheet';
import { joinVerdicts } from './join-verdicts';
import { sampleForAdjudication } from './sample-for-adjudication';
import type {
  AdjudicationSample,
  ClaimContext,
  ClaimOutcome,
  CorpusDocument,
  DraftedClaim,
  DraftWindow,
  VerdictBreakdown,
} from './types';
import {
  BAR_1_MIN_GATE_FAILURE_RATE,
  countVerdicts,
  evaluateBar,
  gateFailureRate,
  isGateFailure,
  type BarResult,
} from './verdict-metrics';

export const CLAIMS_ARTEFACT = 'claims.json';
export const VERDICTS_ARTEFACT = 'verdicts.json';
export const WORKSHEET_ARTEFACT = 'worksheet.md';
export const RUN_ARTEFACT = 'run.json';

/** A drafting pass's output: the statements it wrote, and — only when the document had to be
 *  trimmed to fit the drafting budget — the window that was actually drafted from. */
export interface DraftForDocumentResult {
  readonly statements: readonly string[];
  readonly draftWindow?: DraftWindow;
}

export interface RunExperimentDeps {
  readonly draftForDocument: (
    document: CorpusDocument,
    passOrdinal: number,
  ) => Promise<DraftForDocumentResult>;
  readonly verifyBatch: (statements: readonly string[]) => Promise<VerifyClaimsResult>;
  /** Retrieval for the worksheet only. The caller applies the same query transform
   *  `ClaimVerificationService` applies, so the hits shown are the hits the gate saw. */
  readonly retrieveContext: (statement: string) => Promise<readonly RetrievedChunk[]>;
  readonly writeArtefact: (filename: string, content: string) => Promise<void>;
  readonly log: (message: string) => void;
}

/** Which documents a run drafted from, without the parsed corpus itself — the record other tooling
 *  reads back does not need the chunks, only what was sampled and from how large a population. */
export interface DocumentSampleSummary {
  readonly seed: number;
  readonly populationSize: number;
  readonly filenames: readonly string[];
}

export interface RunExperimentOptions {
  readonly runId: string;
  readonly gitSha: string;
  readonly tenantId: string;
  readonly maxBatchSize: number;
  readonly seed: number;
  readonly filenameByDocVersionId: Readonly<Record<string, string>>;
  /** Absent when the run drafted from the whole corpus rather than a bounded sample of it. */
  readonly documentSample?: DocumentSampleSummary;
}

/** `run.json`: everything the summary command needs that the worksheet does not carry. */
export interface RunRecord {
  readonly runId: string;
  readonly gitSha: string;
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly totalClaims: number;
  readonly duplicatesDropped: number;
  readonly breakdown: VerdictBreakdown;
  readonly gateFailureCount: number;
  readonly bar1: BarResult;
  readonly sample: AdjudicationSample;
  readonly documentSample?: DocumentSampleSummary;
  readonly windowedDocumentCount: number;
}

function normalizeForDedupe(statement: string): string {
  return statement.toLowerCase().replace(/\s+/g, ' ').trim();
}

function formatClaimId(ordinal: number): string {
  return `c${String(ordinal).padStart(3, '0')}`;
}

/**
 * The whole experiment as one pass over injected model, retrieval and persistence calls: draft per
 * document, verify in batches the tool's own cap allows, sample the gate failures, and write the
 * four artefacts.
 *
 * Artefacts are written as soon as they exist — claims before any verification runs, verdicts after
 * each batch — because `verifyClaims` fails a whole call on a single model failure. A run that dies
 * on batch 7 must still leave batches 1-6 auditable, and the read-through model cache makes the
 * re-run cheap.
 *
 * Statements that repeat one already drafted (case- and whitespace-insensitive) are dropped rather
 * than verified twice: two identical claims are not two independent observations, and counting them
 * as such moves the rate both bars are read against.
 */
export async function runExperiment(
  documents: readonly CorpusDocument[],
  deps: RunExperimentDeps,
  options: RunExperimentOptions,
): Promise<RunRecord> {
  const drafted: DraftedClaim[] = [];
  const seenStatements = new Set<string>();
  let duplicatesDropped = 0;
  let windowedDocumentCount = 0;

  for (const [passOrdinal, document] of documents.entries()) {
    const { statements, draftWindow } = await deps.draftForDocument(document, passOrdinal);
    if (draftWindow !== undefined) {
      windowedDocumentCount += 1;
    }
    let keptForDocument = 0;
    for (const statement of statements) {
      const normalized = normalizeForDedupe(statement);
      if (seenStatements.has(normalized)) {
        duplicatesDropped += 1;
        continue;
      }
      seenStatements.add(normalized);
      drafted.push({
        claimId: formatClaimId(drafted.length + 1),
        statement,
        sourceFilename: document.filename,
        draftPass: passOrdinal,
        ...(draftWindow === undefined ? {} : { draftWindow }),
      });
      keptForDocument += 1;
    }
    deps.log(
      draftWindow === undefined
        ? `drafted ${keptForDocument} claim(s) from ${document.filename}`
        : `drafted ${keptForDocument} claim(s) from ${document.filename} ` +
            `(window: ${draftWindow.tokenCount} of ${draftWindow.documentTokenCount} tokens)`,
    );
  }

  if (drafted.length === 0) {
    throw new Error('runExperiment: the drafting pass produced no claims');
  }
  deps.log(`drafted ${drafted.length} claim(s) total, dropped ${duplicatesDropped} duplicate(s)`);

  await deps.writeArtefact(
    CLAIMS_ARTEFACT,
    `${JSON.stringify(
      {
        runId: options.runId,
        gitSha: options.gitSha,
        tenantId: options.tenantId,
        duplicatesDropped,
        claims: drafted,
      },
      null,
      2,
    )}\n`,
  );

  const outcomes: ClaimOutcome[] = [];
  const batches = batchClaims(drafted, options.maxBatchSize);
  let advisory = '';
  for (const [batchIndex, batch] of batches.entries()) {
    const result = await deps.verifyBatch(batch.map((claim) => claim.statement));
    advisory = result.advisory;
    outcomes.push(...joinVerdicts(batch, result.results));
    await deps.writeArtefact(
      VERDICTS_ARTEFACT,
      `${JSON.stringify({ runId: options.runId, advisory, verdicts: outcomes }, null, 2)}\n`,
    );
    deps.log(
      `verified batch ${batchIndex + 1}/${batches.length} (${outcomes.length} claim(s) done)`,
    );
  }

  const breakdown = countVerdicts(outcomes);
  const failures = outcomes.filter(isGateFailure);
  const sample = sampleForAdjudication(failures, options.seed);
  const sampledIds = new Set(sample.claimIds);
  const sampled = failures.filter((outcome) => sampledIds.has(outcome.claimId));

  const contexts: ClaimContext[] = [];
  for (const outcome of sampled) {
    contexts.push({
      claimId: outcome.claimId,
      hits: await deps.retrieveContext(outcome.statement),
      filenameByDocVersionId: options.filenameByDocVersionId,
    });
  }

  await deps.writeArtefact(
    WORKSHEET_ARTEFACT,
    buildWorksheet({
      runId: options.runId,
      gitSha: options.gitSha,
      tenantId: options.tenantId,
      totalClaims: outcomes.length,
      breakdown,
      sample,
      sampled,
      contexts,
      corpusFilenames: documents.map((document) => document.filename),
    }),
  );

  const record: RunRecord = {
    runId: options.runId,
    gitSha: options.gitSha,
    tenantId: options.tenantId,
    generatedAt: new Date().toISOString(),
    totalClaims: outcomes.length,
    duplicatesDropped,
    breakdown,
    gateFailureCount: breakdown.not_grounded + breakdown.no_evidence_retrieved,
    bar1: evaluateBar(gateFailureRate(breakdown), BAR_1_MIN_GATE_FAILURE_RATE),
    sample,
    ...(options.documentSample === undefined ? {} : { documentSample: options.documentSample }),
    windowedDocumentCount,
  };
  await deps.writeArtefact(RUN_ARTEFACT, `${JSON.stringify(record, null, 2)}\n`);

  return record;
}
