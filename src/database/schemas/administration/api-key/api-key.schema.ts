import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type ApiKeyDocument = HydratedDocument<WithTimestamps<ApiKey>>;

/**
 * A personal access token minted for a user, letting a non-browser client (an MCP consumer) call
 * the API without carrying the SPA's cookie session — see `TokenVerifier` (`token-verifier.interface.ts`)
 * for the verification seam this schema backs. The plaintext token is never persisted: only
 * `tokenHash` (a sha256 digest) and `tokenPrefix` (a short, non-secret slice for identifying a key
 * in a list) live here, so a leaked database yields no usable credential.
 */
@Schema({ timestamps: true, collection: 'api_keys' })
export class ApiKey extends AuditableDocument {
  @Prop({ type: String, required: true })
  tenantId: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** sha256 digest (hex) of the plaintext token — never the token itself. */
  @Prop({ type: String, required: true })
  tokenHash: string;

  /** Leading slice of the plaintext token, kept only so a user can recognize a key in a list; too
   *  short to reconstruct or verify the token itself. */
  @Prop({ type: String, required: true })
  tokenPrefix: string;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  /**
   * The minting user's `User.tokenVersion` at the moment this key was issued. `ApiKeysService.verify`
   * compares it against the row on every call, so raising a user's session epoch refuses their
   * personal access tokens as well as their browser session — without it the epoch is a lever that
   * moves only half the credentials an account holds. `required`, with no default: a key row whose
   * epoch is absent carries no claim about when it was issued, and `verify` refuses it.
   */
  @Prop({ type: Number, required: true })
  tokenVersion: number;

  @Prop({ type: Date })
  expiresAt?: Date;

  @Prop({ type: Date })
  revokedAt?: Date;

  /** Stamped by `ApiKeysService.verify` on every successful verification. Absent means the key
   *  has never been used to authenticate a request. */
  @Prop({ type: Date })
  lastUsedAt?: Date;
}

export const ApiKeySchema = SchemaFactory.createForClass(ApiKey);

/**
 * Declared here as well as in `migrations/0019-api-keys.ts` and `migrations/0021-api-key-expiry-and-usage.ts`,
 * with the same keys, options and names — the migrations build them in a deployed database, this
 * declaration is what `Model.syncIndexes()` builds for a test lane that never runs migrations. The
 * unique `{ tokenHash: 1 }` index is `ApiKeysService.verify`'s lookup path; `{ tenantId, userId, createdAt }`
 * backs the "this user's keys, newest first" listing query; `{ tenantId, userId, revokedAt }` backs
 * the active-key count `ApiKeysService.mint` runs against the per-user cap on every mint.
 */
ApiKeySchema.index({ tokenHash: 1 }, { unique: true, name: 'api_keys_tokenHash_unique' });
ApiKeySchema.index(
  { tenantId: 1, userId: 1, createdAt: -1 },
  { name: 'api_keys_tenantId_userId_createdAt' },
);
ApiKeySchema.index(
  { tenantId: 1, userId: 1, revokedAt: 1 },
  { name: 'api_keys_tenantId_userId_revokedAt' },
);

/** Backs `GET /api-keys?sort=name|lastUsedAt|expiresAt` — `list`'s filter always includes
 *  `userId` alongside `tenantId`, so each carries the same two-field prefix as the `createdAt`
 *  index above rather than a bare `{tenantId, ...}` pair. */
ApiKeySchema.index({ tenantId: 1, userId: 1, name: 1 }, { name: 'api_keys_tenantId_userId_name' });
ApiKeySchema.index(
  { tenantId: 1, userId: 1, lastUsedAt: 1 },
  { name: 'api_keys_tenantId_userId_lastUsedAt' },
);
ApiKeySchema.index(
  { tenantId: 1, userId: 1, expiresAt: 1 },
  { name: 'api_keys_tenantId_userId_expiresAt' },
);
