import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import bcrypt from 'bcryptjs';
import { Model } from 'mongoose';
import { User, UserDocument } from '../../../database/schemas/administration/user/user.schema';
import { AppLogger } from '../../../shared/services/logger/logger.service';
import { LoginRequestDto } from './dtos/request/login.request.dto';
import { RegisterRequestDto } from './dtos/request/register.request.dto';
import { AuthTokenResponseDto } from './dtos/response/auth-token.response.dto';
import { MeResponseDto } from './dtos/response/me.response.dto';
import {
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
} from './exceptions/auth.exception';

const PASSWORD_HASH_COST = 12;
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

// Compared against on unknown-email logins so failure timing matches a real password mismatch.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing-parity', PASSWORD_HASH_COST);

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,

    private readonly jwtService: JwtService,
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
    const user = await this.userModel.create({ email, password });

    this.logger.debug(`User registered with the _id '${user._id.toString()}'`);

    return this.toMeDto(user);
  }

  async login(dto: LoginRequestDto): Promise<AuthTokenResponseDto> {
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

  private toMeDto(user: UserDocument): MeResponseDto {
    return {
      id: user._id.toString(),
      email: user.email,
      createdAt: user.createdAt,
    };
  }
}
