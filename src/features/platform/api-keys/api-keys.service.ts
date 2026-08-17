import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Model, Types } from 'mongoose';
import {
  ApiKey,
  ApiKeyDocument,
} from '../../../database/schemas/administration/api-key/api-key.schema';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { ApiKeyNotFoundException } from './exceptions/api-keys.exception';
import type { TokenVerifier, VerifiedIdentity } from './token-verifier.interface';

const TOKEN_PREFIX = 'eo_pat_';
const TOKEN_RANDOM_BYTES = 32;
/** base64url has no padding, so `TOKEN_RANDOM_BYTES` bytes always encode to `ceil(n * 4 / 3)`
 *  characters — 43 for 32 bytes. Computed rather than hardcoded so a future change to
 *  `TOKEN_RANDOM_BYTES` cannot silently desync this from the actual token shape. */
const TOKEN_RANDOM_LENGTH = Math.ceil((TOKEN_RANDOM_BYTES * 4) / 3);
const TOKEN_LENGTH = TOKEN_PREFIX.length + TOKEN_RANDOM_LENGTH;
const TOKEN_DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 6;

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
  readonly createdAt: Date;
}

@Injectable()
export class ApiKeysService implements TokenVerifier {
  constructor(
    @InjectModel(ApiKey.name)
    private readonly apiKeyModel: Model<ApiKeyDocument>,

    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(ApiKeysService.name);
  }

  async mint(input: MintApiKeyInput): Promise<MintedApiKeyResult> {
    const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
    const tokenHash = this.hash(token);
    const tokenPrefix = token.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH);

    const apiKey = await this.apiKeyModel.create({
      tenantId: input.tenantId,
      userId: new Types.ObjectId(input.actorId),
      tokenHash,
      tokenPrefix,
      name: input.name,
      expiresAt: input.expiresAt,
    });

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

  async list(actorId: string, tenantId: string): Promise<DocumentResultWithCount<ApiKeyResult>> {
    const filter = { tenantId, userId: new Types.ObjectId(actorId) };

    const [keys, count] = await Promise.all([
      this.apiKeyModel.find(filter, null, { sort: { createdAt: -1 } }),
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
   * Fails CLOSED at every step: a malformed token, an unrecognized hash, a revoked or expired
   * key, or a key whose user row no longer exists all return `null` rather than an identity —
   * never throws. `role` and `tenantId` are read from the `User` row on this call, never from the
   * key itself: a role persisted on the token would let a demoted user keep elevated access until
   * the token expired.
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
    if (!user) {
      return null;
    }

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

  private toResult(apiKey: ApiKeyDocument): ApiKeyResult {
    return {
      id: apiKey._id.toString(),
      name: apiKey.name,
      tokenPrefix: apiKey.tokenPrefix,
      expiresAt: apiKey.expiresAt,
      revokedAt: apiKey.revokedAt,
      createdAt: apiKey.createdAt,
    };
  }
}
