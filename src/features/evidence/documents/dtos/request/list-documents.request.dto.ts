import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  DOCUMENT_VERSION_INGESTION_STATUSES,
  type DocumentVersionIngestionStatus,
} from '../../../../../database/schemas/evidence/document-version/document-version.schema';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

// `sizeBytes` and `ingestionStatus` deliberately excluded: both live on `DocumentVersion`, not
// `Document` (`document-version.schema.ts`), so sorting a document list by either would need the
// list paged from `document_versions` instead — a different endpoint, not a sort field this one
// can honour.
export const DOCUMENT_SORT_FIELDS = ['createdAt', 'title', 'sourceKind'] as const;
export type DocumentSortField = (typeof DOCUMENT_SORT_FIELDS)[number];

export const DEFAULT_DOCUMENT_SORT_FIELD: DocumentSortField = 'createdAt';
export const DEFAULT_DOCUMENT_SORT_DIRECTION: SortDirection = 'desc';

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

  @ApiProperty({
    example: 'createdAt',
    enum: DOCUMENT_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(DOCUMENT_SORT_FIELDS)
  sort?: DocumentSortField;

  @ApiProperty({
    example: 'desc',
    enum: SORT_DIRECTIONS,
    description: 'Sort direction. Defaults to desc.',
    required: false,
  })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  sortDir?: SortDirection;
}
