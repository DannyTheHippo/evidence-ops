import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { FactResponseDto } from './fact.response.dto';

/** Nameable `{ docs, count }` envelope for the facts behind one ledger cell. */
export class FactListResponseDto extends WithCountResponseDto<FactResponseDto> {
  @Expose()
  @Type(() => FactResponseDto)
  @ApiProperty({ type: [FactResponseDto], description: 'Facts behind the addressed cell.' })
  declare docs: FactResponseDto[];
}
