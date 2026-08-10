import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AlsContext } from '../types/als-context.type';

@Injectable()
export class AsyncLocalStorageMiddleware implements NestMiddleware {
  constructor(
    @Inject(AsyncLocalStorage)
    private readonly als: AsyncLocalStorage<AlsContext>,
  ) {}

  use(req: Request, _: Response, next: NextFunction): void {
    const context: AlsContext = {
      'correlation-id': (req.headers?.['x-correlation-id'] as string) ?? randomUUID(),
    };

    this.als.run(context, () => next());
  }
}
