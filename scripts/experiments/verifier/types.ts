import type { Citation } from '../../../src/features/evidence/qa/contracts/answer.contract';
import type { ClaimVerdict } from '../../../src/features/evidence/qa/contracts/verify-claims.contract';
import type { GroundingViolationKind } from '../../../src/features/evidence/qa/types/grounding-report.type';
import type { RetrievedChunk } from '../../../src/features/evidence/qa/types/retrieved-chunk.type';
import type { EvidenceLocator } from '../../../src/database/schemas/evidence/evidence-chunk/evidence-locator.type';

/** One chunk of an already-ingested corpus document, as the drafting pass reads it. */
export interface CorpusChunk {
  readonly chunkId: string;
  readonly text: string;
  readonly tokenCount: number;
  readonly locator: EvidenceLocator;
}

/** One ingested document, its chunks in reading order. */
export interface CorpusDocument {
  readonly filename: string;
  readonly documentVersionId: string;
  readonly chunks: readonly CorpusChunk[];
}

/** Recorded on a claim drafted from a document too large for the drafting prompt whole: the leading
 *  chunk window used instead, and how it compares to the document's full size. */
export interface DraftWindow {
  readonly chunkCount: number;
  readonly tokenCount: number;
  readonly documentTokenCount: number;
}

/**
 * One claim the drafting model wrote, before verification. `claimId` is assigned by the harness and
 * is the join key across every artefact a run writes, including the hand-filled worksheet —
 * `VerifyClaimResult.claimIndex` cannot serve that role because it is batch-local.
 */
export interface DraftedClaim {
  readonly claimId: string;
  readonly statement: string;
  readonly sourceFilename: string;
  readonly draftPass: number;
  readonly draftWindow?: DraftWindow;
}

/** A drafted claim joined to the verdict `ClaimVerificationService.verifyClaims` returned for it. */
export interface ClaimOutcome extends DraftedClaim {
  readonly verdict: ClaimVerdict;
  readonly reasonCode?: GroundingViolationKind;
  readonly citations?: readonly Citation[];
}

/** Every `ClaimVerdict` counted, so a reader can see the whole distribution rather than the two
 *  verdicts the bars are computed on. */
export interface VerdictBreakdown {
  readonly grounded: number;
  readonly not_grounded: number;
  readonly no_evidence_retrieved: number;
  readonly conflicting_evidence: number;
}

/** The adjudication buckets. They are pre-registered and fixed for the life of the experiment. */
export type Adjudication = 'correct_catch' | 'false_catch';

/** One worksheet row read back after a human filled it. `adjudication` is `null` while the row is
 *  unfilled, which is a state the summary refuses to score rather than counting as either bucket. */
export interface AdjudicationRow {
  readonly claimId: string;
  readonly adjudication: Adjudication | null;
  readonly note: string;
}

/** A worksheet row whose adjudication field carried something outside {@link Adjudication}. */
export interface AdjudicationParseError {
  readonly claimId: string;
  readonly rawValue: string;
  readonly message: string;
}

export interface ParsedWorksheet {
  readonly rows: readonly AdjudicationRow[];
  readonly errors: readonly AdjudicationParseError[];
}

/** The retrieval hits shown under one claim on the worksheet, in rank order. */
export interface ClaimContext {
  readonly claimId: string;
  readonly hits: readonly RetrievedChunk[];
  readonly filenameByDocVersionId: Readonly<Record<string, string>>;
}

/** Which claims were drawn for adjudication, and how. The selected ids — not the seed — are the
 *  authoritative record: they stay valid if the generator ever changes. */
export interface AdjudicationSample {
  readonly seed: number;
  readonly populationSize: number;
  readonly claimIds: readonly string[];
}
