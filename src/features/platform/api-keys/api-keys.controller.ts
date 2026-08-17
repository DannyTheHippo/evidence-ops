import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { apiKeysApiExamples } from './api-examples/api-keys.api-examples';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyRequestDto } from './dtos/request/create-api-key.request.dto';
import { ApiKeyResponseDto } from './dtos/response/api-key.response.dto';
import { MintedApiKeyResponseDto } from './dtos/response/minted-api-key.response.dto';

@Controller('api-keys')
@ApiTags('api-keys')
@ApiBearerAuth()
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse(apiKeysApiExamples.minted)
  async mint(
    @Body() dto: CreateApiKeyRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MintedApiKeyResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      MintedApiKeyResponseDto,
      await this.apiKeysService.mint({
        name: dto.name,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        actorId: user.userId,
        tenantId: user.tenantId,
      }),
    );
  }

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(apiKeysApiExamples.list)
  async list(
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<ApiKeyResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.apiKeysService.list(user.userId, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(ApiKeyResponseDto, doc)), count };
  }

  @Delete(':id')
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiResponse(apiKeysApiExamples.revoked)
  @ApiResponse(apiKeysApiExamples.notFound)
  async revoke(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    await this.apiKeysService.revoke(id, user.userId, user.tenantId);
  }
}
