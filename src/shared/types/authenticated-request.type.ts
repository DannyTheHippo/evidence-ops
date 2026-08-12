import type { Request } from 'express';
import { UserRole } from '../enums/user-role.enum';

export type AuthenticatedRequest = Request & {
  user?: { userId: string; email: string; tenantId: string; role: UserRole };
};
