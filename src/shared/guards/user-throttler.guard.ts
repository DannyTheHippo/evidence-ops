import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthenticatedRequest } from '../types/authenticated-request.type';

const UNRESOLVED_TRACKER = 'unresolved';

/**
 * Keys the throttle bucket by the authenticated user id when `request.user` is present, so two
 * users behind the same reverse proxy (`web/nginx.conf`) never share a bucket. Falls back to the
 * client IP for public routes reached with no credential at all, such as login and registration.
 * Fails CLOSED within its own scope: when neither a user id nor a resolvable IP is present, every
 * such request collapses onto one fixed shared key so it is still throttled together with every
 * other unresolved request, rather than exempted by a unique or empty tracker.
 *
 * That scope only ever covers requests `JwtAuthGuard` let through (whether by verifying a
 * credential or by `@PublicRoute()`) — a request `JwtAuthGuard` rejects never reaches this guard at
 * all, module scan order runs it after `AuthModule` (see `ThrottlingModule`'s doc comment in
 * `app.module.ts`). `PreAuthThrottlerGuard` is what bounds the credential-less requests this guard
 * structurally cannot see.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as AuthenticatedRequest;

    if (request.user?.userId) {
      return Promise.resolve(`user:${request.user.userId}`);
    }

    if (request.ip) {
      return Promise.resolve(`ip:${request.ip}`);
    }

    return Promise.resolve(UNRESOLVED_TRACKER);
  }
}
