import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, _: Response, next: NextFunction): void {
    req.headers['x-correlation-id'] ??= randomUUID();

    next();
  }
}
