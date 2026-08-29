import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Answer,
  type AnswerDocument,
} from '../../../database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  type ConflictDocument,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  type DocumentDocument,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  type DocumentVersionDocument,
  type DocumentVersionIngestionStatus,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import {
  Source,
  type SourceDocument,
} from '../../../database/schemas/evidence/source/source.schema';
import {
  Approval,
  type ApprovalDocument,
} from '../../../database/schemas/workflow/approval/approval.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';

export interface DashboardSummary {
  readonly pendingApprovalCount: number;
  readonly openConflictCount: number;
  readonly documentCount: number;
  readonly sourceCount: number;
  readonly ingestionFailedCount: number;
  readonly syncFailedCount: number;
  readonly needsOcrCount: number;
  readonly factsFailedCount: number;
  readonly answerCount: number;
  readonly hasIngestedDocument: boolean;
}

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Approval.name)
    private readonly approvalModel: Model<ApprovalDocument>,

    @InjectModel(Conflict.name)
    private readonly conflictModel: Model<ConflictDocument>,

    @InjectModel(Document.name)
    private readonly documentModel: Model<DocumentDocument>,

    @InjectModel(DocumentVersion.name)
    private readonly documentVersionModel: Model<DocumentVersionDocument>,

    @InjectModel(Source.name)
    private readonly sourceModel: Model<SourceDocument>,

    @InjectModel(Answer.name)
    private readonly answerModel: Model<AnswerDocument>,

    private readonly logger: AppLogger,
  ) {
    this.logger.init(DashboardService.name);
  }

  /**
   * One tenant-scoped read replacing Home's own fan-out of list calls, each of which existed only
   * to feed one count or boolean rather than a page of rows. `hasIngestedDocument` resolves over
   * every document the tenant owns rather than a single page, which is what lets a corpus whose
   * only completed document sits past the first page still report the right "get started" state.
   *
   * `ingestionFailedCount`/`needsOcrCount`/`factsFailedCount` each resolve which
   * `DocumentVersion`s currently carry that status, then count documents whose CURRENT version is
   * one of them — `ingestionStatus` lives on the version, not the document, and a document whose
   * failed version was superseded by a completed one is deliberately excluded, matching
   * `DocumentsService.list`'s own two-step filter for the same field.
   */
  async getSummary(tenantId: string): Promise<DashboardSummary> {
    const [
      pendingApprovalCount,
      openConflictCount,
      documentCount,
      sourceCount,
      syncFailedCount,
      answerCount,
      failedVersionIds,
      needsOcrVersionIds,
      factsFailedVersionIds,
      completedVersionIds,
    ] = await Promise.all([
      this.approvalModel.countDocuments({ tenantId, state: 'pending' }),
      this.conflictModel.countDocuments({ tenantId, status: 'open' }),
      this.documentModel.countDocuments({ tenantId }),
      this.sourceModel.countDocuments({ tenantId }),
      this.sourceModel.countDocuments({ tenantId, lastSyncStatus: 'failed' }),
      this.answerModel.countDocuments({ tenantId }),
      this.currentVersionIdsByStatus(tenantId, 'failed'),
      this.currentVersionIdsByStatus(tenantId, 'needs-ocr'),
      this.currentVersionIdsByStatus(tenantId, 'facts-failed'),
      this.currentVersionIdsByStatus(tenantId, 'completed'),
    ]);

    const [ingestionFailedCount, needsOcrCount, factsFailedCount, hasCompletedDocument] =
      await Promise.all([
        this.documentModel.countDocuments({
          tenantId,
          currentVersionId: { $in: failedVersionIds },
        }),
        this.documentModel.countDocuments({
          tenantId,
          currentVersionId: { $in: needsOcrVersionIds },
        }),
        this.documentModel.countDocuments({
          tenantId,
          currentVersionId: { $in: factsFailedVersionIds },
        }),
        this.documentModel.exists({ tenantId, currentVersionId: { $in: completedVersionIds } }),
      ]);

    return {
      pendingApprovalCount,
      openConflictCount,
      documentCount,
      sourceCount,
      ingestionFailedCount,
      syncFailedCount,
      needsOcrCount,
      factsFailedCount,
      answerCount,
      hasIngestedDocument: hasCompletedDocument !== null,
    };
  }

  /** The ids of every `DocumentVersion` a tenant owns carrying `ingestionStatus`, projected to
   *  `_id` alone. */
  private async currentVersionIdsByStatus(
    tenantId: string,
    ingestionStatus: DocumentVersionIngestionStatus,
  ): Promise<Types.ObjectId[]> {
    const versions = await this.documentVersionModel.find(
      { tenantId, ingestionStatus },
      { _id: 1 },
    );
    return versions.map((version) => version._id);
  }
}
