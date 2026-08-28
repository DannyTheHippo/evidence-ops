import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { UserRole } from '../../../../../shared/enums/user-role.enum';

export class ChangeRoleRequestDto {
  @ApiProperty({
    example: UserRole.Admin,
    enum: UserRole,
    description: 'Role to assign to this member.',
  })
  @IsEnum(UserRole)
  role: UserRole;
}
