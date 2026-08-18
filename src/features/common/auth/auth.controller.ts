import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Response } from 'express';
import { isProdLike } from '../../../config/environment/environment.config';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { PublicRoute } from '../../../shared/decorators/public-route.decorator';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import {
  loginApiExamples,
  logoutApiExamples,
  meApiExamples,
  registerApiExamples,
} from './api-examples/auth.api-examples';
import { resolveSessionCookieName } from './auth.constant';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginRequestDto } from './dtos/request/login.request.dto';
import { RegisterRequestDto } from './dtos/request/register.request.dto';
import { AuthTokenResponseDto } from './dtos/response/auth-token.response.dto';
import { MeResponseDto } from './dtos/response/me.response.dto';
import { JwtPayload } from './types/jwt-payload.type';

@Controller('auth')
@ApiTags('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
    private readonly config: TypedConfigService,
  ) {}

  @Post('register')
  @Version('1')
  @PublicRoute()
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse(registerApiExamples.created)
  @ApiResponse(registerApiExamples.conflict)
  async register(@Body() dto: RegisterRequestDto): Promise<MeResponseDto> {
    return toResponseDto(MeResponseDto, await this.authService.register(dto));
  }

  @Post('login')
  @Version('1')
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiResponse(loginApiExamples.success)
  @ApiResponse(loginApiExamples.unauthorized)
  async login(
    @Body() dto: LoginRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokenResponseDto> {
    const result = await this.authService.login(dto);

    // exp is the only authority on the cookie's lifetime — mirroring the token means a change to
    // JWT_EXPIRES_IN never needs a matching change here.
    const { exp } = this.jwtService.decode<JwtPayload & { exp: number }>(result.accessToken);
    res.cookie(this.cookieName(), result.accessToken, this.cookieOptions(exp * 1000 - Date.now()));

    return toResponseDto(AuthTokenResponseDto, result);
  }

  @Post('logout')
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiResponse(logoutApiExamples.noContent)
  @ApiResponse(logoutApiExamples.unauthorized)
  async logout(
    @CurrentUser() user: AuthenticatedRequest['user'],
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    await this.authService.logout(user.userId, user.tenantId);

    res.cookie(this.cookieName(), '', this.cookieOptions(0));
  }

  @Get('me')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(meApiExamples.success)
  @ApiResponse(meApiExamples.unauthorized)
  async me(@CurrentUser() user: AuthenticatedRequest['user']): Promise<MeResponseDto> {
    // JwtAuthGuard always sets request.user before a non-public handler runs; this guards
    // the type only (request.user is optional because the same type covers public routes).
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(MeResponseDto, await this.authService.me(user.userId));
  }

  // `__Host-` requires Secure — same predicate, so the name and the flag can never disagree. The
  // guard resolves the same name via the same function, so the cookie this controller sets and
  // the cookie the guard will accept can never diverge.
  private cookieName(): string {
    return resolveSessionCookieName(this.config.app.env);
  }

  private cookieOptions(maxAge: number): CookieOptions {
    return {
      httpOnly: true,
      path: '/',
      // Lax rather than Strict: same protection against a cross-site fetch/XHR forging a
      // request, while a top-level navigation (the bytes-download route landing later this
      // cycle) still carries the cookie.
      sameSite: 'lax',
      secure: isProdLike(this.config.app.env),
      maxAge,
    };
  }
}
