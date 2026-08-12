import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../enums/user-role.enum';

export const ROLES_KEY = 'ROLES_KEY';

export const RequireRole = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
