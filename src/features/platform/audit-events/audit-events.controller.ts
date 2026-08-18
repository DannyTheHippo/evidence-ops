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
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { RolesGuard } from '../../common/auth/guards/roles.guard';
import { RequireRole } from '../../../shared/decorators/require-role.decorator';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { auditEventsApiExamples } from './api-examples/audit-events.api-examples';
import { AuditEventsService } from './audit-events.service';
import { ListAuditEventsRequestDto } from './dtos/request/list-audit-events.request.dto';
import { AuditEventResponseDto } from './dtos/response/audit-event.response.dto';

@Controller('audit-events')
@ApiTags('audit-events')
export class AuditEventsController {
  constructor(private readonly auditEventsService: AuditEventsService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  // Route-scoped, matching ApprovalsController's decide handler: reading who did what is an
  // administrative capability, not something every authenticated user gets.
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(auditEventsApiExamples.list)
  @ApiResponse(auditEventsApiExamples.forbidden)
  async list(
    @Query() query: ListAuditEventsRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<AuditEventResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.auditEventsService.list(query, user.userId, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(AuditEventResponseDto, doc)), count };
  }
}
