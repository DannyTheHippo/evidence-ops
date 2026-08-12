import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AuditEvent,
  AuditEventSchema,
} from '../../../database/schemas/audit/audit-event/audit-event.schema';
import { AuditEventsController } from './audit-events.controller';
import { AuditEventsService } from './audit-events.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: AuditEvent.name, schema: AuditEventSchema }])],
  controllers: [AuditEventsController],
  providers: [AuditEventsService],
  exports: [AuditEventsService],
})
export class AuditEventsModule {}
