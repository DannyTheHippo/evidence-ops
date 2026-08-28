import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import {
  ApiKey,
  ApiKeyDocument,
} from '../../../database/schemas/administration/api-key/api-key.schema';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import {
  ApiKeyLimitExceededException,
  ApiKeyNotFoundException,
} from './exceptions/api-keys.exception';
import type { TokenVerifier, VerifiedIdentity } from './token-verifier.interface';

const TOKEN_PREFIX = 'eo_pat_';
const TOKEN_RANDOM_BYTES = 32;
/** base64url has no padding, so `TOKEN_RANDOM_BYTES` bytes always encode to `ceil(n * 4 / 3)`
 *  characters — 43 for 32 bytes. Computed rather than hardcoded so a future change to
 *  `TOKEN_RANDOM_BYTES` cannot silently desync this from the actual token shape. */
const TOKEN_RANDOM_LENGTH = Math.ceil((TOKEN_RANDOM_BYTES * 4) / 3);
const TOKEN_LENGTH = TOKEN_PREFIX.length + TOKEN_RANDOM_LENGTH;
const TOKEN_DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 6;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A key past this count of active (non-revoked, unexpired) keys refuses further minting for the
 *  same user, bounding how many live credentials a single compromised account can accumulate. Not
 *  config-driven — a per-user credential cap is a fixed platform decision, not a deployment knob. */
export const MAX_ACTIVE_KEYS_PER_USER = 10;

export interface MintApiKeyInput {
  readonly name: string;
  readonly expiresAt?: Date;
  readonly actorId: string;
  readonly tenantId: string;
}

export interface MintedApiKeyResult {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly tokenPrefix: string;
  readonly expiresAt?: Date;
  readonly createdAt: Date;
}

export interface ApiKeyResult {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
  readonly lastUsedAt?: Date;
  readonly createdAt: Date;
}

@Injectable()
export class ApiKeysService implements TokenVerifier {
  constructor(
    @InjectModel(ApiKey.name)
    private readonly apiKeyModel: Model<ApiKeyDocument>,

    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    private readonly config: TypedConfigService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(ApiKeysService.name);
  }

  /**
   * Stamps the minting user's current session epoch onto the key, which is what `verify` compares
   * on every call. Fails CLOSED on a missing `User` row: the row was live when `JwtAuthGuard`
   * admitted this request, so its absence means the account went away mid-request and there is no
   * epoch to issue the key against.
   */
  async mint(input: MintApiKeyInput): Promise<MintedApiKeyResult> {
    const user = await this.userModel.findById(input.actorId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
    const tokenHash = this.hash(token);
    const tokenPrefix = token.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH);
    const expiresAt = input.expiresAt ?? this.defaultExpiresAt();

    const apiKey = await this.apiKeyModel.create({
      tenantId: input.tenantId,
      userId: new Types.ObjectId(input.actorId),
      tokenHash,
      tokenPrefix,
      name: input.name,
      expiresAt,
      tokenVersion: user.tokenVersion,
    });

    await this.assertUnderActiveKeyCap(apiKey, input.actorId, input.tenantId);

    await this.auditService.record({
      action: 'api-keys.minted',
      actorId: input.actorId,
      subject: { entityType: 'ApiKey', entityId: apiKey._id.toString() },
      tenantId: input.tenantId,
    });

    this.logger.debug(`Minted API key '${apiKey._id.toString()}' for user '${input.actorId}'`);

    // `token` is the only place the plaintext ever appears — not persisted, not logged above.
    return {
      id: apiKey._id.toString(),
      name: apiKey.name,
      token,
      tokenPrefix,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    };
  }

  async list(
    pagination: PaginationRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<ApiKeyResult>> {
    const filter = { tenantId, userId: new Types.ObjectId(actorId) };

    const [keys, count] = await Promise.all([
      this.apiKeyModel.find(filter, null, {
        sort: { createdAt: -1 },
        skip: pagination.skip,
        limit: pagination.limit,
      }),
      this.apiKeyModel.countDocuments(filter),
    ]);

    await this.auditService.record({
      action: 'api-keys.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return { docs: keys.map((key) => this.toResult(key)), count };
  }

  async revoke(id: string, actorId: string, tenantId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new ApiKeyNotFoundException(`API key '${id}' not found`);
    }

    // Scoped by userId as well as tenantId — a user manages only their own keys, so another
    // user's key id in the same tenant is indistinguishable from a missing one, same as a
    // cross-tenant id.
    const apiKey = await this.apiKeyModel.findOneAndUpdate(
      { _id: id, userId: new Types.ObjectId(actorId), tenantId },
      { $set: { revokedAt: new Date() } },
    );
    if (!apiKey) {
      throw new ApiKeyNotFoundException(`API key '${id}' not found`);
    }

    await this.auditService.record({
      action: 'api-keys.revoked',
      actorId,
      subject: { entityType: 'ApiKey', entityId: id },
      tenantId,
    });

    this.logger.debug(`Revoked API key '${id}'`);
  }

  /**
   * Rotates the key's token on its existing row — identity, name, creation date and audit history
   * all survive; only the token, its hash and its prefix move. Follows `mint`'s own token
   * generation, hashing and prefix rather than a second path. The previous token stops working the
   * moment this succeeds — only its hash was ever stored, so there is nothing to fall back to.
   *
   * Stamps the caller's session epoch fresh from the live `User` row rather than carrying the
   * existing key's `tokenVersion` forward: `verify` refuses any key whose stored epoch does not
   * match the user's current one, so a key minted under a stale epoch would otherwise come back
   * rotated and still fail its very first use.
   *
   * Scoped by userId as well as tenantId, same as `revoke`, and refuses an already-revoked key —
   * a foreign-tenant id, another user's key id, and a revoked key are all indistinguishable from a
   * missing one.
   */
  async rotate(id: string, actorId: string, tenantId: string): Promise<MintedApiKeyResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new ApiKeyNotFoundException(`API key '${id}' not found`);
    }

    const user = await this.userModel.findById(actorId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
    const tokenHash = this.hash(token);
    const tokenPrefix = token.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH);

    const apiKey = await this.apiKeyModel.findOneAndUpdate(
      {
        _id: id,
        userId: new Types.ObjectId(actorId),
        tenantId,
        revokedAt: { $exists: false },
      },
      { $set: { tokenHash, tokenPrefix, tokenVersion: user.tokenVersion } },
    );
    if (!apiKey) {
      throw new ApiKeyNotFoundException(`API key '${id}' not found`);
    }

    await this.auditService.record({
      action: 'api-keys.rotated',
      actorId,
      subject: { entityType: 'ApiKey', entityId: id },
      tenantId,
    });

    this.logger.debug(`Rotated API key '${id}'`);

    // `token` is the only place the plaintext ever appears — not persisted, not logged above.
    return {
      id: apiKey._id.toString(),
      name: apiKey.name,
      token,
      tokenPrefix,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
    };
  }

  /**
   * Fails CLOSED at every step: a malformed token, an unrecognized hash, a revoked or expired
   * key, a key whose user row no longer exists, and a key whose session epoch no longer matches
   * that row all return `null` rather than an identity — never throws. `role` and `tenantId` are
   * read from the `User` row on this call, never from the key itself: a role persisted on the
   * token would let a demoted user keep elevated access until the token expired.
   *
   * The epoch comparison is what makes `User.tokenVersion` a revocation lever over every credential
   * an account holds rather than only its browser session. A non-numeric epoch on the key — a row
   * written before the field existed — is refused for the same reason `JwtAuthGuard` refuses a
   * token carrying no epoch claim: a key that makes no statement about when it was issued cannot be
   * shown to predate a raise.
   */
  async verify(presentedToken: string): Promise<VerifiedIdentity | null> {
    if (presentedToken.length !== TOKEN_LENGTH || !presentedToken.startsWith(TOKEN_PREFIX)) {
      return null;
    }

    const computedHash = this.hash(presentedToken);
    const apiKey = await this.apiKeyModel.findOne({ tokenHash: computedHash });
    if (!apiKey || !this.digestsMatch(computedHash, apiKey.tokenHash)) {
      return null;
    }

    if (apiKey.revokedAt) {
      return null;
    }
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
      return null;
    }

    const user = await this.userModel.findById(apiKey.userId);
    if (
      !user ||
      typeof apiKey.tokenVersion !== 'number' ||
      apiKey.tokenVersion !== user.tokenVersion
    ) {
      return null;
    }

    await this.apiKeyModel.updateOne({ _id: apiKey._id }, { $set: { lastUsedAt: new Date() } });

    return {
      userId: user._id.toString(),
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
    };
  }

  /** `timingSafeEqual` throws on unequal-length buffers rather than returning `false` — sha256 hex
   *  digests are always 64 characters on both sides in practice, but the length check guards that
   *  precondition explicitly rather than letting a corrupt row crash verification instead of just
   *  refusing it. */
  private digestsMatch(computedHex: string, storedHex: string): boolean {
    const computed = Buffer.from(computedHex);
    const stored = Buffer.from(storedHex);
    if (computed.length !== stored.length) {
      return false;
    }
    return timingSafeEqual(computed, stored);
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private defaultExpiresAt(): Date {
    return new Date(Date.now() + this.config.apiKeys.defaultTtlDays * MS_PER_DAY);
  }

  /**
   * Fails CLOSED: removes the key just written and throws, rather than leaving the user above
   * `MAX_ACTIVE_KEYS_PER_USER` active (non-revoked, unexpired) keys.
   *
   * Counted AFTER the insert, with the new key included, because a count taken before it is a
   * read whose answer another writer can invalidate before this one writes: two concurrent mints
   * both read nine, both decide they are under the cap, and both insert. Counting afterwards makes
   * each writer's own row visible to its own check, so at most one of a concurrent pair can see a
   * count within the cap. A cap spanning many documents cannot be expressed as a conditional write
   * on one of them the way `ApprovalsService.decide`'s state guard is, and the expiry half of the
   * predicate is a moving window that no maintained counter field could stay true to.
   *
   * Both writers of a racing pair may refuse — each seeing the other's row — leaving the user below
   * the cap rather than above it. That is the direction this must err in: a credential cap that
   * over-refuses costs a retry, and one that over-admits is a compromised account holding more live
   * credentials than the platform agreed to issue. The compensating delete removes only this
   * call's own row, named by `_id`, so a concurrent refusal cannot take another mint's key with it.
   */
  private async assertUnderActiveKeyCap(
    minted: ApiKeyDocument,
    actorId: string,
    tenantId: string,
  ): Promise<void> {
    const activeCount = await this.apiKeyModel.countDocuments({
      tenantId,
      userId: new Types.ObjectId(actorId),
      revokedAt: { $exists: false },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
    });

    if (activeCount > MAX_ACTIVE_KEYS_PER_USER) {
      await this.apiKeyModel.deleteOne({ _id: minted._id });
      throw new ApiKeyLimitExceededException(
        `User '${actorId}' already has ${MAX_ACTIVE_KEYS_PER_USER} active API keys, the maximum allowed`,
      );
    }
  }

  private toResult(apiKey: ApiKeyDocument): ApiKeyResult {
    return {
      id: apiKey._id.toString(),
      name: apiKey.name,
      tokenPrefix: apiKey.tokenPrefix,
      expiresAt: apiKey.expiresAt,
      revokedAt: apiKey.revokedAt,
      lastUsedAt: apiKey.lastUsedAt,
      createdAt: apiKey.createdAt,
    };
  }
}
