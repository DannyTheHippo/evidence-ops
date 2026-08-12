import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TypedConfigService } from '../../../../config/environment/typed-config.service';
import { CsrfOriginMismatchException } from '../exceptions/auth.exception';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects any mutating request whose `Origin` header names a site other than the one CORS already
 * allows — unconditionally, regardless of path and regardless of whether the request carries a
 * session cookie.
 *
 * An earlier version scoped this check to requests carrying a session cookie, or targeting an
 * exact-string `COOKIE_SETTING_PATHS` allowlist matched against `req.originalUrl`. Nest builds a
 * bare `express()`, so `strict: false` and `caseSensitive: false` apply — measured on the
 * installed express 5.2.1, `/api/v1/auth/login/`, `/api/v1/auth/LOGIN`, and
 * `/API/V1/AUTH/LOGIN` all reach the login handler while matching nothing in that Set. A
 * cross-site form POST to any of those variants planted an attacker's session in the victim's
 * browser — the exact hole this middleware exists to close. Matching every mutating request
 * deletes the whole bypass class: no path string has to stay in sync with the router, and no
 * normalization can be got wrong.
 *
 * This does not break legitimate clients:
 * - A non-browser client (curl, scripts, server-to-server) omits `Origin` and is unaffected —
 *   see the fail-open branch below.
 * - A legitimate browser client is same-origin, so its `Origin` matches and it passes.
 * - A cross-origin browser client cannot read the response anyway under the configured CORS
 *   policy, so refusing the request here costs it nothing it could act on.
 * The previously-exempted case — a Bearer-authenticated request carrying a foreign `Origin` — was
 * only ever reachable from a browser, where CORS already governs it.
 */
@Injectable()
export class CsrfOriginMiddleware implements NestMiddleware {
  constructor(private readonly config: TypedConfigService) {}

  use(req: Request, _: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
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
      // Fail CLOSED: this is the only branch that can veto a mutating request, so it has to
      // actually refuse rather than warn-and-continue.
      throw new CsrfOriginMismatchException(`Origin '${origin}' is not the configured origin`);
    }

    next();
  }
}
