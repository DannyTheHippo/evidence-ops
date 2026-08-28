import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';
import { RETRIEVAL_SORT_FIELDS, type RetrievalSortField } from '../../retrieval.constant';

/**
 * `skip`/`limit` page a best-effort result: the store over-fetches and slices back
 * non-deterministically between runs, a fail-closed score floor drops hits after fusion, and
 * withdrawn versions are dropped after fusion too, so page boundaries are not guaranteed stable
 * across two identical calls — a caller must not present this as "page 3 of 9". `documentId`,
 * `sourceClass` and the date range all filter on `Document`, which is only reachable after
 * fusion, so a filter can legitimately return fewer than `limit` results even when more exist.
 */
export class SearchEvidenceRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'What is the cap rate for Northgate Business Park?',
    description: 'Search text run against the hybrid retrieval index.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  query: string;

  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description: 'Restrict results to chunks belonging to this document.',
    required: false,
  })
  @IsOptional()
  @IsMongoId()
  documentId?: string;

  @ApiProperty({
    example: 'memo',
    enum: DOCUMENT_SOURCE_CLASSES,
    description: 'Restrict results to documents whose sourceClass matches. Omit for every class.',
    required: false,
  })
  @IsOptional()
  @IsIn(DOCUMENT_SOURCE_CLASSES)
  sourceClass?: DocumentSourceClass;

  @ApiProperty({
    example: '2026-01-01T00:00:00.000Z',
    description: 'Restrict results to documents created on or after this timestamp (inclusive).',
    required: false,
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdAfter?: Date;

  @ApiProperty({
    example: '2026-12-31T23:59:59.999Z',
    description: 'Restrict results to documents created on or before this timestamp (inclusive).',
    required: false,
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdBefore?: Date;

  @ApiProperty({
    example: 'score',
    enum: RETRIEVAL_SORT_FIELDS,
    description:
      'Field to sort by. Score is the only field this endpoint exposes — it exists ' +
      'only after fusion runs, unlike every other list endpoint, which sorts a Mongo query ' +
      'directly. Defaults to score.',
    required: false,
  })
  @IsOptional()
  @IsIn(RETRIEVAL_SORT_FIELDS)
  sort?: RetrievalSortField;

  @ApiProperty({
    example: 'desc',
    enum: SORT_DIRECTIONS,
    description: 'Sort direction. Defaults to desc (highest relevance first).',
    required: false,
  })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  sortDir?: SortDirection;
}
