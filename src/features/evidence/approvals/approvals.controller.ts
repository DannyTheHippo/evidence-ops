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
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { approvalsApiExamples } from './api-examples/approvals.api-examples';
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

    const { docs, count } = await this.approvalsService.listPending(pagination, user.userId);

    return { docs: docs.map((doc) => toResponseDto(ApprovalResponseDto, doc)), count };
  }

  @Post(':id/decision')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(approvalsApiExamples.decided)
  @ApiResponse(approvalsApiExamples.notFound)
  @ApiResponse(approvalsApiExamples.alreadyDecided)
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
      }),
    );
  }
}
