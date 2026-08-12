import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TypedConfigService } from '../../../../config/environment/typed-config.service';
import { parseCookieHeader } from '../../../../shared/utils/parse-cookie.util';
import { AUTH_COOKIE_NAME, AUTH_COOKIE_NAME_SECURE } from '../auth.constant';
import { CsrfOriginMismatchException } from '../exceptions/auth.exception';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Matched against `req.originalUrl`, NOT `req.path`. Express strips a middleware's own mount
// prefix from `req.url` (and therefore from `req.path`) before the handler runs — measured against
// the installed express 5.2.1: inside middleware mounted for these routes, `req.path` is `/` while
// `req.originalUrl` is the full `/api/v1/auth/login`. Only `originalUrl` survives mounting, so it
// is the only value an absolute route match can rely on here.
//
// Exact-match, not a prefix test: a route added under this path later that is not itself
// cookie-setting must be added explicitly, not swept in.
//
// Login is the only member today. It is `@PublicRoute()`, so the cookie-absent exemption below
// would otherwise pass it through unconditionally — but login is the one route whose side effect
// *sets* the session cookie, so "no cookie yet" is not evidence of "no browser-state risk" for
// this one path the way it is everywhere else. A forced cross-site top-level form POST here has
// no cookie to check and no CORS preflight to block it.
const COOKIE_SETTING_PATHS = new Set(['/api/v1/auth/login']);

/**
 * Rejects a mutating request whose `Origin` names a site other than the one CORS already allows,
 * when the request either carries a session cookie or targets a route that sets one. A
 * Bearer-authenticated request to any other route carries no ambient credential a cross-site page
 * could ride on, so it is never in scope here — the guard, not this middleware, is the auth
 * boundary for those.
 */
@Injectable()
export class CsrfOriginMiddleware implements NestMiddleware {
  constructor(private readonly config: TypedConfigService) {}

  use(req: Request, _: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    const hasSessionCookie = AUTH_COOKIE_NAME in cookies || AUTH_COOKIE_NAME_SECURE in cookies;
    const setsSessionCookie = COOKIE_SETTING_PATHS.has(req.originalUrl.split('?')[0]);
    if (!hasSessionCookie && !setsSessionCookie) {
      // Fail OPEN: a Bearer-only or unauthenticated client hitting a non-cookie-setting route is
      // not a CSRF target — nothing here rides along ambiently the way a cookie does.
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
      // Fail CLOSED: this is the only branch that can veto a request carrying a session cookie
      // or targeting a route that creates one, so it has to actually refuse rather than
      // warn-and-continue.
      throw new CsrfOriginMismatchException(`Origin '${origin}' is not the configured origin`);
    }

    next();
  }
}
