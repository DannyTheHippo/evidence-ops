import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  DEFAULT_PAGINATION_LIMIT,
  DEFAULT_PAGINATION_SKIP,
  MAX_PAGINATION_LIMIT,
} from '../../constants/pagination-defaults.constant';
import { SelectRequestDto } from './select.request.dto';

export class PaginationRequestDto extends SelectRequestDto {
  @ApiProperty({
    example: DEFAULT_PAGINATION_SKIP,
    description: 'Number of documents to skip (offset).',
    default: DEFAULT_PAGINATION_SKIP,
    minimum: 0,
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number = DEFAULT_PAGINATION_SKIP;

  @ApiProperty({
    example: DEFAULT_PAGINATION_LIMIT,
    description: 'Maximum number of documents to return.',
    default: DEFAULT_PAGINATION_LIMIT,
    minimum: 1,
    maximum: MAX_PAGINATION_LIMIT,
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGINATION_LIMIT)
  limit?: number = DEFAULT_PAGINATION_LIMIT;
}
