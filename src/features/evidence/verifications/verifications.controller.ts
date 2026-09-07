import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { verificationsApiExamples } from './api-examples/verifications.api-examples';
import { ListVerificationsRequestDto } from './dtos/request/list-verifications.request.dto';
import { VerificationListResponseDto } from './dtos/response/verification-list.response.dto';
import { VerificationResponseDto } from './dtos/response/verification.response.dto';
import { VerificationsService } from './verifications.service';

/**
 * Read-only surface over verification runs — there is deliberately no POST route here. A run is
 * recorded by `VerificationsService.record`, called from the MCP `verify_claims` tool path and the
 * answer workflow, never directly by an HTTP client. No `@ApiBearerAuth()`: the session is a
 * cookie, matching every other controller in this codebase.
 */
@Controller('verifications')
@ApiTags('verifications')
export class VerificationsController {
  constructor(private readonly verificationsService: VerificationsService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(verificationsApiExamples.list)
  async list(
    @Query() query: ListVerificationsRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<VerificationListResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.verificationsService.list(query, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(VerificationResponseDto, doc)), count };
  }

  @Get(':id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(verificationsApiExamples.detail)
  @ApiResponse(verificationsApiExamples.notFound)
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<VerificationResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      VerificationResponseDto,
      await this.verificationsService.getById(id, user.userId, user.tenantId),
    );
  }
}
