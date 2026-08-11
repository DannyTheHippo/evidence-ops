import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Approval,
  ApprovalSchema,
} from '../../../database/schemas/workflow/approval/approval.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

// A second `forFeature` registration of `Approval` alongside `ProvidersModule`'s own (for
// `MongoApprovalChannel`) — Nest/Mongoose supports this: both resolve to the same underlying
// collection via distinct DI tokens, one per owning module. `ProvidersModule` import is for
// `WORKFLOW_ENGINE`, which `ApprovalsService.decide` signals.
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Approval.name, schema: ApprovalSchema }]),
    ProvidersModule,
  ],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
