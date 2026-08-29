import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { SourceResponseDto } from './source.response.dto';

/** Nameable `{ docs, count }` envelope for the tenant's source list. */
export class SourceListResponseDto extends WithCountResponseDto<SourceResponseDto> {
  @Expose()
  @Type(() => SourceResponseDto)
  @ApiProperty({ type: [SourceResponseDto], description: "The tenant's sources." })
  declare docs: SourceResponseDto[];
}
