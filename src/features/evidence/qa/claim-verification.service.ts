import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import type { FactKey } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../../../providers/model/model-provider.interface';
import { formatPromptLabel } from '../../../shared/utils/format-prompt-label.util';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { ConflictsService } from '../conflicts/conflicts.service';
import { FactsService } from '../facts/facts.service';
import { sanitizeEvidenceText } from '../ingestion/sanitize-evidence-text';
import { claimSchema, type Citation, type Claim } from './contracts/answer.contract';
import {
  modelVerifyClaimContractSchema,
  VERIFY_CLAIMS_ADVISORY,
  type ClaimVerdict,
  type VerifyClaimResult,
  type VerifyClaimsResult,
} from './contracts/verify-claims.contract';
import { EvidenceRetrievalService } from './evidence-retrieval.service';
import { extractNumericTokens } from './extract-numeric-tokens';
import { factKeysMatch } from './grounding-gate.service';
import { assembleVerifyClaimMessages } from './prompts/assemble-verify-claim-messages';
import type { RetrievedChunk } from './types/retrieved-chunk.type';
import { verifyClaim, type GroundingCellFact } from './verify-claim';

export interface VerifyClaimsInput {
  readonly claims: readonly string[];
  readonly tenantId: string;
}

/** How many of `EvidenceRetrievalService.retrieve`'s hits are shown to the model per claim.
 *  Deliberately below `config.retrieval.limit`: that value is tuned for writing a multi-claim
 *  answer over the whole corpus, not for locating the evidence behind one already-drafted
 *  sentence, which needs a narrow shortlist. */
const CANDIDATE_LIMIT = 5;

/** The model's entire output for one claim is a boolean, an index, and a short quote — not a
 *  multi-claim answer — so this stays far below `SynthesisService`'s output/spend caps. */
const MAX_OUTPUT_TOKENS = 512;
const MAX_COST_USD = 0.25;

/**
 * Grades claim text drafted by another AI assistant against this tenant's corpus. Per claim,
 * independently: retrieve, short-circuit on no evidence, ask the model to point at (or decline to
 * point at) supporting candidates, then run the retrieved citations through the same deterministic
 * `verifyClaim` gate `GroundingGateService` uses for synthesis. Never calls
 * `GroundingGateService.verify` itself — that method collapses every claim in one answer into a
 * single outcome, where this needs N independent verdicts — and never reuses `SynthesisService`'s
 * answer prompt, which rewards writing an answer rather than checking one. Writes nothing: no
 * `Answer` row, no persistence of any kind.
 */
@Injectable()
export class ClaimVerificationService {
  constructor(
    @Inject(MODEL_PROVIDER)
    private readonly modelProvider: ModelProvider,

    private readonly evidenceRetrievalService: EvidenceRetrievalService,
    private readonly factsService: FactsService,
    private readonly conflictsService: ConflictsService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(ClaimVerificationService.name);
  }

  /**
   * Verifies `input.claims` in submission order and returns one `VerifyClaimResult` per claim
   * alongside the fixed `VERIFY_CLAIMS_ADVISORY`. Claims run sequentially, never as an unbounded
   * `Promise.all` — the claim list is caller-supplied (an MCP tool argument), so fanning it out
   * unbounded would let one tool call issue an unbounded number of concurrent model calls.
   *
   * A model-call failure (spend refusal, provider throw, schema-validation exhaustion, timeout)
   * propagates out of this call rather than becoming a verdict for the claim it happened on:
   * `no_evidence_retrieved` would misreport that no evidence was found, and `not_grounded` would
   * assert a negative finding nobody actually made. There is accordingly no partial-results path —
   * a failure on any claim fails the whole call.
   */
  async verifyClaims(input: VerifyClaimsInput): Promise<VerifyClaimsResult> {
    const results: VerifyClaimResult[] = [];
    for (const [claimIndex, statement] of input.claims.entries()) {
      results.push(await this.verifyOneClaim(statement, claimIndex, input.tenantId));
    }
    return { advisory: VERIFY_CLAIMS_ADVISORY, results };
  }

  private async verifyOneClaim(
    statement: string,
    claimIndex: number,
    tenantId: string,
  ): Promise<VerifyClaimResult> {
    // The sanitized/collapsed form is for the retrieval query and the prompt only — check 3/4
    // below (via `verifyClaim`) run against `statement` as the caller actually wrote it.
    const sanitized = formatPromptLabel(sanitizeEvidenceText(statement));

    const retrieved = await this.evidenceRetrievalService.retrieve({
      questionText: sanitized,
      tenantId,
    });
    const candidates = retrieved.slice(0, CANDIDATE_LIMIT);

    if (candidates.length === 0) {
      return { claimIndex, verdict: 'no_evidence_retrieved' };
    }

    const chunkIds = candidates.map((candidate) => candidate.chunkId);
    const [cellFactDocs, conflictGroups] = await Promise.all([
      this.factsService.findCellFacts(chunkIds, tenantId),
      this.conflictsService.findConflictedFactGroupsForChunks(chunkIds, tenantId),
    ]);
    // Same `ExtractedFactDocument` -> `GroundingCellFact` projection `src/worker/activities.ts`'s
    // `groundingCheck` activity applies before calling `GroundingGateService.verify`.
    const cellFacts: GroundingCellFact[] = cellFactDocs.map((fact) => ({
      chunkId: fact.chunkId,
      factKey: {
        entity: fact.factKey.entity,
        metric: fact.factKey.metric,
        period: fact.factKey.period,
      },
      value: { amount: fact.value.amount, unit: fact.value.unit },
      locator: fact.locator,
    }));
    const conflictedFactKeys: readonly FactKey[] = conflictGroups.map((group) => group.factKey);

    const { system, messages } = assembleVerifyClaimMessages({ claim: sanitized, candidates });
    const modelResult = await this.modelProvider.generate({
      taskClass: 'claim_verification',
      system,
      messages,
      outputSchema: modelVerifyClaimContractSchema,
      maxTokens: MAX_OUTPUT_TOKENS,
      maxCostUsd: MAX_COST_USD,
      tenantId,
    });

    // The model abstained: no citations to resolve or verify, and no violation occurred that a
    // `GroundingViolationKind` could honestly name — see `VerifyClaimResult.reasonCode`'s doc
    // comment for why this branch never carries one.
    if (!modelResult.output.supported) {
      return { claimIndex, verdict: 'not_grounded' };
    }

    const citations: Citation[] = modelResult.output.citations.map((modelCitation) => {
      // Bounds-checked server-side: `candidateIndex` is a plain integer the model could return
      // out of range, and `candidates[...]` would silently type as `RetrievedChunk` either way —
      // an out-of-range index means the model named a candidate that was never offered, which is
      // an invariant violation, not a shape this call has a verdict for.
      if (modelCitation.candidateIndex >= candidates.length) {
        throw new InternalServerErrorException(
          `Claim verification model cited candidate index ${modelCitation.candidateIndex}, ` +
            `outside the ${candidates.length} candidate(s) offered for claim ${claimIndex}`,
        );
      }
      const candidate: RetrievedChunk = candidates[modelCitation.candidateIndex];
      return {
        chunkId: candidate.chunkId,
        docVersionId: candidate.docVersionId,
        sha256: candidate.sha256,
        locator: candidate.locator,
        quote: modelCitation.quote,
      };
    });

    // Built through `claimSchema.parse` rather than an object literal, so the schema's
    // `citations.min(1)` invariant is enforced (`modelVerifyClaimContractSchema`'s
    // `supportedOutcomeSchema` already guarantees at least one, but the raw claim text under
    // verification is `statement`, never `sanitized`, so it is worth parsing on the actual shape
    // handed to `verifyClaim` rather than assuming it).
    const claim = claimSchema.parse({ statement, citations });
    const verification = verifyClaim({ claim, retrievedChunks: candidates, cellFacts });

    if (verification.kind === 'dropped') {
      // `verification.violations[0].kind` — the bounded `GroundingViolationKind` — never
      // `verification.dropped.reason`, which is free text assembled from claim and chunk content
      // and would send that text back over the wire to another AI assistant.
      return { claimIndex, verdict: 'not_grounded', reasonCode: verification.violations[0].kind };
    }

    const proseTouchedFactKeys = await this.findProseTouchedFactKeys(verification.claim, tenantId);
    const touchesConflict = [...verification.touchedFactKeys, ...proseTouchedFactKeys].some(
      (touchedKey) =>
        conflictedFactKeys.some((conflicted) => factKeysMatch(touchedKey, conflicted)),
    );
    const verdict: ClaimVerdict = touchesConflict ? 'conflicting_evidence' : 'grounded';

    return { claimIndex, verdict, citations: verification.claim.citations };
  }

  /**
   * The prose-conflict-downgrade signal `verifyClaim`'s `touchedFactKeys` structurally cannot
   * carry: check 4's `cellFacts` is `xlsx-cell`-only (`FactsService.findCellFacts`'s own doc
   * comment), so a claim resting on a conflicted fact extracted from prose never touches it there,
   * and `cellFacts` itself must stay `xlsx-cell`-only — check 4 treats a chunk carrying any cell
   * fact as authoritative for numbers and disables its raw-chunk-text fallback accordingly, a
   * behavior this method must not disturb. Computed independently: every fact — any locator kind —
   * on the claim's own cited chunks, kept only when its value is one the claim's statement actually
   * states (mirrors check 4's value match) and its `factKey.entity`, trimmed and lowercased, occurs
   * as a substring of the claim statement lowercased the same way. Exact/substring only, never
   * fuzzy — a chunk carrying several entities' facts (an xlsx row window, a prose page) must not
   * attach an unrelated entity's conflict to this claim, the defect `scope-conflict-to-question.ts`
   * exists to prevent on the answer path.
   */
  private async findProseTouchedFactKeys(
    claim: Claim,
    tenantId: string,
  ): Promise<readonly FactKey[]> {
    const citedChunkIds = [...new Set(claim.citations.map((citation) => citation.chunkId))];
    const facts = await this.factsService.findFactsForChunks(citedChunkIds, tenantId);

    const statedNumbers = new Set(extractNumericTokens(claim.statement));
    const normalizedStatement = claim.statement.trim().toLowerCase();

    return (
      facts
        .filter((fact) => statedNumbers.has(fact.value.amount))
        // `factKey.entity` is a schema-required, trimmed field (`extracted-fact.schema.ts`), so it
        // is never empty here — no guard needed against an empty string vacuously "occurring" in
        // every statement.
        .filter((fact) => normalizedStatement.includes(fact.factKey.entity.trim().toLowerCase()))
        .map((fact) => ({
          entity: fact.factKey.entity,
          metric: fact.factKey.metric,
          period: fact.factKey.period,
        }))
    );
  }
}
