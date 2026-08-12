// Same JWT the guard already accepts as a Bearer token; the cookie is a second transport for it,
// not a second credential.
export const AUTH_COOKIE_NAME = 'eo_session';

// The browser refuses to store a `__Host-`-prefixed cookie unless it also carries `Secure` and no
// `Domain` attribute with a `/` `Path` — exactly the prod-like condition (see `isProdLike`), so the
// two names are coupled to that one predicate: `__Host-eo_session` in prod-like environments (kills
// subdomain shadowing at the source), plain `eo_session` elsewhere (dev is plain HTTP, and a
// browser would silently reject the prefixed form there). The guard accepts either name.
export const AUTH_COOKIE_NAME_SECURE = `__Host-${AUTH_COOKIE_NAME}`;
