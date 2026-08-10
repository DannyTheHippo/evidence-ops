import { Controller, Get, HttpCode, HttpStatus, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { PublicRoute } from '../../../shared/decorators/public-route.decorator';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { getHealthApiExamples } from './api-examples/health.api-examples';
import { HealthResponseDto } from './dtos/response/health.response.dto';
import { HealthService } from './health.service';

@Controller('health')
@ApiBearerAuth()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Version('1')
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiResponse(getHealthApiExamples.success)
  async getHealth(): Promise<HealthResponseDto> {
    return toResponseDto(HealthResponseDto, await this.healthService.getHealth());
  }
}
