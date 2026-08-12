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
  // here and only `originalUrl` carries the full route. A mock that put the full path on `path`
  // would pass while the production match silently never fired — which is exactly what happened.
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

  it('should pass a non-mutating request regardless of cookie or origin', () => {
    const req = buildRequest({
      method: 'GET',
      headers: { cookie: 'eo_session=token', origin: 'https://hostile.example.com' },
    });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should pass a mutating request with no session cookie, regardless of origin', () => {
    const req = buildRequest({ headers: { origin: 'https://hostile.example.com' } });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should throw CsrfOriginMismatchException for a mutating, cookie-authenticated request whose Origin does not match', () => {
    const req = buildRequest({
      headers: { cookie: 'eo_session=token', origin: 'https://hostile.example.com' },
    });

    expect(() => middleware.use(req, res, next)).toThrow(CsrfOriginMismatchException);
    expect(next).not.toHaveBeenCalled();
  });

  it('should pass a mutating, cookie-authenticated request whose Origin matches the configured origin', () => {
    const req = buildRequest({
      headers: { cookie: 'eo_session=token', origin: 'https://app.example.com' },
    });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  // Deliberate fail-open: non-browser clients omit Origin and can forge any header anyway, so
  // this pins the documented gap rather than letting it drift.
  it('should pass a mutating, cookie-authenticated request with no Origin header', () => {
    const req = buildRequest({ headers: { cookie: 'eo_session=token' } });

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  // Dual-name accept: the prod-like `__Host-` prefixed cookie is a session cookie too, not just
  // the plain name.
  it('should throw CsrfOriginMismatchException for a request carrying the __Host- prefixed session cookie and a foreign Origin', () => {
    const req = buildRequest({
      headers: { cookie: '__Host-eo_session=token', origin: 'https://hostile.example.com' },
    });

    expect(() => middleware.use(req, res, next)).toThrow(CsrfOriginMismatchException);
    expect(next).not.toHaveBeenCalled();
  });

  // Login-CSRF hole: a forced cross-site top-level navigation to /auth/login has no session
  // cookie yet (it doesn't exist until login sets it), so the general cookie-absent exemption
  // above would wrongly pass it. The login path is in scope regardless of whether a cookie is
  // present.
  describe('the login route', () => {
    const loginRequest = (overrides: Partial<Request> = {}): Request =>
      buildRequest({ originalUrl: '/api/v1/auth/login', headers: {}, ...overrides });

    it('should throw CsrfOriginMismatchException for a cross-origin login with no session cookie', () => {
      const req = loginRequest({ headers: { origin: 'https://hostile.example.com' } });

      expect(() => middleware.use(req, res, next)).toThrow(CsrfOriginMismatchException);
      expect(next).not.toHaveBeenCalled();
    });

    it('should pass a login request with no Origin header, matching the documented fail-open', () => {
      const req = loginRequest();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should pass a login request whose Origin matches the configured origin', () => {
      const req = loginRequest({ headers: { origin: 'https://app.example.com' } });

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });
  });
});
