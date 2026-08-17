import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ApiKey,
  ApiKeySchema,
} from '../../../database/schemas/administration/api-key/api-key.schema';
import { User, UserSchema } from '../../../database/schemas/administration/user/user.schema';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { TOKEN_VERIFIER } from './token-verifier.interface';

/**
 * `User` is registered here (alongside `ApiKey`) because `ApiKeysService.verify` resolves
 * `role`/`tenantId` live from the `User` row at verification time rather than trusting anything
 * stored on the key — see that method's own doc comment. `TOKEN_VERIFIER` binds to this module's
 * own service via `useExisting` rather than a new class, so an OAuth 2.1 implementation later is a
 * second binding, not a rewrite of whatever consumes this token.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ApiKey.name, schema: ApiKeySchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, { provide: TOKEN_VERIFIER, useExisting: ApiKeysService }],
  exports: [ApiKeysService, TOKEN_VERIFIER],
})
export class ApiKeysModule {}
