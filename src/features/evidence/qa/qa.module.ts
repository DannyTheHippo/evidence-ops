import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Answer, AnswerSchema } from '../../../database/schemas/evidence/answer/answer.schema';
import {
  DocumentVersion,
  DocumentVersionSchema,
} from '../../../database/schemas/evidence/document-version/document-version.schema';
import { ProvidersModule } from '../../../providers/providers.module';
import { TOOL_AUTHZ_HOOK } from '../../platform/authz/authz-hook.interface';
import { StepPolicyAuthzHook } from '../../platform/authz/step-policy.authz-hook';
import { ToolExecutorService } from '../../platform/authz/tool-executor.service';
import { AgenticRetrievalService } from './agentic-retrieval.service';
import { AnswerPersistenceService } from './answer-persistence.service';
import { EvidenceRetrievalService } from './evidence-retrieval.service';
import { GroundingGateService } from './grounding-gate.service';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { SynthesisService } from './synthesis.service';

// `GroundingGateService` has no Mongoose/model dependency of its own (see its doc comment: it
// verifies, never queries) and needs no `ProvidersModule` import. `SynthesisService` needs it for
// `MODEL_PROVIDER`; `EvidenceRetrievalService` needs it for `RETRIEVAL_STORE`. `QaService` reuses
// the same `Answer` model registration and `ProvidersModule` import for `WORKFLOW_ENGINE`.
//
// `AgenticRetrievalService` needs `ToolExecutorService` for its `search_evidence`/`fetch_chunks`
// tool calls, but this module deliberately does not import `AuthzModule` for it. `ToolExecutorService`
// resolves `TOOL_AUTHZ_HOOK` from whichever module's injector constructs it — importing `AuthzModule`
// and only re-providing `TOOL_AUTHZ_HOOK` here would still hand `AgenticRetrievalService` the
// `ToolExecutorService` instance `AuthzModule` itself constructed, bound to that module's own
// `DenyAllAuthzHook`, since Nest resolves a provider's constructor dependencies within the module
// that declares the provider, not the module that ends up injecting it. Declaring both
// `ToolExecutorService` and its `TOOL_AUTHZ_HOOK` binding directly here gives this module its own
// instance, constructed against `StepPolicyAuthzHook` — `AuthzModule`'s own binding is untouched, so
// `DenyAllAuthzHook` stays the default everywhere else in the app that resolves `ToolExecutorService`
// through it.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Answer.name, schema: AnswerSchema },
      { name: DocumentVersion.name, schema: DocumentVersionSchema },
    ]),
    ProvidersModule,
  ],
  controllers: [QaController],
  providers: [
    SynthesisService,
    GroundingGateService,
    EvidenceRetrievalService,
    ToolExecutorService,
    { provide: TOOL_AUTHZ_HOOK, useClass: StepPolicyAuthzHook },
    AgenticRetrievalService,
    AnswerPersistenceService,
    QaService,
  ],
  exports: [
    SynthesisService,
    GroundingGateService,
    EvidenceRetrievalService,
    AgenticRetrievalService,
    AnswerPersistenceService,
    QaService,
  ],
})
export class QaModule {}
