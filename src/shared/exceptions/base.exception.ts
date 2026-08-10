import { HttpException, HttpStatus } from '@nestjs/common';

export class BaseException extends HttpException {
  constructor(message: string, status: HttpStatus = HttpStatus.BAD_REQUEST, cause?: unknown) {
    super(message, status, cause instanceof Error ? { cause } : undefined);
  }
}
