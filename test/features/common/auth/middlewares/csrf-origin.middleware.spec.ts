import type { Request, Response } from 'express';
import { CsrfOriginMismatchException } from '../../../../../src/features/common/auth/exceptions/auth.exception';
import { CsrfOriginMiddleware } from '../../../../../src/features/common/auth/middlewares/csrf-origin.middleware';
import { getMockTypedConfig } from '../../../../utils/get-mock-typed-config';

describe('CsrfOriginMiddleware', () => {
  const config = getMockTypedConfig({ cors: { origin: 'https://app.example.com' } });
  const middleware = new CsrfOriginMiddleware(config);

  const next = jest.fn();
  const res = {} as Response;

  const buildRequest = (overrides: Partial<Request> = {}): Request =>
    ({
      method: 'POST',
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
});
