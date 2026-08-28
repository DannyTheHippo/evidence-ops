import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { UserRole } from '../../../../shared/enums/user-role.enum';

export type UserDocument = HydratedDocument<WithTimestamps<User>>;

@Schema({ timestamps: true, collection: 'users' })
export class User extends AuditableDocument {
  @Prop({ type: String, required: true, lowercase: true, trim: true })
  email: string;

  @Prop({ type: String, required: true })
  password: string;

  // Registration provisions a real tenant per user and sets this explicitly; a seed or migration
  // backfill must do the same, since `required` refuses a save with no tenant rather than falling
  // back to a shared one. `email` stays globally unique on purpose: the unique index above is not
  // tenant-scoped, and that is deliberate, not an oversight to "fix" alongside this field.
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({ type: String, required: true, enum: Object.values(UserRole), default: UserRole.Member })
  role: UserRole;

  /**
   * Session epoch. Minted into every JWT and compared against this row on each request
   * (`JwtAuthGuard`), so raising it refuses every token issued before the raise. `required` with a
   * `0` default: a row with no epoch would mint an `undefined` claim, and the guard refuses a
   * non-numeric claim, so a missing value locks the account out rather than opening it.
   */
  @Prop({ type: Number, required: true, default: 0 })
  tokenVersion: number;
}

export const UserSchema = SchemaFactory.createForClass(User);

/**
 * Same name `migrations/0001-baseline.ts` creates it under — see `tenant.schema.ts`'s index for why
 * that agreement matters. Globally unique, not tenant-scoped: one email is one person, and the
 * operator co-tenanting path moves an existing user rather than creating a second row for them.
 */
UserSchema.index({ email: 1 }, { unique: true, name: 'users_email_unique' });
