import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TypedConfigService } from '../../../../config/environment/typed-config.service';
import { parseCookieHeader } from '../../../../shared/utils/parse-cookie.util';
import { AUTH_COOKIE_NAME } from '../auth.constant';
import { CsrfOriginMismatchException } from '../exceptions/auth.exception';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects a mutating, cookie-authenticated request whose `Origin` names a site other than the
 * one CORS already allows. A Bearer-authenticated or cookie-less request carries no ambient
 * credential a cross-site page could ride on, so it is never in scope here — the guard, not this
 * middleware, is the auth boundary for those.
 */
@Injectable()
export class CsrfOriginMiddleware implements NestMiddleware {
  constructor(private readonly config: TypedConfigService) {}

  use(req: Request, _: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const hasSessionCookie = AUTH_COOKIE_NAME in parseCookieHeader(req.headers.cookie);
    if (!hasSessionCookie) {
      // Fail OPEN: a Bearer-only or unauthenticated client is not a CSRF target — nothing here
      // rides along ambiently the way a cookie does.
      next();
      return;
    }

    const origin = req.headers.origin;
    if (origin === undefined) {
      // Fail OPEN, deliberately: non-browser clients (curl, scripts, server-to-server) omit
      // Origin, and can forge any header anyway, so rejecting on absence buys no security and
      // breaks legitimate tooling. This is the documented gap, not an oversight.
      next();
      return;
    }

    if (origin !== this.config.cors.origin) {
      // Fail CLOSED: this is the only branch that can veto a request carrying a session cookie,
      // so it has to actually refuse rather than warn-and-continue.
      throw new CsrfOriginMismatchException(`Origin '${origin}' is not the configured origin`);
    }

    next();
  }
}
