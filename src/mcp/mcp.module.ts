import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfigModule } from '../config/config.module';
import { mongooseModuleOptions } from '../config/mongo.config';
import { ConflictsModule } from '../features/evidence/conflicts/conflicts.module';
import { QaModule } from '../features/evidence/qa/qa.module';
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
 * `EvidenceRetrievalService` and `QaService`; `ConflictsModule` supplies `ConflictsService` —
 * together the three tool handlers this surface registers. Like `QaModule` itself, this module
 * re-provides `ToolExecutorService` **and** `TOOL_AUTHZ_HOOK` together rather than only rebinding
 * the token: Nest resolves a provider's constructor dependencies in the module that declares the
 * provider, so declaring only the binding here would still hand `McpServerService` the instance
 * `QaModule` constructed — bound to `QaModule`'s own `StepPolicyAuthzHook`, not a defect, but a
 * second, independent `ToolExecutorService` instance (own registry) is what this surface's own
 * `mcp-read`/`mcp-mutate` steps need. `AuthzModule`'s `DenyAllAuthzHook` default is untouched by
 * either binding.
 */
@Module({
  imports: [
    AppConfigModule,
    MongooseModule.forRootAsync(mongooseModuleOptions),
    SharedModule,
    ApiKeysModule,
    QaModule,
    ConflictsModule,
  ],
  providers: [
    ToolExecutorService,
    { provide: TOOL_AUTHZ_HOOK, useClass: StepPolicyAuthzHook },
    PatTokenVerifier,
    McpServerService,
  ],
})
export class McpModule {}
