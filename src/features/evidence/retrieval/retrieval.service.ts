import { Injectable } from '@nestjs/common';
import { EvidenceRetrievalService } from '../qa/evidence-retrieval.service';
import type { RetrievedChunk } from '../qa/types/retrieved-chunk.type';
import {
  DEFAULT_PAGINATION_LIMIT,
  DEFAULT_PAGINATION_SKIP,
} from '../../../shared/constants/pagination-defaults.constant';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { SearchEvidenceRequestDto } from './dtos/request/search-evidence.request.dto';
import { DEFAULT_RETRIEVAL_SORT_DIRECTION } from './retrieval.constant';

export interface SearchEvidenceServiceResult {
  readonly docs: RetrievedChunk[];
  readonly hasMore: boolean;
}

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
  ): Promise<SearchEvidenceServiceResult> {
    const { chunks, hasMore } = await this.evidenceRetrievalService.searchEvidence({
      questionText: dto.query,
      tenantId,
      skip: dto.skip ?? DEFAULT_PAGINATION_SKIP,
      limit: dto.limit ?? DEFAULT_PAGINATION_LIMIT,
      sortDirection: dto.sortDir ?? DEFAULT_RETRIEVAL_SORT_DIRECTION,
      filter: {
        documentId: dto.documentId,
        sourceClass: dto.sourceClass,
        createdAfter: dto.createdAfter,
        createdBefore: dto.createdBefore,
      },
    });

    await this.auditService.record({
      action: 'evidence.searched',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return { docs: chunks, hasMore };
  }
}
