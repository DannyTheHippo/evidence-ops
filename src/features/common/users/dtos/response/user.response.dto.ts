import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { UserRole } from '../../../../../shared/enums/user-role.enum';

/** Tenant-membership metadata only — `password` and `tokenVersion` never reach this shape. */
export class UserResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'User identifier.' })
  id: string;

  @Expose()
  @ApiProperty({ example: 'colleague@example.com', description: 'Email address.' })
  email: string;

  @Expose()
  @ApiProperty({
    example: UserRole.Member,
    enum: UserRole,
    description: 'Role within the tenant.',
  })
  role: UserRole;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'Account creation timestamp.',
  })
  createdAt: Date;
}
