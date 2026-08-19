import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { measuresApiExamples } from './api-examples/measures.api-examples';
import { MeasuresResponseDto } from './dtos/response/measures.response.dto';
import { MeasuresService } from './measures.service';

// No `@RequireRole` on `get` — member-visible by design: every figure here is a tenant-scoped
// aggregate a member can already reach by browsing answers and conflicts directly. `RolesGuard`
// is opt-in, so simply omitting it is what keeps this page member-visible.
@Controller('measures')
@ApiTags('measures')
export class MeasuresController {
  constructor(private readonly measuresService: MeasuresService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(measuresApiExamples.get)
  async get(@CurrentUser() user: AuthenticatedRequest['user']): Promise<MeasuresResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      MeasuresResponseDto,
      await this.measuresService.getForTenant(user.tenantId),
    );
  }
}
