import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { InvitationResponseDto } from './invitation.response.dto';

/** Nameable `{ docs, count }` envelope for the tenant's invitation list. */
export class InvitationListResponseDto extends WithCountResponseDto<InvitationResponseDto> {
  @Expose()
  @Type(() => InvitationResponseDto)
  @ApiProperty({ type: [InvitationResponseDto], description: "The tenant's invitations." })
  declare docs: InvitationResponseDto[];
}
