import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, WithTimestamps } from 'mongoose';
import { DEFAULT_TENANT_ID } from '../../../constants/tenant.constant';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';
import { UserRole } from '../../../../shared/enums/user-role.enum';

export type UserDocument = HydratedDocument<WithTimestamps<User>>;

@Schema({ timestamps: true, collection: 'users' })
export class User extends AuditableDocument {
  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true, index: true })
  email: string;

  @Prop({ type: String, required: true })
  password: string;

  // Self-serve tenant provisioning is out of scope this cycle (see `0010-user-tenancy-and-roles.ts`)
  // — every user, new or backfilled, carries the single default tenant. `email` stays globally
  // unique on purpose: the unique index above is not tenant-scoped, and that is deliberate, not an
  // oversight to "fix" alongside this field.
  @Prop({ type: String, required: true, default: DEFAULT_TENANT_ID })
  tenantId: string;

  @Prop({ type: String, required: true, enum: Object.values(UserRole), default: UserRole.Member })
  role: UserRole;
}

export const UserSchema = SchemaFactory.createForClass(User);
