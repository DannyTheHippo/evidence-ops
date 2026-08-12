import { isProdLike } from '../../../config/environment/environment.config';

// Same JWT the guard already accepts as a Bearer token; the cookie is a second transport for it,
// not a second credential.
export const AUTH_COOKIE_NAME = 'eo_session';

// The browser refuses to store a `__Host-`-prefixed cookie unless it also carries `Secure` and no
// `Domain` attribute with a `/` `Path` — exactly the prod-like condition (see `isProdLike`), so the
// two names are coupled to that one predicate: `__Host-eo_session` in prod-like environments (kills
// subdomain shadowing at the source), plain `eo_session` elsewhere (dev is plain HTTP, and a
// browser would silently reject the prefixed form there).
export const AUTH_COOKIE_NAME_SECURE = `__Host-${AUTH_COOKIE_NAME}`;

/**
 * Single source for which of the two names is valid in a given environment. Both the
 * cookie-setting side (`auth.controller.ts`) and the cookie-reading side (`jwt-auth.guard.ts`)
 * resolve through this one function, so exactly one name applies per environment and they cannot
 * select different names for the same request. Accepting both names unconditionally — the prior
 * shape — let an attacker who could plant a plain `eo_session` (XSS or a network position on a
 * plain-HTTP sibling subdomain) authenticate a victim who held no `__Host-` cookie at all; scoping
 * acceptance to the one name the current environment actually issues closes that gap.
 */
export const resolveSessionCookieName = (env: string): string =>
  isProdLike(env) ? AUTH_COOKIE_NAME_SECURE : AUTH_COOKIE_NAME;
