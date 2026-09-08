import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { attestationsApiExamples } from './api-examples/attestations.api-examples';
import { AttestationService } from './attestation.service';
import { AttestationBundleResponseDto } from './dtos/response/attestation-bundle.response.dto';

@Controller()
@ApiTags('attestations')
@ApiBearerAuth()
export class AttestationsController {
  constructor(private readonly attestationService: AttestationService) {}

  @Get('answers/:id/attestation')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(attestationsApiExamples.bundle)
  @ApiResponse(attestationsApiExamples.notFound)
  @ApiResponse(attestationsApiExamples.notComplete)
  async getAnswerAttestation(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<AttestationBundleResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      AttestationBundleResponseDto,
      await this.attestationService.exportForAnswer(id, user.tenantId),
    );
  }

  @Get('verifications/:id/attestation')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(attestationsApiExamples.bundle)
  @ApiResponse(attestationsApiExamples.notFound)
  async getVerificationAttestation(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<AttestationBundleResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      AttestationBundleResponseDto,
      await this.attestationService.exportForVerification(id, user.tenantId),
    );
  }
}
