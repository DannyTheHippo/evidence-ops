import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PublicRoute } from '../../../shared/decorators/public-route.decorator';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import {
  loginApiExamples,
  meApiExamples,
  registerApiExamples,
} from './api-examples/auth.api-examples';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginRequestDto } from './dtos/request/login.request.dto';
import { RegisterRequestDto } from './dtos/request/register.request.dto';
import { AuthTokenResponseDto } from './dtos/response/auth-token.response.dto';
import { MeResponseDto } from './dtos/response/me.response.dto';

@Controller('auth')
@ApiTags('auth')
@ApiBearerAuth()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
  async login(@Body() dto: LoginRequestDto): Promise<AuthTokenResponseDto> {
    return toResponseDto(AuthTokenResponseDto, await this.authService.login(dto));
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
}
