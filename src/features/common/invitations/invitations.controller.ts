import {
  Body,
  Controller,
  Delete,
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
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RequireRole } from '../../../shared/decorators/require-role.decorator';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { invitationsApiExamples } from './api-examples/invitations.api-examples';
import { CreateInvitationRequestDto } from './dtos/request/create-invitation.request.dto';
import { InvitationResponseDto } from './dtos/response/invitation.response.dto';
import { MintedInvitationResponseDto } from './dtos/response/minted-invitation.response.dto';
import { InvitationsService } from './invitations.service';

@Controller('invitations')
@ApiTags('invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post()
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  // Route-scoped, matching AuditEventsController's list handler: bringing a colleague into the
  // tenant is an administrative capability, not something every authenticated user gets.
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(invitationsApiExamples.minted)
  @ApiResponse(invitationsApiExamples.alreadyRegistered)
  @ApiResponse(invitationsApiExamples.forbidden)
  async mint(
    @Body() dto: CreateInvitationRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MintedInvitationResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      MintedInvitationResponseDto,
      await this.invitationsService.mint({
        email: dto.email,
        role: dto.role,
        actorId: user.userId,
        tenantId: user.tenantId,
      }),
    );
  }

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(invitationsApiExamples.list)
  @ApiResponse(invitationsApiExamples.forbidden)
  async list(
    @Query() pagination: PaginationRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<InvitationResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.invitationsService.list(
      pagination,
      user.userId,
      user.tenantId,
    );

    return { docs: docs.map((doc) => toResponseDto(InvitationResponseDto, doc)), count };
  }

  @Delete(':id')
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(invitationsApiExamples.revoked)
  @ApiResponse(invitationsApiExamples.notFound)
  @ApiResponse(invitationsApiExamples.forbidden)
  async revoke(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    await this.invitationsService.revoke(id, user.userId, user.tenantId);
  }

  @Post(':id/resend')
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(invitationsApiExamples.minted)
  @ApiResponse(invitationsApiExamples.notFound)
  @ApiResponse(invitationsApiExamples.forbidden)
  async resend(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<MintedInvitationResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      MintedInvitationResponseDto,
      await this.invitationsService.resend(id, user.userId, user.tenantId),
    );
  }
}
