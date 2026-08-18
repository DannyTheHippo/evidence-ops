import { Injectable } from '@nestjs/common';
import { EvidenceRetrievalService } from '../qa/evidence-retrieval.service';
import type { RetrievedChunk } from '../qa/types/retrieved-chunk.type';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import type { SearchEvidenceRequestDto } from './dtos/request/search-evidence.request.dto';

@Injectable()
export class RetrievalService {
  constructor(
    private readonly evidenceRetrievalService: EvidenceRetrievalService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(RetrievalService.name);
  }

  async search(
    dto: SearchEvidenceRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<RetrievedChunk>> {
    const docs = await this.evidenceRetrievalService.retrieve({
      questionText: dto.query,
      tenantId,
    });

    await this.auditService.record({
      action: 'evidence.searched',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return { docs, count: docs.length };
  }
}
