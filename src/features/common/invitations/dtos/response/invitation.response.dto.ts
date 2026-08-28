import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { UserRole } from '../../../../../shared/enums/user-role.enum';

/** Metadata only — never the token, never `tokenHash`. Mint is the sole response shape that
 *  carries the plaintext token (`MintedInvitationResponseDto`); every other read of an invitation
 *  goes through this shape. */
export class InvitationResponseDto {
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
    example: '2026-07-08T00:00:00.000Z',
    description: 'When this invitation stops working.',
  })
  expiresAt: Date;

  @Expose()
  @ApiProperty({
    example: '2026-07-02T00:00:00.000Z',
    description: 'When this invitation was redeemed. Absent means it is still pending.',
    required: false,
  })
  acceptedAt?: Date;

  @Expose()
  @ApiProperty({
    example: '2026-07-03T00:00:00.000Z',
    description:
      'When this invitation was revoked. Absent means it is still live. A revoked invitation ' +
      'stays in this list — it is not deleted or filtered out — so its token stopping working is ' +
      'visible rather than silent.',
    required: false,
  })
  revokedAt?: Date;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'Invitation creation timestamp.',
  })
  createdAt: Date;
}
