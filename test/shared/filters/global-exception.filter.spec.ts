import { HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { TypedConfigService } from '../../../src/config/environment/typed-config.service';
import { GlobalExceptionFilter } from '../../../src/shared/filters/global-exception.filter';
import { NodeEnv } from '../../../src/shared/enums/global/node-env.enum';
import { getMockTypedConfig } from '../../utils/get-mock-typed-config';

describe('GlobalExceptionFilter', () => {
  /**
   * Returns `status`/`json` as standalone locals rather than properties on a `response` object:
   * asserting on `response.status` reads as an unbound method reference off that object and trips
   * `@typescript-eslint/unbound-method`. The locals are the exact same `jest.fn()` instances the
   * filter invokes, so assertions on them are equally strong.
   */
  const buildHost = (): {
    host: ArgumentsHost;
    status: jest.Mock<{ json: typeof json }, [number]>;
    json: jest.Mock<void, [Record<string, unknown>]>;
  } => {
    const json = jest.fn<void, [Record<string, unknown>]>();
    const status = jest.fn<{ json: typeof json }, [number]>().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status, json }) }),
    } as unknown as ArgumentsHost;

    return { host, status, json };
  };

  // `getMockTypedConfig` merges overrides per-namespace, so `app` has to carry its full shape,
  // not just `env` — a partial override would drop the rest of the namespace.
  const buildFilter = async (env: NodeEnv): Promise<GlobalExceptionFilter> => {
    const config = getMockTypedConfig({
      app: { env, port: 3000, logLevel: 'debug', url: 'http://localhost:3000' },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [GlobalExceptionFilter, { provide: TypedConfigService, useValue: config }],
    }).compile();

    return module.get(GlobalExceptionFilter);
  };

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('status and message mapping', () => {
    it('should pass through status and message for an HttpException carrying a string response', async () => {
      const filter = await buildFilter(NodeEnv.TEST);
      const { host, status, json } = buildHost();
      const exception = new HttpException('Not found', HttpStatus.NOT_FOUND);

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ status: HttpStatus.NOT_FOUND, message: 'Not found' }),
      );
    });

    it('should spread an HttpException object response so message/error survive', async () => {
      const filter = await buildFilter(NodeEnv.TEST);
      const { host, status, json } = buildHost();
      const exception = new HttpException(
        { statusCode: HttpStatus.BAD_REQUEST, message: 'Validation failed', error: 'Bad Request' },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Validation failed',
          error: 'Bad Request',
        }),
      );
    });

    it('should map a non-HttpException to a 500 with a generic message and not leak the original message', async () => {
      const filter = await buildFilter(NodeEnv.PRODUCTION);
      const { host, status, json } = buildHost();
      const exception = new Error('a very specific internal detail');

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      const [body] = json.mock.calls[0];
      expect(body.message).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('a very specific internal detail');
    });

    it('should map a thrown non-Error value to a 500 with the generic message', async () => {
      const filter = await buildFilter(NodeEnv.TEST);
      const { host, status, json } = buildHost();

      filter.catch('a thrown string', host);

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Internal server error' }),
      );
      expect(json.mock.calls[0][0]).not.toHaveProperty('stack');
    });

    it('should map an undefined thrown value to a 500 with the generic message', async () => {
      const filter = await buildFilter(NodeEnv.TEST);
      const { host, status, json } = buildHost();

      filter.catch(undefined, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Internal server error' }),
      );
    });
  });

  describe('stack and cause suppression', () => {
    it('should omit stack and cause in production', async () => {
      const filter = await buildFilter(NodeEnv.PRODUCTION);
      const { host, json } = buildHost();
      const exception = new Error('boom', { cause: new Error('root cause') });

      filter.catch(exception, host);

      const [body] = json.mock.calls[0];
      expect(body).not.toHaveProperty('stack');
      expect(body).not.toHaveProperty('cause');
    });

    it('should omit stack and cause in staging', async () => {
      const filter = await buildFilter(NodeEnv.STAGING);
      const { host, json } = buildHost();
      const exception = new Error('boom', { cause: new Error('root cause') });

      filter.catch(exception, host);

      const [body] = json.mock.calls[0];
      expect(body).not.toHaveProperty('stack');
      expect(body).not.toHaveProperty('cause');
    });

    it('should include the stack in a non-prod-like environment', async () => {
      const filter = await buildFilter(NodeEnv.TEST);
      const { host, json } = buildHost();
      const exception = new Error('boom');

      filter.catch(exception, host);

      const [body] = json.mock.calls[0];
      expect(body.stack).toBe(exception.stack);
    });

    it('should serialize a cause that is an Error instance into message and stack', async () => {
      const filter = await buildFilter(NodeEnv.TEST);
      const { host, json } = buildHost();
      const rootCause = new Error('root cause');
      const exception = new Error('boom', { cause: rootCause });

      filter.catch(exception, host);

      const [body] = json.mock.calls[0];
      expect(body.cause).toEqual({ message: rootCause.message, stack: rootCause.stack });
    });

    it('should not attach or throw when the cause is not an Error instance', async () => {
      const filter = await buildFilter(NodeEnv.TEST);
      const { host, json } = buildHost();
      const exception = new Error('boom', { cause: 'a plain string cause' });

      expect(() => filter.catch(exception, host)).not.toThrow();
      const [body] = json.mock.calls[0];
      expect(body).not.toHaveProperty('cause');
    });
  });
});
