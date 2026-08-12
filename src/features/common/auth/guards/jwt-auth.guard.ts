import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AsyncLocalStorage } from 'node:async_hooks';
import { IS_PUBLIC_ROUTE } from '../../../../shared/decorators/public-route.decorator';
import { AlsContext } from '../../../../shared/types/als-context.type';
import { AuthenticatedRequest } from '../../../../shared/types/authenticated-request.type';
import { parseCookieHeader } from '../../../../shared/utils/parse-cookie.util';
import { AUTH_COOKIE_NAME, AUTH_COOKIE_NAME_SECURE } from '../auth.constant';
import { JwtPayload } from '../types/jwt-payload.type';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,

    @Inject(AsyncLocalStorage)
    private readonly als: AsyncLocalStorage<AlsContext>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // `__Host-eo_session` (prod-like) and `eo_session` (dev, plain HTTP) never both apply to the
    // same environment, but the guard accepts either name so it does not need to know which one
    // login chose.
    const cookies = parseCookieHeader(request.headers.cookie);
    const token =
      JwtAuthGuard.extractToken(request.headers.authorization) ??
      cookies[AUTH_COOKIE_NAME_SECURE] ??
      cookies[AUTH_COOKIE_NAME];
    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);

      // Fail closed on a pre-tenancy token: `tenantId`/`role` are required on JwtPayload, but a
      // token signed before this deploy can still verify successfully with the old two-claim
      // shape. JWT_EXPIRES_IN is 7 days with no refresh or revocation, so such tokens stay
      // structurally valid for up to a week post-deploy. Rejecting them forces one re-login,
      // which is the correct cost versus carrying a dual-shape payload type forever or
      // defaulting a missing tenant — defaulting a security claim is how isolation bugs are born.
      if (!payload.tenantId || !payload.role) {
        throw new UnauthorizedException('Invalid or expired token');
      }

      request.user = {
        userId: payload.sub,
        email: payload.email,
        tenantId: payload.tenantId,
        role: payload.role,
      };

      const store = this.als.getStore();
      if (store) {
        store.user = payload.sub;
        store.tenant = payload.tenantId;
      }

      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private static extractToken(header?: string): string | undefined {
    if (!header?.startsWith('Bearer ')) {
      return undefined;
    }

    return header.slice('Bearer '.length).trim() || undefined;
  }
}
