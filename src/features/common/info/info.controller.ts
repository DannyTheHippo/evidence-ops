import { Controller, Get, HttpCode, HttpStatus, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { PublicRoute } from '../../../shared/decorators/public-route.decorator';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { getInfoApiExamples } from './api-examples/info.api-examples';
import { InfoResponseDto } from './dtos/response/info.response.dto';
import { InfoService } from './info.service';

@Controller('info')
@ApiBearerAuth()
export class InfoController {
  constructor(private readonly infoService: InfoService) {}

  @Get()
  @Version('1')
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiResponse(getInfoApiExamples.success)
  getVersion(): InfoResponseDto {
    return toResponseDto(InfoResponseDto, this.infoService.getVersion());
  }
}
