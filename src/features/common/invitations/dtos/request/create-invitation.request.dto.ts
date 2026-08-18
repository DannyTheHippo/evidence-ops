import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum } from 'class-validator';
import { UserRole } from '../../../../../shared/enums/user-role.enum';

export class CreateInvitationRequestDto {
  @ApiProperty({ example: 'colleague@example.com', description: 'Email address to invite.' })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: UserRole.Member,
    enum: UserRole,
    description: 'Role the invitee joins the tenant with.',
  })
  @IsEnum(UserRole)
  role: UserRole;
}
