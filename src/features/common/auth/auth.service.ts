import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcryptjs';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  Tenant,
  TenantDocument,
} from '../../../database/schemas/administration/tenant/tenant.schema';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuditService } from '../../../shared/services/audit/audit.service';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { LoginRequestDto } from './dtos/request/login.request.dto';
import { RegisterRequestDto } from './dtos/request/register.request.dto';
import { MeResponseDto } from './dtos/response/me.response.dto';
import {
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
} from './exceptions/auth.exception';
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

    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(AuthService.name);
  }

  async register(dto: RegisterRequestDto): Promise<MeResponseDto> {
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
      user = await this.userModel.create({ email, password, tenantId, role: UserRole.Admin });
    } catch (error) {
      // The registrant is the sole member of a tenant that failed to gain a user — remove the
      // orphaned registry row rather than leave a tenant with nobody in it.
      await this.tenantModel.deleteOne({ tenantId });
      throw error;
    }

    this.logger.debug(
      `User registered with the _id '${user._id.toString()}' as admin of tenant '${tenant.tenantId}'`,
    );

    return this.toMeDto(user);
  }

  async login(dto: LoginRequestDto): Promise<LoginResult> {
    const email = dto.email.toLowerCase();

    const user = await this.userModel.findOne({ email });
    if (!user) {
      await bcrypt.compare(dto.password, DUMMY_PASSWORD_HASH);
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }

    const matches = await bcrypt.compare(dto.password, user.password);
    if (!matches) {
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user._id.toString(),
      email: user.email,
      tenantId: user.tenantId,
      role: user.role,
    });

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
