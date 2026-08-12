import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../../../shared/decorators/require-role.decorator';
import { UserRole } from '../../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../../shared/types/authenticated-request.type';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Opt-in guard: absent metadata means this route does not use roles at all, not "deny".
    // It is mounted route-scoped, only where `@RequireRole()` appears.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const role = request.user?.role;

    // Fail CLOSED: a missing user, a missing role, or a role value outside the required set is
    // checked by explicit membership, never by negating a mismatch check, so a malformed truthy
    // value cannot slip through.
    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenException('Insufficient role for this action');
    }

    return true;
  }
}
