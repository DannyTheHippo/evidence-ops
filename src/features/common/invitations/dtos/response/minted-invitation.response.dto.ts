import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { UserRole } from '../../../../../shared/enums/user-role.enum';

/** The one and only response that carries the plaintext token — returned exactly once, at mint.
 *  Nothing persists it; an admin who loses this response has lost the token permanently and must
 *  mint a new invitation. */
export class MintedInvitationResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Invitation identifier.' })
  id: string;

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
    example: 'eo_inv_9f8c12ab34cd56ef',
    description:
      'The plaintext token. Shown exactly once — it cannot be retrieved again after this response.',
  })
  token: string;

  @Expose()
  @ApiProperty({
    example: '2026-07-08T00:00:00.000Z',
    description: 'When this invitation stops working.',
  })
  expiresAt: Date;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'Invitation creation timestamp.',
  })
  createdAt: Date;
}
