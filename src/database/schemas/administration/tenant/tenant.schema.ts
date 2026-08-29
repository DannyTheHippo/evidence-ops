import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type TenantDocument = HydratedDocument<WithTimestamps<Tenant>>;

/**
 * The tenant registry. Every other collection's `tenantId` field points at `Tenant.tenantId`, an
 * opaque identifier distinct from this document's own `_id`. `tenantScopePlugin` activates on any
 * schema declaring a `tenantId` path and scopes queries against this collection the same way it
 * does everywhere else.
 *
 * The plugin's `pre('validate')` stamp only ever fires on a brand-new document
 * (`this.isNew && this.get('tenantId') == null`) and never touches a document that already
 * exists, so re-saving an existing registry row can never have its `tenantId` overwritten by an
 * authenticated caller's ALS tenant through this hook. A `tenantId` supplied explicitly at
 * creation is also left alone, since `get('tenantId')` is already non-null by the time the hook
 * runs.
 */
@Schema({ timestamps: true, collection: 'tenants' })
export class Tenant extends AuditableDocument {
  @Prop({ type: String, required: true, trim: true })
  tenantId: string;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  /**
   * `UsersService`'s admin-count guard increments this by one, inside its own transaction, on
   * every write that could reduce the tenant's admin count. The value itself is never read — only
   * the write is: `$inc` always registers a write intent, unlike a `$set` MongoDB is free to skip
   * when it would not change the stored value, so this is what gives two concurrent guarded writes
   * in the same tenant a document to collide on. No default needed at the document level; `$inc`
   * on a field that does not yet exist creates it starting from zero.
   */
  @Prop({ type: Number, required: false })
  adminGuardEpoch?: number;
}

export const TenantSchema = SchemaFactory.createForClass(Tenant);

/**
 * Declared with the same name `migrations/0001-baseline.ts` creates it under, and that
 * agreement is load-bearing rather than tidy. MongoDB refuses a second index on a key pattern it
 * already indexes under a different name, so two authorities naming the same index differently
 * fail whichever runs second: a `@Prop({ unique: true })` shorthand yields Mongoose's default
 * `tenantId_1` and collides with the migration's name. The direction of the failure depends on
 * boot order, and one direction is silent while the other is fatal — an application that reaches a
 * fresh database before its migrations do leaves that database permanently un-migratable without
 * manual index surgery. Naming them identically makes each a no-op for the other in either order.
 */
TenantSchema.index({ tenantId: 1 }, { unique: true, name: 'tenants_tenantId_unique' });
