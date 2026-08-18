import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthenticatedRequest } from '../types/authenticated-request.type';

const UNRESOLVED_TRACKER = 'unresolved';

/**
 * Keys the throttle bucket by the authenticated user id when `request.user` is present, so two
 * users behind the same reverse proxy (`web/nginx.conf`) never share a bucket. Falls back to the
 * client IP for routes reached before authentication, such as login and registration. Fails
 * CLOSED: when neither a user id nor a resolvable IP is present, every such request collapses onto
 * one fixed shared key so it is still throttled together with every other unresolved request,
 * rather than exempted by a unique or empty tracker.
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
