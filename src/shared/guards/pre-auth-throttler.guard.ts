import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import { TypedConfigService } from '../../config/environment/typed-config.service';
import { AuthenticatedRequest } from '../types/authenticated-request.type';

const UNRESOLVED_TRACKER = 'pre-auth-unresolved';

// Mirrors the metadata key `@nestjs/throttler`'s `ThrottlerGuard` reads for its unnamed ('default')
// throttler: `SkipThrottle()` (default `{ default: true }`) writes `THROTTLER_SKIP + 'default'` via
// `Reflect.defineMetadata`, and `THROTTLER_SKIP` is the literal `'THROTTLER:SKIP'`. Neither constant
// is part of the package's public export surface, so the key is reconstructed here rather than
// imported from an internal path.
const THROTTLER_SKIP_DEFAULT_KEY = 'THROTTLER:SKIPdefault';

/**
 * Registered directly on `AppModule.providers` — module scan order (see `ThrottlingModule`'s doc
 * comment in `app.module.ts`) puts it ahead of `AuthModule`'s import, so it runs before
 * `JwtAuthGuard` on every request. `UserThrottlerGuard` only ever sees a request that already
 * passed authentication, so a credential-less burst against an authenticated route previously hit
 * `JwtAuthGuard`'s 401 and stopped there, spending no throttle budget at all. This guard bounds
 * every request by caller IP before that 401 can fire, closing that gap. Fails CLOSED: an
 * unresolvable IP still collapses onto one shared per-route key rather than being exempted.
 *
 * Deliberately keyed and limited independently of `@nestjs/throttler`'s `@Throttle()` route
 * overrides, which tune the fine-grained, post-auth `UserThrottlerGuard` per route (e.g.
 * retrieval's tighter search limit). This coarse perimeter layer always enforces the same
 * configured default (`config.throttle`) regardless of route, so a route's tighter override cannot
 * starve a different, legitimate caller sharing the same IP before that caller has even
 * authenticated. `@SkipThrottle()` is still honoured, unlike `@Throttle()`: a route that opts out
 * entirely (the long-lived SSE streams — see e.g. `QaController.streamAnswer`) is exempted from
 * this perimeter layer too, not just from `UserThrottlerGuard`, because those connections are
 * already bounded by a separate per-tenant/per-user concurrency cap rather than a request-rate one.
 */
@Injectable()
export class PreAuthThrottlerGuard implements CanActivate {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly config: TypedConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(THROTTLER_SKIP_DEFAULT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const tracker = request.ip ? `pre-auth-ip:${request.ip}` : UNRESOLVED_TRACKER;
    const key = `${context.getClass().name}-${context.getHandler().name}-${tracker}`;
    const { ttlMs, limit } = this.config.throttle;

    const { isBlocked } = await this.storage.increment(key, ttlMs, limit, ttlMs, 'pre-auth');
    if (isBlocked) {
      throw new ThrottlerException();
    }

    return true;
  }
}
