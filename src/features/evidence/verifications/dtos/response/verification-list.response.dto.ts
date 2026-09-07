import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { VerificationResponseDto } from './verification.response.dto';

/** Nameable `{ docs, count }` envelope for the tenant's verification run list. */
export class VerificationListResponseDto extends WithCountResponseDto<VerificationResponseDto> {
  @Expose()
  @Type(() => VerificationResponseDto)
  @ApiProperty({ type: [VerificationResponseDto], description: "The tenant's verification runs." })
  declare docs: VerificationResponseDto[];
}
