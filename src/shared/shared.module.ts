import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  AuditEvent,
  AuditEventSchema,
} from '../database/schemas/audit/audit-event/audit-event.schema';
import { AuditService } from './services/audit/audit.service';
import { AppLogger } from './services/logger/logger.service';
import { AlsContext } from './types/als-context.type';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: AuditEvent.name, schema: AuditEventSchema }])],
  providers: [
    { provide: AsyncLocalStorage, useValue: new AsyncLocalStorage<AlsContext>() },
    AppLogger,
    AuditService,
  ],
  exports: [AsyncLocalStorage, AppLogger, AuditService],
})
export class SharedModule {}
