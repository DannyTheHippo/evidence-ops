import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { CanonicalEntityResponseDto } from './canonical-entity.response.dto';

/** Nameable `{ docs, count }` envelope for the tenant's canonical-entity registry. */
export class CanonicalEntityListResponseDto extends WithCountResponseDto<CanonicalEntityResponseDto> {
  @Expose()
  @Type(() => CanonicalEntityResponseDto)
  @ApiProperty({
    type: [CanonicalEntityResponseDto],
    description: "The tenant's registered canonical entities.",
  })
  declare docs: CanonicalEntityResponseDto[];
}
