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
import { isProdLike } from '../../../../config/environment/environment.config';
import { TypedConfigService } from '../../../../config/environment/typed-config.service';
import { DEFAULT_TENANT_ID } from '../../../../database/constants/tenant.constant';
import { IS_PUBLIC_ROUTE } from '../../../../shared/decorators/public-route.decorator';
import { AlsContext } from '../../../../shared/types/als-context.type';
import { AuthenticatedRequest } from '../../../../shared/types/authenticated-request.type';
import { parseCookieHeader } from '../../../../shared/utils/parse-cookie.util';
import { resolveSessionCookieName } from '../auth.constant';
import { JwtPayload } from '../types/jwt-payload.type';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly config: TypedConfigService,

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

    // Exactly one cookie name is valid per environment (`resolveSessionCookieName`, same
    // predicate the controller uses to set it) — accepting the other name too would let a cookie
    // planted under the dev-only plain name authenticate a request in a prod-like environment
    // that never issues it. The session cookie is the only credential path this guard accepts —
    // no Authorization header, so an XSS-stolen bearer token cannot authenticate anything.
    const cookies = parseCookieHeader(request.headers.cookie);
    const token = cookies[resolveSessionCookieName(this.config.app.env)];
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

      // Fail closed on the seeded demo tenant in a prod-like environment: `DEFAULT_TENANT_ID` is a
      // guessable, shared id, and any token still carrying it — a stale JWT, a seeded dev account, a
      // hand-crafted one — would read the demo tenant's evidence. JWT_EXPIRES_IN is 7 days with no
      // refresh or revocation, so such a token stays structurally valid for up to a week after a
      // deploy. The rejection reuses the same generic message as every other failure in this guard
      // so a caller cannot distinguish "default tenant rejected" from "bad token" and use that as an
      // oracle for which tenant id is the demo one. Below prod-like, `'default'` is the valid seeded
      // dev tenant and must keep working.
      if (isProdLike(this.config.app.env) && payload.tenantId === DEFAULT_TENANT_ID) {
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
}
