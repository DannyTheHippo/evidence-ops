import { HttpException, HttpStatus } from '@nestjs/common';

export class BaseException extends HttpException {
  constructor(message: string, status: HttpStatus = HttpStatus.BAD_REQUEST, cause?: unknown) {
    super(message, status, cause instanceof Error ? { cause } : undefined);
    // `new.target` is the constructor the `new` expression named, so every subclass reports its
    // own class name without restating it. Temporal classifies an activity failure by this string
    // (`src/workflows/ingest-retry-policy.ts`), so the guarantee belongs to this class rather than
    // to whatever `HttpException`'s own initialisation happens to do; `test/shared/exceptions/
    // base.exception.spec.ts` holds it.
    this.name = new.target.name;
  }
}
