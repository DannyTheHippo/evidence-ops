import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { UserRole } from '../../../../shared/enums/user-role.enum';

export type InvitationDocument = HydratedDocument<WithTimestamps<Invitation>>;

/**
 * A single-use, expiring token that lets an admin bring a colleague into their own tenant —
 * `InvitationsService` is the token discipline precedent's twin: same prefixed random token, same
 * sha256-at-rest, same `timingSafeEqual` compare. `createdBy` comes from `AuditableDocument`, which
 * `auditablePlugin` stamps from the minting admin's session, exactly as it does for every other
 * mutable entity — no separate field is declared for it here.
 */
@Schema({ timestamps: true, collection: 'invitations' })
export class Invitation extends AuditableDocument {
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({ type: String, required: true, lowercase: true, trim: true })
  email: string;

  @Prop({ type: String, required: true, enum: Object.values(UserRole) })
  role: UserRole;

  /** sha256 digest (hex) of the plaintext token — never the token itself. */
  @Prop({ type: String, required: true })
  tokenHash: string;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  /** Stamped when the token is redeemed at registration. Absent means the invitation is still
   *  pending; present makes it single-use — a second redemption attempt has nothing left to grant. */
  @Prop({ type: Date })
  acceptedAt?: Date;
}

export const InvitationSchema = SchemaFactory.createForClass(Invitation);

/**
 * Declared here as well as in `migrations/0022-invitations.ts`, with the same keys, options and
 * names — the migration builds them in a deployed database, this declaration is what
 * `Model.syncIndexes()` builds for a test lane that never runs migrations. The unique
 * `{ tokenHash: 1 }` index is `InvitationsService`'s redemption lookup path; `{ tenantId: 1, createdAt: -1 }`
 * backs "this tenant's invitations, newest first", the listing query an admin panel runs.
 */
InvitationSchema.index({ tokenHash: 1 }, { unique: true, name: 'invitations_tokenHash_unique' });
InvitationSchema.index({ tenantId: 1, createdAt: -1 }, { name: 'invitations_tenantId_createdAt' });
