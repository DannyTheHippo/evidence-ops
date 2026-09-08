import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfigModule } from '../config/config.module';
import { mongooseModuleOptions } from '../config/mongo.config';
import { AttestationsModule } from '../features/evidence/attestations/attestations.module';
import { ConflictsModule } from '../features/evidence/conflicts/conflicts.module';
import { LedgerModule } from '../features/evidence/ledger/ledger.module';
import { QaModule } from '../features/evidence/qa/qa.module';
import { SourcesModule } from '../features/evidence/sources/sources.module';
import { ApiKeysModule } from '../features/platform/api-keys/api-keys.module';
import { TOOL_AUTHZ_HOOK } from '../features/platform/authz/authz-hook.interface';
import { StepPolicyAuthzHook } from '../features/platform/authz/step-policy.authz-hook';
import { ToolExecutorService } from '../features/platform/authz/tool-executor.service';
import { SharedModule } from '../shared/shared.module';
import { McpServerService } from './mcp-server.service';
import { PatTokenVerifier } from './pat-token.verifier';

/**
 * Third-process root module, booted via `NestFactory.createApplicationContext` in `main.ts` —
 * mirrors `WorkerModule`'s "slice of `AppModule`, minus HTTP-only concerns" shape (ADR-0003), but
 * this process supplies its own HTTP layer by hand in `main.ts` rather than through Nest, so
 * there is no `ThrottlerModule`/`AuthModule`/global guard here at all.
 *
 * `ApiKeysModule` supplies `TOKEN_VERIFIER` (`PatTokenVerifier`'s dependency). `QaModule` supplies
 * `EvidenceRetrievalService` and `QaService`; `ConflictsModule` supplies `ConflictsService`;
 * `SourcesModule` supplies `EvidenceSubmissionService`; `LedgerModule` supplies `LedgerService`;
 * `AttestationsModule` supplies `AttestationService` — together the six tool handlers this
 * surface registers. This module re-provides `ToolExecutorService` **and** `TOOL_AUTHZ_HOOK`
 * together rather than only rebinding the token: Nest resolves a provider's constructor
 * dependencies in the module that declares the provider, so declaring only the binding here would
 * still hand `McpServerService` whatever instance a different module constructed. Declaring both
 * directly here gives this module its own instance, bound to its own `StepPolicyAuthzHook`, with
 * its own registry for this surface's `mcp-read`/`mcp-mutate`/`mcp-ask`/`mcp-verify`/`mcp-submit`
 * steps. `AuthzModule`'s `DenyAllAuthzHook` default is untouched by this binding.
 */
@Module({
  imports: [
    AppConfigModule,
    MongooseModule.forRootAsync(mongooseModuleOptions),
    SharedModule,
    ApiKeysModule,
    QaModule,
    ConflictsModule,
    SourcesModule,
    LedgerModule,
    AttestationsModule,
  ],
  providers: [
    ToolExecutorService,
    { provide: TOOL_AUTHZ_HOOK, useClass: StepPolicyAuthzHook },
    PatTokenVerifier,
    McpServerService,
  ],
})
export class McpModule {}
