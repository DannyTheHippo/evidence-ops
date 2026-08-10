import { Module } from '@nestjs/common';
import { TOOL_AUTHZ_HOOK } from './authz-hook.interface';
import { DenyAllAuthzHook } from './deny-all.authz-hook';
import { ToolExecutorService } from './tool-executor.service';

// The default `TOOL_AUTHZ_HOOK` binding is `DenyAllAuthzHook` — see its own doc comment. No
// Mongoose model, no other module dependency: the chokepoint has no persistence or provider needs
// of its own, matching `QaModule`'s note about `GroundingGateService` having none either.
@Module({
  providers: [ToolExecutorService, { provide: TOOL_AUTHZ_HOOK, useClass: DenyAllAuthzHook }],
  exports: [ToolExecutorService],
})
export class AuthzModule {}
