import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  DOCUMENT_VERSION_INGESTION_STATUSES,
  type DocumentVersionIngestionStatus,
} from '../../../../../database/schemas/evidence/document-version/document-version.schema';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export class ListDocumentsRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'failed',
    enum: DOCUMENT_VERSION_INGESTION_STATUSES,
    description:
      "Filter to documents whose CURRENT version has this ingestionStatus — 'failed' and " +
      "'needs-ocr' are the corpus-health use cases. An older failed version superseded by a " +
      "newer completed one does not match, the same semantics `HomePage.tsx`'s client-side " +
      'filter already uses. Omit to list every document regardless of ingestion outcome.',
    required: false,
  })
  @IsOptional()
  @IsIn(DOCUMENT_VERSION_INGESTION_STATUSES)
  ingestionStatus?: DocumentVersionIngestionStatus;
}
