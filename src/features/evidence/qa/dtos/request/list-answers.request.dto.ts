import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { AnswerRunStatus } from '../../../../../database/schemas/evidence/answer/answer.schema';
import { ANSWER_RUN_STATUSES } from '../../../../../database/schemas/evidence/answer/answer.schema';
import { SORT_DIRECTIONS, type SortDirection } from '../../../../../shared/constants/sort.constant';
import { IsAfter } from '../../../../../shared/decorators/is-after.decorator';
import { IsIsoInstant } from '../../../../../shared/decorators/is-iso-instant.decorator';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export const ANSWER_SORT_FIELDS = ['createdAt', 'runStatus', 'claimCoverage'] as const;
export type AnswerSortField = (typeof ANSWER_SORT_FIELDS)[number];

export const DEFAULT_ANSWER_SORT_FIELD: AnswerSortField = 'createdAt';
export const DEFAULT_ANSWER_SORT_DIRECTION: SortDirection = 'desc';

export class ListAnswersRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'completed',
    enum: ANSWER_RUN_STATUSES,
    description: 'Exact workflow run status to filter by.',
    required: false,
  })
  @IsOptional()
  @IsIn(ANSWER_RUN_STATUSES)
  runStatus?: AnswerRunStatus;

  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description:
      'Only rows created at or after this instant. ISO-8601 instant with date, time and offset ' +
      '(`Z` or `±hh:mm`), as `toISOString()` emits.',
    required: false,
  })
  @IsOptional()
  @IsIsoInstant()
  from?: string;

  @ApiProperty({
    example: '2026-08-01T00:00:00.000Z',
    description:
      'Only rows created strictly before this instant; must be later than from. ISO-8601 ' +
      'instant with date, time and offset (`Z` or `±hh:mm`), as `toISOString()` emits.',
    required: false,
  })
  @IsOptional()
  @IsIsoInstant()
  @IsAfter('from')
  to?: string;

  @ApiProperty({
    example: 'createdAt',
    enum: ANSWER_SORT_FIELDS,
    description: 'Field to sort by. Defaults to createdAt.',
    required: false,
  })
  @IsOptional()
  @IsIn(ANSWER_SORT_FIELDS)
  sort?: AnswerSortField;

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
