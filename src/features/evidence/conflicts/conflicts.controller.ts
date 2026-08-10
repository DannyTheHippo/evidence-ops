import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { conflictsApiExamples } from './api-examples/conflicts.api-examples';
import { ConflictsService } from './conflicts.service';
import { ConflictResponseDto } from './dtos/response/conflict.response.dto';

@Controller('conflicts')
@ApiTags('conflicts')
@ApiBearerAuth()
export class ConflictsController {
  constructor(private readonly conflictsService: ConflictsService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(conflictsApiExamples.list)
  async list(
    @Query() pagination: PaginationRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<ConflictResponseDto>> {
    // JwtAuthGuard always sets request.user before a non-public handler runs; this guards
    // the type only (request.user is optional because the same type covers public routes).
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.conflictsService.list(pagination, user.userId);

    return { docs: docs.map((doc) => toResponseDto(ConflictResponseDto, doc)), count };
  }
}
