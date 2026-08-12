import { UserRole } from '../../../../shared/enums/user-role.enum';

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  role: UserRole;
}
