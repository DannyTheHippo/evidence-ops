import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Model, Types } from 'mongoose';
import { Answer, AnswerDocument } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  ConflictDocument,
  type ConflictResolutionOutcome,
  type ConflictRuleFired,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  DocumentVersion,
  DocumentVersionDocument,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  ExtractedFact,
  ExtractedFactDocument,
  type FactKey,
} from '../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import {
  Measure,
  MeasureDocument,
} from '../../../database/schemas/evidence/measure/measure.schema';
import {
  Verification,
  VerificationDocument,
} from '../../../database/schemas/evidence/verification/verification.schema';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { AlsContext } from '../../../shared/types/als-context.type';
import { canonicalJson } from '../../../shared/utils/canonical-json.util';
import type { AnswerContract, Citation, Locator } from '../qa/contracts/answer.contract';
import type { ClaimVerdict } from '../qa/contracts/verify-claims.contract';
import {
  AttestationSubjectNotCompleteException,
  AttestationSubjectNotFoundException,
} from './exceptions/attestations.exception';

/** The four checks a citation clears to be counted a survivor — `verify-claim.ts`'s checks 1-4,
 * named the way `GroundingViolationKind`'s doc comment already groups their failure modes. */
const SURVIVED_CLAIM_CHECKS = [
  'retrieval-containment',
  'quote-containment',
  'quote-alignment',
  'numeric-support',
] as const;

interface AttestationCitation {
  documentId: string | null;
  documentVersionId: string;
  sha256: string;
  locator: Locator;
  extractorVersion: string;
  quote: string;
}

interface AttestationCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface AttestationClaim {
  statement: string;
  atoms?: string[];
  verdict: ClaimVerdict | 'survived' | 'dropped';
  citations: AttestationCitation[];
  checks: AttestationCheck[];
}

export type AttestationDecision = { conflictId: string; factKey: FactKey } & {
  outcome: ConflictResolutionOutcome;
  winningFactId?: string;
  decidedBy?: string;
  reason?: string;
  resolvedAt: string;
  ruleFired?: ConflictRuleFired;
  followedProposal?: boolean;
};

type AttestationMeasure = {
  slug: string;
  version: number;
  status: 'proposed' | 'confirmed' | 'rejected';
};

export interface AttestationBundle {
  schemaVersion: 1;
  kind: 'answer' | 'verification';
  subjectId: string;
  tenantId: string;
  producedAt: string;
  subject: { question: string } | { claims: string[] };
  outcome: AnswerContract['kind'] | null;
  claims: AttestationClaim[];
  decisions: AttestationDecision[];
  measures: AttestationMeasure[];
  integrity: { algorithm: 'sha256'; contentHash: string };
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Exports a tamper-evident snapshot of a completed `Answer` or a `Verification`: `integrity.
 * contentHash` is a sha256 over `canonicalJson` of everything else in the bundle, so re-running
 * `canonicalJson` and sha256 over a bundle a recipient holds reproduces the same digest if and only
 * if nothing in it has changed since export.
 *
 * There is no signing key: the hash proves integrity, never authenticity. It detects tampering
 * only for a recipient who obtained the hash itself through a channel they already trust — the
 * bundle alone cannot prove who produced it or that the hash on file is the genuine one.
 *
 * `attestationHash` is pinned on the subject's own row the first time it is exported
 * (`findOneAndUpdate` with `attestationHash: { $exists: false }`) and never overwritten, so a
 * second export of an unchanged subject reruns the same hash rather than minting a new one, and
 * the two exports' canonical JSON is byte-identical.
 */
@Injectable()
export class AttestationService {
  constructor(
    @InjectModel(Answer.name)
    private readonly answerModel: Model<AnswerDocument>,

    @InjectModel(Verification.name)
    private readonly verificationModel: Model<VerificationDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(ExtractedFact.name)
    private readonly extractedFactModel: Model<ExtractedFactDocument>,

    @InjectModel(Conflict.name)
    private readonly conflictModel: Model<ConflictDocument>,

    @InjectModel(Measure.name)
    private readonly measureModel: Model<MeasureDocument>,

    private readonly auditService: AuditService,

    @Inject(AsyncLocalStorage)
    private readonly als: AsyncLocalStorage<AlsContext>,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(AttestationService.name);
  }

  async exportForAnswer(answerId: string, tenantId: string): Promise<AttestationBundle> {
    const answer = await this.loadAnswer(answerId, tenantId);
    if (answer.runStatus !== 'completed') {
      throw new AttestationSubjectNotCompleteException(`Answer '${answerId}' is not completed`);
    }

    const atomsByStatement = new Map(answer.atoms.map((entry) => [entry.statement, entry.atoms]));
    const droppedClaims = answer.verificationReport?.droppedClaims ?? [];

    const citedDocVersionIds = distinct(
      answer.claims.flatMap((claim) => claim.citations.map((citation) => citation.docVersionId)),
    );
    const documentIdByVersionId = await this.loadDocumentIdsByVersionId(
      citedDocVersionIds,
      tenantId,
    );

    const claims: AttestationClaim[] = [
      ...answer.claims.map((claim): AttestationClaim => {
        const atoms = atomsByStatement.get(claim.statement);
        return {
          statement: claim.statement,
          ...(atoms ? { atoms: [...atoms] } : {}),
          verdict: 'survived',
          citations: this.buildCitations(claim.citations, documentIdByVersionId),
          checks: SURVIVED_CLAIM_CHECKS.map((name) => ({ name, passed: true })),
        };
      }),
      ...droppedClaims.map((dropped): AttestationClaim => {
        const atoms = atomsByStatement.get(dropped.statement);
        return {
          statement: dropped.statement,
          ...(atoms ? { atoms: [...atoms] } : {}),
          verdict: 'dropped',
          citations: [],
          checks: [{ name: 'grounding-gate', passed: false, detail: dropped.reason }],
        };
      }),
    ];

    const chunkIds = distinct(
      answer.claims.flatMap((claim) => claim.citations.map((citation) => citation.chunkId)),
    );
    const measures = await this.buildMeasures(chunkIds, tenantId);

    const ledgerDecision =
      answer.outcome?.kind === 'answered' ? answer.outcome.ledger?.decision : undefined;
    const conflictIds = distinct([
      ...answer.conflictIds.map((id) => id.toString()),
      ...(ledgerDecision ? [ledgerDecision.conflictId] : []),
    ]);
    const decisions = await this.loadDecisions(conflictIds, tenantId);

    const bundle: Omit<AttestationBundle, 'integrity'> = {
      schemaVersion: 1,
      kind: 'answer',
      subjectId: answer._id.toString(),
      tenantId,
      producedAt: answer.createdAt.toISOString(),
      subject: { question: answer.questionText },
      outcome: answer.outcome?.kind ?? null,
      claims,
      decisions,
      measures,
    };
    const contentHash = createHash('sha256').update(canonicalJson(bundle), 'utf8').digest('hex');

    await this.answerModel.findOneAndUpdate(
      { _id: answerId, tenantId, attestationHash: { $exists: false } },
      { $set: { attestationHash: contentHash } },
    );
    await this.recordExport('Answer', answerId, tenantId);

    return { ...bundle, integrity: { algorithm: 'sha256', contentHash } };
  }

  async exportForVerification(
    verificationId: string,
    tenantId: string,
  ): Promise<AttestationBundle> {
    const verification = await this.loadVerification(verificationId, tenantId);

    const citedDocVersionIds = distinct(
      verification.results.flatMap((result) =>
        (result.citations ?? []).map((citation) => citation.docVersionId),
      ),
    );
    const documentIdByVersionId = await this.loadDocumentIdsByVersionId(
      citedDocVersionIds,
      tenantId,
    );

    const claims: AttestationClaim[] = verification.results.map((result): AttestationClaim => {
      const citations = result.citations ?? [];
      return {
        statement: verification.claims[result.claimIndex],
        verdict: result.verdict,
        citations: this.buildCitations(citations, documentIdByVersionId),
        checks: [
          {
            name: 'grounding-gate',
            passed: result.verdict === 'grounded',
            ...(result.reasonCode ? { detail: result.reasonCode } : {}),
          },
        ],
      };
    });

    const chunkIds = distinct(
      verification.results.flatMap((result) =>
        (result.citations ?? []).map((citation) => citation.chunkId),
      ),
    );
    const measures = await this.buildMeasures(chunkIds, tenantId);

    const bundle: Omit<AttestationBundle, 'integrity'> = {
      schemaVersion: 1,
      kind: 'verification',
      subjectId: verification._id.toString(),
      tenantId,
      producedAt: verification.createdAt.toISOString(),
      subject: { claims: [...verification.claims] },
      outcome: null,
      claims,
      decisions: [],
      measures,
    };
    const contentHash = createHash('sha256').update(canonicalJson(bundle), 'utf8').digest('hex');

    await this.verificationModel.findOneAndUpdate(
      { _id: verificationId, tenantId, attestationHash: { $exists: false } },
      { $set: { attestationHash: contentHash } },
    );
    await this.recordExport('Verification', verificationId, tenantId);

    return { ...bundle, integrity: { algorithm: 'sha256', contentHash } };
  }

  private async loadAnswer(answerId: string, tenantId: string): Promise<AnswerDocument> {
    if (!Types.ObjectId.isValid(answerId)) {
      throw new AttestationSubjectNotFoundException(`Answer '${answerId}' not found`);
    }
    // Scoped `findOne`, not `findById` + a separate ownership check — a cross-tenant id 404s the
    // same way a nonexistent one does (`qa.service.ts`'s `peekAnswer` follows the same shape).
    const answer = await this.answerModel.findOne({ _id: answerId, tenantId });
    if (!answer) {
      throw new AttestationSubjectNotFoundException(`Answer '${answerId}' not found`);
    }
    return answer;
  }

  private async loadVerification(
    verificationId: string,
    tenantId: string,
  ): Promise<VerificationDocument> {
    if (!Types.ObjectId.isValid(verificationId)) {
      throw new AttestationSubjectNotFoundException(`Verification '${verificationId}' not found`);
    }
    const verification = await this.verificationModel.findOne({ _id: verificationId, tenantId });
    if (!verification) {
      throw new AttestationSubjectNotFoundException(`Verification '${verificationId}' not found`);
    }
    return verification;
  }

  /** Rebuilds every field by explicit scalar read rather than passing a `Citation` through
   * as-is — `locator` is copied, not referenced, so nothing here can carry a Mongoose document's
   * own fields (`_id`, `__v`, timestamps) into the hashed bundle. */
  private buildCitations(
    citations: readonly Citation[],
    documentIdByVersionId: ReadonlyMap<string, string | null>,
  ): AttestationCitation[] {
    return citations.map((citation) => ({
      documentId: documentIdByVersionId.get(citation.docVersionId) ?? null,
      documentVersionId: citation.docVersionId,
      sha256: citation.sha256,
      locator: { ...citation.locator },
      extractorVersion: citation.locator.extractorVersion,
      quote: citation.quote,
    }));
  }

  /** `docVersionId` is `DocumentVersion._id` as a string but is validated only as a non-empty
   * string on the citation contract, so an id shaped like something other than an ObjectId is
   * filtered out here rather than thrown into `$in` as a `CastError` — it resolves to `documentId:
   * null` the same way a valid id whose row is gone does. */
  private async loadDocumentIdsByVersionId(
    docVersionIds: readonly string[],
    tenantId: string,
  ): Promise<Map<string, string | null>> {
    const validIds = docVersionIds.filter((id) => Types.ObjectId.isValid(id));
    const byVersionId = new Map<string, string | null>();
    if (validIds.length === 0) {
      return byVersionId;
    }

    const versions = await this.documentVersionModel.find({
      _id: { $in: validIds.map((id) => new Types.ObjectId(id)) },
      tenantId,
    });
    for (const version of versions) {
      byVersionId.set(version._id.toString(), version.documentId.toString());
    }
    return byVersionId;
  }

  /** Distinct `Measure` definitions referenced by the facts extracted on the cited chunks —
   * `measureId` is already unique per fact group, so deduping on it before the `Measure` lookup is
   * what keeps the result distinct by `slug`/`version` (a slug is unique per tenant). */
  private async buildMeasures(
    chunkIds: readonly string[],
    tenantId: string,
  ): Promise<AttestationMeasure[]> {
    if (chunkIds.length === 0) {
      return [];
    }

    const facts = await this.extractedFactModel.find({ chunkId: { $in: [...chunkIds] }, tenantId });
    const measureIds = distinct(facts.map((fact) => fact.measureId.toString()));
    if (measureIds.length === 0) {
      return [];
    }

    const measures = await this.measureModel.find({
      _id: { $in: measureIds.map((id) => new Types.ObjectId(id)) },
      tenantId,
    });
    return measures.map((measure) => ({
      slug: measure.slug,
      version: measure.version,
      status: measure.status,
    }));
  }

  /** Only `Conflict` rows that already carry a human (or cascade) decision — an `open` conflict
   * named in `conflictIds` contributes no decision, since there is none to report yet. */
  private async loadDecisions(
    conflictIds: readonly string[],
    tenantId: string,
  ): Promise<AttestationDecision[]> {
    const validIds = conflictIds.filter((id) => Types.ObjectId.isValid(id));
    if (validIds.length === 0) {
      return [];
    }

    const conflicts = await this.conflictModel.find({
      _id: { $in: validIds.map((id) => new Types.ObjectId(id)) },
      tenantId,
      resolution: { $exists: true },
    });

    const decisions: AttestationDecision[] = [];
    for (const conflict of conflicts) {
      const resolution = conflict.resolution;
      if (!resolution) {
        continue;
      }
      decisions.push({
        conflictId: conflict._id.toString(),
        factKey: {
          entity: conflict.factKey.entity,
          metric: conflict.factKey.metric,
          period: conflict.factKey.period,
        },
        outcome: resolution.outcome,
        winningFactId: resolution.winningFactId?.toString(),
        decidedBy: resolution.decidedBy,
        reason: resolution.reason,
        resolvedAt: resolution.resolvedAt.toISOString(),
        ruleFired: resolution.ruleFired,
        followedProposal: resolution.followedProposal,
      });
    }
    return decisions;
  }

  /** The actor is read from the request-scoped `AsyncLocalStorage` (populated by `JwtAuthGuard` for
   * an HTTP call and by the MCP `tools/call` boundary for a tool call — the same store
   * `auditablePlugin` reads for `createdBy`/`updatedBy`) rather than threaded through
   * `exportForAnswer`/`exportForVerification`'s own signature, so neither method's caller has to
   * know it needs to supply one. An audit row is a required side effect, never a veto on the
   * export itself, so a scope with no actor in it — which should not happen on either real call
   * path — logs and skips the write rather than failing the export or fabricating an actor. */
  private async recordExport(
    entityType: 'Answer' | 'Verification',
    entityId: string,
    tenantId: string,
  ): Promise<void> {
    const actorId = this.als.getStore()?.user;
    if (!actorId) {
      this.logger.warn(
        `Skipped attestations.exported audit row for ${entityType} '${entityId}': no actor in the request context`,
      );
      return;
    }

    await this.auditService.record({
      action: 'attestations.exported',
      actorId,
      subject: { entityType, entityId },
      tenantId,
    });
  }
}
