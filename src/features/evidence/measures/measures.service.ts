import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Answer, AnswerDocument } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  ConflictDocument,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  EvidenceChunk,
  EvidenceChunkDocument,
} from '../../../database/schemas/evidence/evidence-chunk/evidence-chunk.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';

export interface MeasuresResult {
  readonly answersCompleted: number;
  readonly answersWithVerifiedCitations: number;
  readonly conflictsSurfaced: number;
  readonly conflictsResolved: number;
  readonly meanEvidenceDocumentsPerAnswer: number | null;
  readonly medianAnswerLatencyMs: number | null;
  readonly p95AnswerLatencyMs: number | null;
}

/** Linear interpolation between the two closest ranks (`(p/100) * (n - 1)`, the rule Excel's
 *  PERCENTILE.INC and NumPy's default use) — one rule, used for both p50 and p95 below, so the
 *  two figures stay comparable under an identical definition. `sortedValues` must already be
 *  ascending. */
function computePercentile(sortedValues: readonly number[], percentileRank: number): number {
  const rank = (percentileRank / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex];
  }
  const weight = rank - lowerIndex;
  return sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * weight;
}

/**
 * Four tenant-scoped pilot measures, derived entirely from data the platform already holds —
 * nothing hand-entered, nothing inferred. Built from plain `find`/`countDocuments` calls, not
 * `.aggregate()`: `tenantScopePlugin` hooks queries, not aggregation pipelines, so an aggregation
 * here would silently lose the tenancy backstop; every query below still filters `tenantId`
 * explicitly rather than leaning on that backstop alone, the same posture
 * `MetricPoliciesService.resolveForTenant` documents on its own identical explicit filter.
 *
 * No cap and no sampling: `getForTenant` reads every completed answer for the tenant, accepted at
 * pilot scale, not an oversight — the same posture `AuditEventsService.list` documents on its own
 * unbounded tenant scan. A silent top-N would make this page lie about being a full measure.
 */
@Injectable()
export class MeasuresService {
  constructor(
    @InjectModel(Answer.name)
    private readonly answerModel: Model<AnswerDocument>,

    @InjectModel(Conflict.name)
    private readonly conflictModel: Model<ConflictDocument>,

    @InjectModel(EvidenceChunk.name)
    private readonly evidenceChunkModel: Model<EvidenceChunkDocument>,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(MeasuresService.name);
  }

  async getForTenant(tenantId: string): Promise<MeasuresResult> {
    const [
      answersCompleted,
      answersWithVerifiedCitations,
      conflictsSurfaced,
      conflictsResolved,
      completedAnswers,
    ] = await Promise.all([
      this.answerModel.countDocuments({ tenantId, runStatus: 'completed' }),
      // Verified by construction, not by a second check here: the grounding gate
      // (`GroundingCheckActivityResult`, `src/worker/activities.ts`) persists an `answered`
      // outcome only once every citation it named has survived quote verification against the
      // actual chunk bytes; a claim whose citations were all dropped is persisted as
      // `insufficient_evidence` instead, never left as a citation-less `answered`
      // (`answer.schema.ts`'s `outcome` and `claims` doc comments).
      this.answerModel.countDocuments({
        tenantId,
        runStatus: 'completed',
        'outcome.kind': 'answered',
      }),
      this.conflictModel.countDocuments({ tenantId }),
      this.conflictModel.countDocuments({ tenantId, status: 'resolved' }),
      // Filtered to `completed`: an `Answer` row is written exactly twice — created `queued` by
      // `QaService.startQuestion` and saved `completed` by `AnswerPersistenceService.persist`.
      // A `failed` or still-`running` row never gets that second write, so outside this filter
      // `updatedAt` is not a completion time at all. Projection-limited — `outcome`, `claims` and
      // `verificationReport` are never read here.
      this.answerModel.find(
        { tenantId, runStatus: 'completed' },
        { retrievedChunkIds: 1, createdAt: 1, updatedAt: 1 },
      ),
    ]);

    if (completedAnswers.length === 0) {
      this.logger.debug(
        `No completed answers for tenant '${tenantId}'; latency and document measures report null`,
      );
      return {
        answersCompleted,
        answersWithVerifiedCitations,
        conflictsSurfaced,
        conflictsResolved,
        meanEvidenceDocumentsPerAnswer: null,
        medianAnswerLatencyMs: null,
        p95AnswerLatencyMs: null,
      };
    }

    const everyChunkId = [
      ...new Set(completedAnswers.flatMap((answer) => answer.retrievedChunkIds)),
    ];
    const documentIdByChunkId = new Map<string, string>();
    if (everyChunkId.length > 0) {
      const chunks = await this.evidenceChunkModel.find(
        { tenantId, _id: { $in: everyChunkId } },
        { documentId: 1 },
      );
      for (const chunk of chunks) {
        documentIdByChunkId.set(chunk._id, chunk.documentId.toString());
      }
    }

    // Distinct `documentId`, not `sourceId`: `Document.sourceId` is optional (a browser upload
    // carries none), so counting sources touched would silently undercount, while
    // `EvidenceChunk.documentId` is `required: true` and always present on every chunk here. A
    // chunk id with no matching row — a deleted document's chunk — contributes no document to its
    // answer's count rather than throwing; the lookup below simply has no entry for it.
    const documentCountByAnswer = completedAnswers.map((answer) => {
      const documentIds = new Set<string>();
      for (const chunkId of answer.retrievedChunkIds) {
        const documentId = documentIdByChunkId.get(chunkId);
        if (documentId) {
          documentIds.add(documentId);
        }
      }
      return documentIds.size;
    });
    const meanEvidenceDocumentsPerAnswer =
      documentCountByAnswer.reduce((sum, count) => sum + count, 0) / documentCountByAnswer.length;

    // Median and p95, not a mean: latency is skewed and a mean would flatter it.
    const latenciesMs = completedAnswers
      .map((answer) => answer.updatedAt.getTime() - answer.createdAt.getTime())
      .sort((a, b) => a - b);

    return {
      answersCompleted,
      answersWithVerifiedCitations,
      conflictsSurfaced,
      conflictsResolved,
      meanEvidenceDocumentsPerAnswer,
      medianAnswerLatencyMs: computePercentile(latenciesMs, 50),
      p95AnswerLatencyMs: computePercentile(latenciesMs, 95),
    };
  }
}
