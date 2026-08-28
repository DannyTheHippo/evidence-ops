import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Model, Types } from 'mongoose';
import {
  Invitation,
  InvitationDocument,
} from '../../../database/schemas/administration/invitation/invitation.schema';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { resolveSort } from '../../../shared/utils/resolve-sort.util';
import {
  DEFAULT_INVITATION_SORT_DIRECTION,
  DEFAULT_INVITATION_SORT_FIELD,
  type ListInvitationsRequestDto,
} from './dtos/request/list-invitations.request.dto';
import {
  InvitationEmailAlreadyRegisteredException,
  InvitationNotFoundException,
} from './exceptions/invitations.exception';

const TOKEN_PREFIX = 'eo_inv_';
const TOKEN_RANDOM_BYTES = 32;
/** base64url has no padding, so `TOKEN_RANDOM_BYTES` bytes always encode to `ceil(n * 4 / 3)`
 *  characters — 43 for 32 bytes. Computed rather than hardcoded so a future change to
 *  `TOKEN_RANDOM_BYTES` cannot silently desync this from the actual token shape. */
const TOKEN_RANDOM_LENGTH = Math.ceil((TOKEN_RANDOM_BYTES * 4) / 3);
const TOKEN_LENGTH = TOKEN_PREFIX.length + TOKEN_RANDOM_LENGTH;

/** A pending invitation refuses redemption past this window, bounding how long a token an admin
 *  minted stays a live way into the tenant. Not config-driven — a fixed platform decision, not a
 *  deployment knob, mirroring `MAX_ACTIVE_KEYS_PER_USER`. */
export const INVITATION_TTL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface MintInvitationInput {
  readonly email: string;
  readonly role: UserRole;
  readonly actorId: string;
  readonly tenantId: string;
}

export interface MintedInvitationResult {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly token: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface InvitationResult {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly expiresAt: Date;
  readonly acceptedAt?: Date;
  readonly revokedAt?: Date;
  readonly createdAt: Date;
}

export interface VerifiedInvitation {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface InvitationPreview {
  readonly email: string;
  readonly role: UserRole;
  readonly invitedBy?: string;
}

@Injectable()
export class InvitationsService {
  constructor(
    @InjectModel(Invitation.name)
    private readonly invitationModel: Model<InvitationDocument>,

    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(InvitationsService.name);
  }

  async mint(input: MintInvitationInput): Promise<MintedInvitationResult> {
    const email = input.email.toLowerCase();

    const existingUser = await this.userModel.findOne({ email });
    if (existingUser) {
      throw new InvitationEmailAlreadyRegisteredException(
        `Email '${email}' already has an account`,
      );
    }

    const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * MS_PER_DAY);

    const invitation = await this.invitationModel.create({
      tenantId: input.tenantId,
      email,
      role: input.role,
      tokenHash,
      expiresAt,
    });

    await this.auditService.record({
      action: 'invitations.minted',
      actorId: input.actorId,
      subject: { entityType: 'Invitation', entityId: invitation._id.toString() },
      tenantId: input.tenantId,
    });

    this.logger.debug(
      `Minted invitation '${invitation._id.toString()}' for email '${email}' in tenant '${input.tenantId}'`,
    );

    // `token` is the only place the plaintext ever appears — not persisted, not logged above.
    return {
      id: invitation._id.toString(),
      email: invitation.email,
      role: invitation.role,
      token,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    };
  }

  async list(
    pagination: ListInvitationsRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<InvitationResult>> {
    const filter = { tenantId };

    const [invitations, count] = await Promise.all([
      this.invitationModel.find(filter, null, {
        sort: resolveSort(
          pagination.sort,
          pagination.sortDir,
          DEFAULT_INVITATION_SORT_FIELD,
          DEFAULT_INVITATION_SORT_DIRECTION,
        ),
        skip: pagination.skip,
        limit: pagination.limit,
      }),
      this.invitationModel.countDocuments(filter),
    ]);

    await this.auditService.record({
      action: 'invitations.listed',
      actorId,
      subject: { entityType: 'User', entityId: actorId },
      tenantId,
    });

    return { docs: invitations.map((invitation) => this.toResult(invitation)), count };
  }

  /**
   * `findLiveInvitation` fails CLOSED at every step, so a malformed token, an unrecognized hash, an
   * expired, revoked, or already-redeemed invitation all return `null` here too — never throws.
   * Read-only: this checks whether a token is currently valid, it does not consume it. Consumption
   * happens in `accept`, which `AuthService.registerWithInvitation` calls once it has reserved a
   * user id but before it creates the user, so two concurrent redemptions of the same token cannot
   * both proceed to `create`.
   */
  async verify(presentedToken: string): Promise<VerifiedInvitation | null> {
    const invitation = await this.findLiveInvitation(presentedToken);
    if (!invitation) {
      return null;
    }

    return {
      id: invitation._id.toString(),
      tenantId: invitation.tenantId,
      email: invitation.email,
      role: invitation.role,
    };
  }

  /**
   * The unauthenticated counterpart to `verify`: what an invite-page visitor may learn about their
   * own token before they commit to a password. Shares `findLiveInvitation`, so an unknown,
   * expired, revoked, or already-accepted token is refused identically here too — `null`, never a
   * distinguishing error. Resolves `createdBy` to the inviting admin's email for display; that
   * admin's account existing is not the secret this endpoint protects; the invited email's account
   * status is, and this never queries for it.
   */
  async preview(presentedToken: string): Promise<InvitationPreview | null> {
    const invitation = await this.findLiveInvitation(presentedToken);
    if (!invitation) {
      return null;
    }

    const inviter = invitation.createdBy
      ? await this.userModel.findById(invitation.createdBy)
      : null;

    return {
      email: invitation.email,
      role: invitation.role,
      invitedBy: inviter?.email,
    };
  }

  /**
   * Atomically reserves an invitation for the given user, scoped to its own tenant. The filter
   * only matches a pending, unrevoked invitation — `acceptedAt` and `revokedAt` both unset — so a
   * second concurrent redemption of the same token finds nothing to update and gets `false` back,
   * refused before it ever attempts to create a user, rather than racing both attempts through to
   * the unique email index and surfacing as an unhandled 500. Returns `false` for a stale,
   * foreign-tenant, revoked, or already-redeemed invitation id.
   */
  async accept(invitationId: string, userId: string, tenantId: string): Promise<boolean> {
    const reserved = await this.invitationModel.findOneAndUpdate(
      {
        _id: invitationId,
        tenantId,
        acceptedAt: { $exists: false },
        revokedAt: { $exists: false },
      },
      { $set: { acceptedAt: new Date() } },
    );
    if (!reserved) {
      return false;
    }

    await this.auditService.record({
      action: 'invitations.accepted',
      actorId: userId,
      subject: { entityType: 'Invitation', entityId: invitationId },
      tenantId,
    });

    this.logger.debug(`Invitation '${invitationId}' accepted by user '${userId}'`);
    return true;
  }

  /**
   * Reverses a reservation made by `accept`, for when the user creation it was guarding fails for a
   * reason unrelated to the race — the token stays redeemable rather than being burned on a request
   * that never actually admitted anyone.
   */
  async release(invitationId: string, tenantId: string): Promise<void> {
    await this.invitationModel.updateOne(
      { _id: invitationId, tenantId },
      { $unset: { acceptedAt: '' } },
    );
  }

  /**
   * Kills an outstanding invitation inside its live window, so `verify` and `accept` refuse its
   * token from this point on — not a soft-delete, the row still expires off its own `expiresAt`
   * either way (the durable record of what happened lives in `audit_events`). Idempotent: revoking
   * an already-revoked invitation just re-stamps `revokedAt`. Scoped by `tenantId`, so a foreign
   * tenant's id, an already-accepted invitation, and an id that was never minted all throw the same
   * `InvitationNotFoundException` — none distinguishable from another.
   */
  async revoke(id: string, actorId: string, tenantId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new InvitationNotFoundException(`Invitation '${id}' not found`);
    }

    const invitation = await this.invitationModel.findOneAndUpdate(
      { _id: id, tenantId, acceptedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
    if (!invitation) {
      throw new InvitationNotFoundException(`Invitation '${id}' not found`);
    }

    await this.auditService.record({
      action: 'invitations.revoked',
      actorId,
      subject: { entityType: 'Invitation', entityId: id },
      tenantId,
    });

    this.logger.debug(`Revoked invitation '${id}'`);
  }

  /**
   * Rotates the invitation's token, following `mint`'s own hashing, expiry and generation rather
   * than a second path: the previous plaintext token was never persisted, so the old link stops
   * working the moment this succeeds — there is nothing to fall back to. Only a pending, unrevoked
   * invitation can be resent; a foreign-tenant id, an already-accepted or already-revoked
   * invitation, and an id that was never minted all throw the same `InvitationNotFoundException`.
   */
  async resend(id: string, actorId: string, tenantId: string): Promise<MintedInvitationResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new InvitationNotFoundException(`Invitation '${id}' not found`);
    }

    const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * MS_PER_DAY);

    const invitation = await this.invitationModel.findOneAndUpdate(
      {
        _id: id,
        tenantId,
        acceptedAt: { $exists: false },
        revokedAt: { $exists: false },
      },
      { $set: { tokenHash, expiresAt } },
    );
    if (!invitation) {
      throw new InvitationNotFoundException(`Invitation '${id}' not found`);
    }

    await this.auditService.record({
      action: 'invitations.resent',
      actorId,
      subject: { entityType: 'Invitation', entityId: id },
      tenantId,
    });

    this.logger.debug(`Resent invitation '${id}', rotating its token`);

    // `token` is the only place the plaintext ever appears — not persisted, not logged above.
    return {
      id: invitation._id.toString(),
      email: invitation.email,
      role: invitation.role,
      token,
      expiresAt,
      createdAt: invitation.createdAt,
    };
  }

  /**
   * Shared by `verify` and `preview`: fails CLOSED at every step, a malformed token, an
   * unrecognized hash, an expired, revoked, or already-redeemed invitation all resolve to `null`
   * rather than a document — never throws. Read-only: this checks whether a token is currently
   * valid, it does not consume it. Consumption happens in `accept`, which
   * `AuthService.registerWithInvitation` calls once it has reserved a user id but before it creates
   * the user, so two concurrent redemptions of the same token cannot both proceed to `create`.
   */
  private async findLiveInvitation(presentedToken: string): Promise<InvitationDocument | null> {
    if (presentedToken.length !== TOKEN_LENGTH || !presentedToken.startsWith(TOKEN_PREFIX)) {
      return null;
    }

    const computedHash = this.hash(presentedToken);
    const invitation = await this.invitationModel.findOne({ tokenHash: computedHash });
    if (!invitation || !this.digestsMatch(computedHash, invitation.tokenHash)) {
      return null;
    }

    if (invitation.acceptedAt) {
      return null;
    }
    if (invitation.revokedAt) {
      return null;
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      return null;
    }

    return invitation;
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

  private toResult(invitation: InvitationDocument): InvitationResult {
    return {
      id: invitation._id.toString(),
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt,
      createdAt: invitation.createdAt,
    };
  }
}
