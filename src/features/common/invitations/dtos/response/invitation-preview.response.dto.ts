import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { UserRole } from '../../../../../shared/enums/user-role.enum';

/** What an anonymous visitor holding a token may learn before they commit to a password — enough
 *  to judge whether the invitation is one they recognize, never whether the invited email already
 *  has an account. */
export class InvitationPreviewResponseDto {
  @Expose()
  @ApiProperty({ example: 'colleague@example.com', description: 'Email address invited.' })
  email: string;

  @Expose()
  @ApiProperty({
    example: UserRole.Member,
    enum: UserRole,
    description: 'Role the invitee joins the tenant with.',
  })
  role: UserRole;

  @Expose()
  @ApiProperty({
    example: 'admin@example.com',
    description:
      "The inviting admin's email, when that user still exists. Absent for an invitation whose " +
      'inviter has since been removed.',
    required: false,
  })
  invitedBy?: string;
}
