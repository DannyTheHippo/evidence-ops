import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { RolesGuard } from '../../common/auth/guards/roles.guard';
import { RequireRole } from '../../../shared/decorators/require-role.decorator';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { approvalsApiExamples } from './api-examples/approvals.api-examples';
import { APPROVAL_DECISION_THROTTLE_LIMIT } from './approvals.constant';
import { ApprovalsService } from './approvals.service';
import { DecideApprovalRequestDto } from './dtos/request/decide-approval.request.dto';
import { ApprovalResponseDto } from './dtos/response/approval.response.dto';

@Controller('approvals')
@ApiTags('approvals')
@ApiBearerAuth()
export class ApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(approvalsApiExamples.list)
  async list(
    @Query() pagination: PaginationRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<ApprovalResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.approvalsService.listPending(
      pagination,
      user.userId,
      user.tenantId,
    );

    return { docs: docs.map((doc) => toResponseDto(ApprovalResponseDto, doc)), count };
  }

  @Post(':id/decision')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  // Route-scoped, not a third global APP_GUARD: Nest runs global guards (JwtAuthGuard) before
  // route-scoped ones, so request.user is already populated by the time this guard reads it.
  // A global registration would introduce cross-module ordering coupling for the sake of gating
  // this single endpoint — the only irreversible human-judgement boundary in the system this cycle.
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  // Tighter than the global default bucket (`ThrottlerModule.forRootAsync` in app.module.ts):
  // this is the one irreversible human-judgement boundary in the system, so it does not share
  // headroom with unrelated read traffic like /health.
  @Throttle({ default: { limit: APPROVAL_DECISION_THROTTLE_LIMIT, ttl: 60_000 } })
  @ApiResponse(approvalsApiExamples.decided)
  @ApiResponse(approvalsApiExamples.notFound)
  @ApiResponse(approvalsApiExamples.alreadyDecided)
  @ApiResponse(approvalsApiExamples.forbidden)
  async decide(
    @Param('id') id: string,
    @Body() dto: DecideApprovalRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<ApprovalResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      ApprovalResponseDto,
      await this.approvalsService.decide(id, {
        decision: dto.decision,
        reason: dto.reason,
        actorId: user.userId,
        decidedBy: user.email,
        tenantId: user.tenantId,
      }),
    );
  }
}
