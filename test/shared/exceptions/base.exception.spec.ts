import { HttpStatus } from '@nestjs/common';
import { BaseException } from '../../../src/shared/exceptions/base.exception';

class DirectSubclassException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

class GrandchildException extends DirectSubclassException {}

describe('BaseException', () => {
  // `name` is the only handle Temporal's `nonRetryableErrorTypes` has on an exception class
  // (`src/workflows/ingest-retry-policy.ts`), so a subclass reporting anything but its own class
  // name is silently unclassifiable.
  it('should report its own class name through every level of subclassing', () => {
    expect(new BaseException('boom').name).toBe('BaseException');
    expect(new DirectSubclassException('boom').name).toBe('DirectSubclassException');
    expect(new GrandchildException('boom').name).toBe('GrandchildException');
  });

  it('should keep the message, status and cause the caller passed', () => {
    const cause = new Error('underlying');
    const exception = new DirectSubclassException('boom', cause);

    expect(exception.message).toBe('boom');
    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(exception.cause).toBe(cause);
  });

  it('should default to 400 and no cause', () => {
    const exception = new BaseException('boom');

    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(exception.cause).toBeUndefined();
  });

  it('should ignore a non-Error cause rather than attaching it', () => {
    const exception = new BaseException('boom', HttpStatus.NOT_FOUND, 'a string');

    expect(exception.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(exception.cause).toBeUndefined();
  });
});
