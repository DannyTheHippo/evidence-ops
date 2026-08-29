import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Answer, AnswerSchema } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  Conflict,
  ConflictSchema,
} from '../../../database/schemas/evidence/conflict/conflict.schema';
import {
  Document,
  DocumentSchema,
} from '../../../database/schemas/evidence/document/document.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import { Source, SourceSchema } from '../../../database/schemas/evidence/source/source.schema';
import {
  Approval,
  ApprovalSchema,
} from '../../../database/schemas/workflow/approval/approval.schema';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

// Six second `forFeature` registrations, one per schema this feature reads — the same pattern
// `ApprovalsModule` documents: Nest/Mongoose resolves each to the same underlying collection via a
// distinct DI token per owning module. This feature owns none of these collections; it only counts.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Approval.name, schema: ApprovalSchema },
      { name: Conflict.name, schema: ConflictSchema },
      { name: Document.name, schema: DocumentSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
      { name: Source.name, schema: SourceSchema },
      { name: Answer.name, schema: AnswerSchema },
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
