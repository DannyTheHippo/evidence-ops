import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UnauthorizedException,
  UseGuards,
  Version,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { RolesGuard } from '../../common/auth/guards/roles.guard';
import { RequireRole } from '../../../shared/decorators/require-role.decorator';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { retrievalApiExamples } from './api-examples/retrieval.api-examples';
import { SearchEvidenceRequestDto } from './dtos/request/search-evidence.request.dto';
import { RetrievedChunkResponseDto } from './dtos/response/retrieved-chunk.response.dto';
import { RETRIEVAL_SEARCH_THROTTLE_LIMIT } from './retrieval.constant';
import { RetrievalService } from './retrieval.service';

@Controller('retrieval')
@ApiTags('retrieval')
export class RetrievalController {
  constructor(private readonly retrievalService: RetrievalService) {}

  // Stated explicitly rather than left to `RolesGuard`'s opt-in default (absent metadata means
  // "no role check", not "deny") — this is the only ungated path to raw corpus text on the browser
  // surface, and its MCP twin (`'mcp-read'` in `STEP_MINIMUM_ROLE`) states a Member floor
  // explicitly. Listing both roles changes nothing about who can call this today (every
  // authenticated tenant member already could), only whether the floor is visible at the route
  // rather than implied by the guard's default.
  @Get('search')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Member, UserRole.Admin)
  // See RETRIEVAL_SEARCH_THROTTLE_LIMIT's doc comment: every call spends a live embedding call,
  // so this window bounds spend rather than sharing headroom with the global default bucket.
  @Throttle({ default: { limit: RETRIEVAL_SEARCH_THROTTLE_LIMIT, ttl: 60_000 } })
  @ApiResponse(retrievalApiExamples.found)
  async search(
    @Query() dto: SearchEvidenceRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<RetrievedChunkResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.retrievalService.search(dto, user.userId, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(RetrievedChunkResponseDto, doc)), count };
  }
}
