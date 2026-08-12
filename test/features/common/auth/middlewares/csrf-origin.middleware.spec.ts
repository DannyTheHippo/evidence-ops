import type { Request, Response } from 'express';
import { CsrfOriginMismatchException } from '../../../../../src/features/common/auth/exceptions/auth.exception';
import { CsrfOriginMiddleware } from '../../../../../src/features/common/auth/middlewares/csrf-origin.middleware';
import { getMockTypedConfig } from '../../../../utils/get-mock-typed-config';

describe('CsrfOriginMiddleware', () => {
  const config = getMockTypedConfig({ cors: { origin: 'https://app.example.com' } });
  const middleware = new CsrfOriginMiddleware(config);

  const next = jest.fn();
  const res = {} as Response;

  // Modelled on what the middleware actually receives rather than on what a bare request looks
  // like: Express strips a middleware's mount prefix from `req.url`/`req.path`, so `path` is `/`
  // here and only `originalUrl` carries the full route.
  const buildRequest = (overrides: Partial<Request> = {}): Request =>
    ({
      method: 'POST',
      path: '/',
      originalUrl: '/api/v1/auth/logout',
      headers: {},
      ...overrides,
    }) as Request;

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should pass a non-mutating request regardless of origin', () => {
    const req = buildRequest({ method: 'GET', headers: { origin: 'https://hostile.example.com' } });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  // Deliberate fail-open: non-browser clients omit Origin and can forge any header anyway, so
  // this pins the documented gap rather than letting it drift.
  it('should pass a mutating request with no Origin header', () => {
    const req = buildRequest();

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should pass a mutating request whose Origin matches the configured origin', () => {
    const req = buildRequest({ headers: { origin: 'https://app.example.com' } });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  // The rule is now unconditional: no cookie check, no path allowlist. A mutating request with a
  // foreign Origin is refused whether or not it carries a session cookie — this used to pass when
  // no cookie was present, which was the general shape of the login-CSRF hole.
  it('should throw CsrfOriginMismatchException for a mutating request with a hostile Origin and no cookie', () => {
    const req = buildRequest({ headers: { origin: 'https://hostile.example.com' } });

    expect(() => middleware.use(req, res, next)).toThrow(CsrfOriginMismatchException);
    expect(next).not.toHaveBeenCalled();
  });

  it('should throw CsrfOriginMismatchException for a mutating, cookie-carrying request whose Origin does not match', () => {
    const req = buildRequest({
      headers: { cookie: 'eo_session=token', origin: 'https://hostile.example.com' },
    });

    expect(() => middleware.use(req, res, next)).toThrow(CsrfOriginMismatchException);
    expect(next).not.toHaveBeenCalled();
  });

  // Bypass regression: the prior design matched an exact-string COOKIE_SETTING_PATHS Set against
  // req.originalUrl.split('?')[0]. Nest's underlying express() runs with strict:false and
  // caseSensitive:false, so a trailing slash reached the login handler while matching nothing in
  // that Set. The new rule has no path check at all, so this is covered unconditionally — pinned
  // here so a future reintroduction of path matching reds this test.
  it('should throw CsrfOriginMismatchException for a hostile Origin against /api/v1/auth/login/ (trailing slash)', () => {
    const req = buildRequest({
      originalUrl: '/api/v1/auth/login/',
      headers: { origin: 'https://hostile.example.com' },
    });

    expect(() => middleware.use(req, res, next)).toThrow(CsrfOriginMismatchException);
    expect(next).not.toHaveBeenCalled();
  });

  // Same bypass class, case-insensitive routing this time: /api/v1/auth/LOGIN also matched
  // nothing in the old exact-string Set while still reaching the login handler.
  it('should throw CsrfOriginMismatchException for a hostile Origin against /api/v1/auth/LOGIN (case change)', () => {
    const req = buildRequest({
      originalUrl: '/api/v1/auth/LOGIN',
      headers: { origin: 'https://hostile.example.com' },
    });

    expect(() => middleware.use(req, res, next)).toThrow(CsrfOriginMismatchException);
    expect(next).not.toHaveBeenCalled();
  });

  it('should pass a login request whose Origin matches the configured origin', () => {
    const req = buildRequest({
      originalUrl: '/api/v1/auth/login',
      headers: { origin: 'https://app.example.com' },
    });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});
