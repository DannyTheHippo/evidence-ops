import { Global, Module } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AppLogger } from './services/logger/logger.service';
import { AlsContext } from './types/als-context.type';

@Global()
@Module({
  providers: [
    { provide: AsyncLocalStorage, useValue: new AsyncLocalStorage<AlsContext>() },
    AppLogger,
  ],
  exports: [AsyncLocalStorage, AppLogger],
})
export class SharedModule {}
