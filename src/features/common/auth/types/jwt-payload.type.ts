import { UserRole } from '../../../../shared/enums/user-role.enum';

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  role: UserRole;
  /** The `User.tokenVersion` this token was minted from. `JwtAuthGuard` refuses the token when it
   *  no longer matches the row, which is how raising the epoch revokes a live session. */
  tokenVersion: number;
}
