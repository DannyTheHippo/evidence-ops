import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcryptjs';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  Tenant,
  TenantDocument,
} from '../../../database/schemas/administration/tenant/tenant.schema';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import {
  Measure,
  MeasureDocument,
} from '../../../database/schemas/evidence/measure/measure.schema';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { seedMeasures } from '../../evidence/measures/measure-seed';
import { InvitationsService } from '../invitations/invitations.service';
import { LoginRequestDto } from './dtos/request/login.request.dto';
import { RegisterRequestDto } from './dtos/request/register.request.dto';
import { MeResponseDto } from './dtos/response/me.response.dto';
import {
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
  InvalidInvitationException,
  InvitationEmailConflictException,
} from './exceptions/auth.exception';
import { JwtPayload } from './types/jwt-payload.type';
import { LoginResult } from './types/login-result.type';

const PASSWORD_HASH_COST = 12;
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

// Compared against on unknown-email logins so failure timing matches a real password mismatch.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing-parity', PASSWORD_HASH_COST);

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    @InjectModel(Tenant.name)
    private readonly tenantModel: Model<TenantDocument>,

    @InjectModel(Measure.name)
    private readonly measureModel: Model<MeasureDocument>,

    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
    private readonly invitationsService: InvitationsService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(AuthService.name);
  }

  async register(dto: RegisterRequestDto): Promise<MeResponseDto> {
    if (dto.invitationToken) {
      return this.registerWithInvitation(dto.invitationToken, dto.password);
    }

    // `RegisterRequestDto.email` is validated as required whenever `invitationToken` is absent
    // (`@ValidateIf`); this guard only narrows the type for `tsc`, which cannot see across DTO
    // validation.
    if (!dto.email) {
      throw new BadRequestException('Email is required to register without an invitation');
    }
    const email = dto.email.toLowerCase();

    const existing = await this.userModel.findOne({ email });
    if (existing) {
      throw new EmailAlreadyRegisteredException(`Email '${email}' is already registered`);
    }

    const password = await bcrypt.hash(dto.password, PASSWORD_HASH_COST);

    // Registration provisions a brand-new tenant per registrant, never joins an existing one — the
    // tenantId is opaque and generated here, not supplied by the caller.
    const tenantId = randomUUID();
    const tenant = await this.tenantModel.create({ tenantId, name: email });

    let user: UserDocument;
    try {
      // A tenant is never half-born: its measures are seeded before it gains a user, so a failure
      // past this point always has both a tenant row and a measures row to clean up.
      await seedMeasures(this.measureModel, tenantId);
      user = await this.userModel.create({ email, password, tenantId, role: UserRole.Admin });
    } catch (error) {
      // The registrant is the sole member of a tenant that failed to gain a user, or the tenant's
      // measure seeding itself failed — either way remove both the orphaned tenant row and its
      // (possibly partial) measures rather than leave a tenant that exists but extracts nothing.
      await Promise.all([
        this.tenantModel.deleteOne({ tenantId }),
        this.measureModel.deleteMany({ tenantId }),
      ]);
      throw error;
    }

    this.logger.debug(
      `User registered with the _id '${user._id.toString()}' as admin of tenant '${tenant.tenantId}'`,
    );

    return this.toMeDto(user);
  }

  /**
   * Redeems a single-use invitation token: the invitation, not the caller, dictates the account's
   * email, tenant and role. `verify` fails CLOSED — unknown, expired, or already-redeemed all
   * return `null` — so any of those refuses with `InvalidInvitationException` rather than falling
   * back to provisioning a fresh tenant. An invitation whose email already has an account is
   * refused too, and that account is never touched — not moved, merged, or re-tenanted, since email
   * is globally unique here. `accept` reserves the invitation atomically, scoped to its tenant,
   * before the user is created: a concurrent redemption of the same token loses that reservation
   * and is refused here rather than racing through to the unique email index and surfacing as a
   * 500. If reservation succeeds but user creation then fails for an unrelated reason, the
   * reservation is released so the token stays redeemable.
   */
  private async registerWithInvitation(token: string, rawPassword: string): Promise<MeResponseDto> {
    const identity = await this.invitationsService.verify(token);
    if (!identity) {
      throw new InvalidInvitationException('Invitation is invalid, expired, or already used');
    }

    const existing = await this.userModel.findOne({ email: identity.email });
    if (existing) {
      throw new InvitationEmailConflictException(
        `Email '${identity.email}' already has an account`,
      );
    }

    const userId = new Types.ObjectId();
    const reserved = await this.invitationsService.accept(
      identity.id,
      userId.toString(),
      identity.tenantId,
    );
    if (!reserved) {
      throw new InvalidInvitationException('Invitation is invalid, expired, or already used');
    }

    const password = await bcrypt.hash(rawPassword, PASSWORD_HASH_COST);

    let user: UserDocument;
    try {
      user = await this.userModel.create({
        _id: userId,
        email: identity.email,
        password,
        tenantId: identity.tenantId,
        role: identity.role,
      });
    } catch (error) {
      await this.invitationsService.release(identity.id, identity.tenantId);
      throw error;
    }

    this.logger.debug(
      `User registered with the _id '${user._id.toString()}' via invitation, joining tenant '${identity.tenantId}' as '${identity.role}'`,
    );

    return this.toMeDto(user);
  }

  async login(dto: LoginRequestDto): Promise<LoginResult> {
    const email = dto.email.toLowerCase();

    const user = await this.userModel.findOne({ email });

    // An unknown email compares against a fixed hash of the same cost, so both outcomes spend one
    // bcrypt and neither answers faster. Both also refuse from this single site: the exception's
    // stack is part of the response body below prod-like environments (`GlobalExceptionFilter`),
    // and two throw sites put the branch that was taken into it.
    const matches = await bcrypt.compare(dto.password, user?.password ?? DUMMY_PASSWORD_HASH);
    if (!user || !matches) {
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }

    // Every claim here is re-read from the `User` row and re-compared on each request
    // (`JwtAuthGuard`) — adding one makes it an identity attribute the guard must revalidate, so
    // the guard's comparison set and this object move together.
    const payload: JwtPayload = {
      sub: user._id.toString(),
      email: user.email,
      tenantId: user.tenantId,
      role: user.role,
      tokenVersion: user.tokenVersion,
    };
    const accessToken = await this.jwtService.signAsync(payload);

    this.logger.debug(`User logged in with the _id '${user._id.toString()}'`);

    return {
      accessToken,
      user: this.toMeDto(user),
    };
  }

  async me(userId: string): Promise<MeResponseDto> {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.toMeDto(user);
  }

  // The JWT itself is stateless and carries on being valid until `exp` — this only records that
  // the user asked to end the session client-side, it does not revoke anything.
  async logout(userId: string, tenantId: string): Promise<void> {
    await this.auditService.record({
      action: 'auth.logout',
      actorId: userId,
      subject: { entityType: 'User', entityId: userId },
      tenantId,
    });

    this.logger.debug(`User logged out with the _id '${userId}'`);
  }

  private toMeDto(user: UserDocument): MeResponseDto {
    return {
      id: user._id.toString(),
      email: user.email,
      // role only — the SPA needs it to explain why an action is forbidden; tenantId has no
      // client-side use and stays server-internal.
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
