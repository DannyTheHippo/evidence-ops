import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
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

  @Get('search')
  @Version('1')
  @HttpCode(HttpStatus.OK)
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
