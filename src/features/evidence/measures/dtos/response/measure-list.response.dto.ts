import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { MeasureResponseDto } from './measure.response.dto';

/** Nameable `{ docs, count }` envelope for the tenant's measure registry. */
export class MeasureListResponseDto extends WithCountResponseDto<MeasureResponseDto> {
  @Expose()
  @Type(() => MeasureResponseDto)
  @ApiProperty({ type: [MeasureResponseDto], description: "The tenant's measures." })
  declare docs: MeasureResponseDto[];
}
