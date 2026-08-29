import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { UserResponseDto } from './user.response.dto';

/** Nameable `{ docs, count }` envelope for the tenant-member list. */
export class UserListResponseDto extends WithCountResponseDto<UserResponseDto> {
  @Expose()
  @Type(() => UserResponseDto)
  @ApiProperty({ type: [UserResponseDto], description: "The tenant's members." })
  declare docs: UserResponseDto[];
}
