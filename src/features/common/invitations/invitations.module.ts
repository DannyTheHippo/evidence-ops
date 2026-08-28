import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Invitation,
  InvitationSchema,
} from '../../../database/schemas/administration/invitation/invitation.schema';
import { User, UserSchema } from '../../../database/schemas/administration/user/user.schema';
import { CredentialThrottleGuard } from '../auth/guards/credential-throttle.guard';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * `User` is registered here (alongside `Invitation`) because `InvitationsService.mint` refuses an
 * email that already has an account — see that method's own logic. `InvitationsService` is
 * exported so `AuthModule` can inject it once registration accepts a token (`verify`), mirroring
 * `ApiKeysModule`'s export of its own token-verification seam.
 *
 * `CredentialThrottleGuard` is provided directly here rather than imported via `AuthModule` —
 * `AuthModule` already imports this module, so the reverse import would be circular. Its own
 * dependencies (`ThrottlerStorage`, `TypedConfigService`) are both global providers, so declaring
 * the class as a provider here is sufficient; nothing about the guard is `AuthModule`-specific.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Invitation.name, schema: InvitationSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [InvitationsController],
  providers: [InvitationsService, CredentialThrottleGuard],
  exports: [InvitationsService],
})
export class InvitationsModule {}
