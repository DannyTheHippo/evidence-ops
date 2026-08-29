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
import { dashboardApiExamples } from './api-examples/dashboard.api-examples';
import { DashboardService } from './dashboard.service';
import { DashboardSummaryResponseDto } from './dtos/response/dashboard-summary.response.dto';

@Controller('dashboard')
@ApiTags('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(dashboardApiExamples.summary)
  async summary(
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<DashboardSummaryResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      DashboardSummaryResponseDto,
      await this.dashboardService.getSummary(user.tenantId),
    );
  }
}
