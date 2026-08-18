import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { PaginationRequestDto } from '../../../../../shared/dtos/request/pagination.request.dto';

export class ListSourcesRequestDto extends PaginationRequestDto {
  @ApiProperty({
    example: 'failed',
    description:
      "Exact lastSyncStatus to filter by — currently only 'failed' is meaningful. Omit to list " +
      'every source regardless of sync outcome.',
    required: false,
  })
  @IsOptional()
  @IsString()
  lastSyncStatus?: string;

  @ApiProperty({
    example: false,
    description:
      "Filter to sources with this exact tracked value. R4 renders synced ('tracked: true') and " +
      "inventory-only ('tracked: false') sources as two separately-paged lists, so this cannot be " +
      'done by partitioning one fetched page client-side.',
    required: false,
  })
  @IsOptional()
  // This arrives as a query string, so it is a string on the wire — a bare `@IsBoolean()` would
  // 400 on the literal string 'false'. Same explicit-comparison shape as
  // `UploadDocumentRequestDto.requireApproval`, for the same reason: a bare `@Type(() => Boolean)`
  // would coerce the non-empty string 'false' to `true`.
  @Transform(({ value }: { value: unknown }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  tracked?: boolean;
}
