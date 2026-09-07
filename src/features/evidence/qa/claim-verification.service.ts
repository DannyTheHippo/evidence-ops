import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { normalizeEntityName } from '../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';
import type { FactKey } from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type {
  VerificationRequester,
  VerificationUsage,
} from '../../../database/schemas/evidence/verification/verification.schema';
import {
  MODEL_PROVIDER,
  type ModelProvider,
} from '../../../providers/model/model-provider.interface';
import { formatPromptLabel } from '../../../shared/utils/format-prompt-label.util';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { ConflictsService } from '../conflicts/conflicts.service';
import {
  CanonicalEntityService,
  type CanonicalEntityListing,
} from '../facts/canonical-entity.service';
import { FactsService } from '../facts/facts.service';
import type { MeasureDefinition } from '../measures/measure-definition';
import { MeasuresService } from '../measures/measures.service';
import { VerificationsService } from '../verifications/verifications.service';
import { sanitizeEvidenceText } from '../ingestion/sanitize-evidence-text';
import { claimSchema, type Citation, type Claim } from './contracts/answer.contract';
import {
  modelVerifyClaimContractSchema,
  VERIFY_CLAIMS_ADVISORY,
  type ClaimVerdict,
  type VerifyClaimResult,
  type VerifyClaimsResult,
} from './contracts/verify-claims.contract';
import { ClaimDecompositionService } from './claim-decomposition.service';
import { ContradictionCheckService } from './contradiction-check.service';
import { EvidenceRetrievalService } from './evidence-retrieval.service';
import { extractNumericTokens } from './extract-numeric-tokens';
import { factKeysMatch } from './grounding-gate.service';
import { assembleVerifyClaimMessages } from './prompts/assemble-verify-claim-messages';
import type { ClaimAtoms } from './types/claim-atoms.type';
import type { RetrievedChunk } from './types/retrieved-chunk.type';
import type { VerifierMeasure } from './types/verifier-measure.type';
import { containsNormalizedToken, verifyClaim, type GroundingCellFact } from './verify-claim';

export interface VerifyClaimsInput {
  readonly claims: readonly string[];
  readonly tenantId: string;
  readonly requestedBy: VerificationRequester;
}

/** How many of `EvidenceRetrievalService.retrieve`'s hits are shown to the model per claim.
 *  Deliberately below `config.retrieval.limit`: that value is tuned for writing a multi-claim
 *  answer over the whole corpus, not for locating the evidence behind one already-drafted
 *  sentence, which needs a narrow shortlist. */
const CANDIDATE_LIMIT = 5;

/** Bounds this call's output spend. The emitted verdict is small — a boolean, an index, and up to
 *  three short quotes — but the cap covers the model's thinking tokens too: adaptive thinking draws
 *  from the same `maxTokens` budget as the visible output, so a claim whose verification needs a
 *  comparison across several candidates spends most of this on reasoning and the rest on JSON. Sized
 *  for that reasoning rather than for the verdict; a cap sized for the verdict alone truncates the
 *  JSON mid-token and the call fails rather than returning a wrong verdict.
 *
 *  `MAX_COST_USD` binds well above this: at the verification model's rate it admits an output cap in
 *  the thousands of tokens for a typical five-candidate prompt, so the token cap is the operative
 *  limit and the cost cap is the backstop. */
const MAX_OUTPUT_TOKENS = 4096;
const MAX_COST_USD = 0.25;

const ZERO_VERIFICATION_USAGE: VerificationUsage = {
  promptTokens: 0,
  completionTokens: 0,
  costUsd: 0,
};

function addUsage(a: VerificationUsage, b: VerificationUsage): VerificationUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** What `verifyOneClaim` reports back to `verifyClaims`: the claim's own `VerifyClaimResult`, the
 *  candidate chunk ids offered to the model for it (feeding the run's `retrievedChunkIds` union),
 *  its decomposed atoms when it survived with any (feeding the run's `atoms` list), and the usage
 *  summed across every model call this one claim made. */
interface OneClaimOutcome {
  readonly result: VerifyClaimResult;
  readonly candidateChunkIds: readonly string[];
  readonly atoms?: ClaimAtoms;
  readonly usage: VerificationUsage;
}

/**
 * Grades claim text drafted by another AI assistant against this tenant's corpus. Per claim,
 * independently: retrieve, short-circuit on no evidence, ask the model to point at (or decline to
 * point at) supporting candidates, then run the retrieved citations through the same deterministic
 * `verifyClaim` gate `GroundingGateService` uses for synthesis — decomposing a supported claim into
 * atoms via `ClaimDecompositionService` first, and, once the claim survives, applying
 * `ContradictionCheckService` as a veto-only downgrade when `config.verifier.contradictionCheck` is
 * on. Never calls `GroundingGateService.verify` itself — that method collapses every claim in one
 * answer into a single outcome, where this needs N independent verdicts — and never reuses
 * `SynthesisService`'s answer prompt, which rewards writing an answer rather than checking one.
 * Persists exactly one `VerificationsService.record` row per call, covering every claim submitted
 * in the run — never an `Answer` row.
 */
@Injectable()
export class ClaimVerificationService {
  constructor(
    @Inject(MODEL_PROVIDER)
    private readonly modelProvider: ModelProvider,

    private readonly evidenceRetrievalService: EvidenceRetrievalService,
    private readonly factsService: FactsService,
    private readonly conflictsService: ConflictsService,
    private readonly claimDecompositionService: ClaimDecompositionService,
    private readonly contradictionCheckService: ContradictionCheckService,
    private readonly canonicalEntityService: CanonicalEntityService,
    private readonly measuresService: MeasuresService,
    private readonly verificationsService: VerificationsService,
    private readonly config: TypedConfigService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(ClaimVerificationService.name);
  }

  /**
   * Verifies `input.claims` in submission order and returns one `VerifyClaimResult` per claim
   * alongside the fixed `VERIFY_CLAIMS_ADVISORY`. Confirmed measures and the canonical entity
   * registry are loaded once for the whole call, not once per claim, then forwarded to every
   * `verifyOneClaim`. Claims run sequentially, never as an unbounded `Promise.all` — the claim list
   * is caller-supplied (an MCP tool argument), so fanning it out unbounded would let one tool call
   * issue an unbounded number of concurrent model calls.
   *
   * A model-call failure (spend refusal, provider throw, schema-validation exhaustion, timeout)
   * propagates out of this call rather than becoming a verdict for the claim it happened on:
   * `no_evidence_retrieved` would misreport that no evidence was found, and `not_grounded` would
   * assert a negative finding nobody actually made. There is accordingly no partial-results path —
   * a failure on any claim fails the whole call, and nothing is recorded for it.
   *
   * Once every claim has a verdict, the whole run — `input.requestedBy`, every claim statement, the
   * union of candidate chunk ids offered across claims, every surviving claim's atoms, and the
   * summed usage of every model call the run made — is persisted in one `VerificationsService.record`
   * call, and `verificationId` on the returned result names that row.
   */
  async verifyClaims(input: VerifyClaimsInput): Promise<VerifyClaimsResult> {
    const [definitions, entities] = await Promise.all([
      this.measuresService.listConfirmedDefinitions(input.tenantId),
      this.canonicalEntityService.listCanonicalEntities(input.tenantId),
    ]);
    const measures = this.toVerifierMeasures(definitions);

    const results: VerifyClaimResult[] = [];
    const atoms: ClaimAtoms[] = [];
    const retrievedChunkIds = new Set<string>();
    let usage = ZERO_VERIFICATION_USAGE;

    for (const [claimIndex, statement] of input.claims.entries()) {
      const outcome = await this.verifyOneClaim(
        statement,
        claimIndex,
        input.tenantId,
        measures,
        entities,
      );
      results.push(outcome.result);
      for (const chunkId of outcome.candidateChunkIds) {
        retrievedChunkIds.add(chunkId);
      }
      if (outcome.atoms) {
        atoms.push(outcome.atoms);
      }
      usage = addUsage(usage, outcome.usage);
    }

    const { id: verificationId } = await this.verificationsService.record({
      tenantId: input.tenantId,
      requestedBy: input.requestedBy,
      claims: [...input.claims],
      results,
      advisory: VERIFY_CLAIMS_ADVISORY,
      retrievedChunkIds: [...retrievedChunkIds],
      atoms,
      usage,
    });

    return { advisory: VERIFY_CLAIMS_ADVISORY, results, verificationId };
  }

  /** Projects `MeasuresService.listConfirmedDefinitions`'s rows into the plain-data shape
   *  `verifyClaim`'s check 4 matches claims against — `slug = id`, the join key
   *  `ExtractedFact.factKey.metric` actually carries, never `measureId`. */
  private toVerifierMeasures(definitions: readonly MeasureDefinition[]): VerifierMeasure[] {
    return definitions.map((definition) => ({
      slug: definition.id,
      label: definition.label,
      aliases: definition.aliases,
      valueType: definition.valueType,
      canonicalUnit: definition.canonicalUnit,
      units: definition.units,
      toleranceKind: definition.toleranceKind,
      tolerance: definition.tolerance,
    }));
  }

  private async verifyOneClaim(
    statement: string,
    claimIndex: number,
    tenantId: string,
    measures: readonly VerifierMeasure[],
    entities: readonly CanonicalEntityListing[],
  ): Promise<OneClaimOutcome> {
    // The sanitized/collapsed form is for the retrieval query and the prompt only — check 3/4
    // below (via `verifyClaim`) run against `statement` as the caller actually wrote it.
    const sanitized = formatPromptLabel(sanitizeEvidenceText(statement));

    const retrieved = await this.evidenceRetrievalService.retrieve({
      questionText: sanitized,
      tenantId,
    });
    const candidates = retrieved.slice(0, CANDIDATE_LIMIT);

    if (candidates.length === 0) {
      return {
        result: { claimIndex, verdict: 'no_evidence_retrieved' },
        candidateChunkIds: [],
        usage: ZERO_VERIFICATION_USAGE,
      };
    }

    const candidateChunkIds = candidates.map((candidate) => candidate.chunkId);
    const [cellFactDocs, conflictGroups] = await Promise.all([
      this.factsService.findCellFacts(candidateChunkIds, tenantId),
      this.conflictsService.findConflictedFactGroupsForChunks(candidateChunkIds, tenantId),
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
    let usage: VerificationUsage = {
      // Cached tokens are still prompt tokens billed on the call that produced them — same
      // formula `synthesis.service.ts`'s usage computation uses.
      promptTokens:
        modelResult.usage.inputTokens +
        modelResult.usage.cacheCreationInputTokens +
        modelResult.usage.cacheReadInputTokens,
      completionTokens: modelResult.usage.outputTokens,
      costUsd: modelResult.costUsd,
    };

    // The model abstained: no citations to resolve or verify, and no violation occurred that a
    // `GroundingViolationKind` could honestly name — see `VerifyClaimResult.reasonCode`'s doc
    // comment for why this branch never carries one. No decomposition or contradiction check
    // either: both need a citation set to check against, and this claim has none.
    if (!modelResult.output.supported) {
      return { result: { claimIndex, verdict: 'not_grounded' }, candidateChunkIds, usage };
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

    // Runs before `verifyClaim` regardless of whether checks 1-4 will end up dropping this claim:
    // decomposition only needs the statement, not a verdict, and `verifyClaim`'s own atom checks
    // are monotone on top of the whole-statement check it always runs first — a decomposition
    // this claim never uses (because it was dropped on the whole statement) costs a model call,
    // never a wrong verdict.
    const decomposition = await this.claimDecompositionService.decompose({
      statement: sanitized,
      tenantId,
    });
    const atoms = decomposition.kind === 'decomposed' ? decomposition.atoms : undefined;
    if (decomposition.kind === 'decomposed') {
      usage = addUsage(usage, decomposition.usage);
    }

    const verification = verifyClaim({
      claim,
      retrievedChunks: candidates,
      cellFacts,
      atoms,
      measures,
      entities,
    });

    if (verification.kind === 'dropped') {
      // `verification.violations[0].kind` — the bounded `GroundingViolationKind` — never
      // `verification.dropped.reason`, which is free text assembled from claim and chunk content
      // and would send that text back over the wire to another AI assistant.
      return {
        result: {
          claimIndex,
          verdict: 'not_grounded',
          reasonCode: verification.violations[0].kind,
        },
        candidateChunkIds,
        usage,
      };
    }

    const proseTouchedFactKeys = await this.findProseTouchedFactKeys(verification.claim, tenantId);
    const touchesConflict = [...verification.touchedFactKeys, ...proseTouchedFactKeys].some(
      (touchedKey) =>
        conflictedFactKeys.some((conflicted) => factKeysMatch(touchedKey, conflicted)),
    );
    const verdict: ClaimVerdict = touchesConflict ? 'conflicting_evidence' : 'grounded';

    // Applied only here, after every other check already let the claim survive — the same ordering
    // `GroundingGateService.verify` uses for `contradictedClaimIndexes`. `config.verifier.
    // contradictionCheck` off means this service is never called at all, not called-and-ignored.
    if (this.config.verifier.contradictionCheck) {
      const citedChunkIds = new Set(
        verification.claim.citations.map((citation) => citation.chunkId),
      );
      const citedCandidates = candidates.filter((candidate) =>
        citedChunkIds.has(candidate.chunkId),
      );

      // `sanitized`, not `statement`: this is a model call, so it sits on the prompt side of the
      // division stated above. The atoms are already sanitized by construction — `decompose` is fed
      // `sanitized` — and the fallback must not be the one path that hands a caller's raw text to a
      // model.
      for (const atom of atoms ?? [sanitized]) {
        const contradiction = await this.contradictionCheckService.check({
          atom,
          evidence: citedCandidates,
          tenantId,
        });
        if (contradiction.kind !== 'checked') {
          continue;
        }
        usage = addUsage(usage, contradiction.usage);
        if (contradiction.contradicted) {
          return {
            result: { claimIndex, verdict: 'not_grounded', reasonCode: 'claim-contradicted' },
            candidateChunkIds,
            usage,
          };
        }
      }
    }

    return {
      result: { claimIndex, verdict, citations: verification.claim.citations },
      candidateChunkIds,
      atoms: atoms ? { claimIndex, statement, atoms } : undefined,
      usage,
    };
  }

  /**
   * The prose-conflict-downgrade signal `verifyClaim`'s `touchedFactKeys` structurally cannot
   * carry: check 4's `cellFacts` is `xlsx-cell`-only (`FactsService.findCellFacts`'s own doc
   * comment), so a claim resting on a conflicted fact extracted from prose never touches it there,
   * and `cellFacts` itself must stay `xlsx-cell`-only — check 4 treats a chunk carrying any cell
   * fact as authoritative for numbers and disables its raw-chunk-text fallback accordingly, a
   * behavior this method must not disturb. Computed independently: every fact — any locator kind —
   * on the claim's own cited chunks, kept only when its value is one the claim's statement actually
   * states (mirrors check 4's value match) and its `factKey.entity` occurs as a whole token in the
   * claim statement, both sides folded through {@link normalizeEntityName} — the same fold
   * `groupKey`, `factKeysMatch`, and `verifyClaim`'s own subject-entity check use, so an entity
   * arriving in a different Unicode encoding (fullwidth Latin, a compatibility ligature, a
   * non-breaking space, a doubled space from a PDF text layer) still matches. Whole-token via
   * {@link containsNormalizedToken}, never fuzzy — a chunk carrying several entities' facts (an
   * xlsx row window, a prose page) must not attach an unrelated entity's conflict to this claim,
   * the defect `scope-conflict-to-question.ts` exists to prevent on the answer path. This is a
   * veto-widening check on the downgrade path, not a permission gate: under-matching here is the
   * unsafe direction (a conflict that should have downgraded a claim silently does not), so it
   * folds toward matching rather than toward excluding an entity it cannot prove distinct.
   */
  private async findProseTouchedFactKeys(
    claim: Claim,
    tenantId: string,
  ): Promise<readonly FactKey[]> {
    const citedChunkIds = [...new Set(claim.citations.map((citation) => citation.chunkId))];
    const facts = await this.factsService.findFactsForChunks(citedChunkIds, tenantId);

    const statedNumbers = new Set(extractNumericTokens(claim.statement));
    const normalizedStatement = normalizeEntityName(claim.statement);

    return facts
      .filter((fact) => statedNumbers.has(fact.value.amount))
      .filter((fact) =>
        containsNormalizedToken(normalizedStatement, normalizeEntityName(fact.factKey.entity)),
      )
      .map((fact) => ({
        entity: fact.factKey.entity,
        metric: fact.factKey.metric,
        period: fact.factKey.period,
      }));
  }
}
