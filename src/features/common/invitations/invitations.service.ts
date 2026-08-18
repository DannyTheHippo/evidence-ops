import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Model } from 'mongoose';
import {
  Invitation,
  InvitationDocument,
} from '../../../database/schemas/administration/invitation/invitation.schema';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import type { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import type { DocumentResultWithCount } from '../../../shared/types/document-result-with-count.type';
import { InvitationEmailAlreadyRegisteredException } from './exceptions/invitations.exception';

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
  readonly createdAt: Date;
}

export interface VerifiedInvitation {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: UserRole;
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
    pagination: PaginationRequestDto,
    actorId: string,
    tenantId: string,
  ): Promise<DocumentResultWithCount<InvitationResult>> {
    const filter = { tenantId };

    const [invitations, count] = await Promise.all([
      this.invitationModel.find(filter, null, {
        sort: { createdAt: -1 },
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
   * Fails CLOSED at every step: a malformed token, an unrecognized hash, an expired or an
   * already-redeemed invitation all return `null` rather than an identity — never throws.
   * Read-only: this checks whether a token is currently valid, it does not consume it —
   * `AuthService.register` marks the invitation accepted only once it has actually created the
   * joining user, so a registration failure never burns a token that was never granted.
   */
  async verify(presentedToken: string): Promise<VerifiedInvitation | null> {
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
    if (invitation.expiresAt.getTime() < Date.now()) {
      return null;
    }

    return {
      id: invitation._id.toString(),
      tenantId: invitation.tenantId,
      email: invitation.email,
      role: invitation.role,
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

  private toResult(invitation: InvitationDocument): InvitationResult {
    return {
      id: invitation._id.toString(),
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      createdAt: invitation.createdAt,
    };
  }
}
