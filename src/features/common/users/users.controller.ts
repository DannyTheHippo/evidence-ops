import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { usersApiExamples } from './api-examples/users.api-examples';
import { ChangeRoleRequestDto } from './dtos/request/change-role.request.dto';
import { ListUsersRequestDto } from './dtos/request/list-users.request.dto';
import { UserResponseDto } from './dtos/response/user.response.dto';
import { UsersService } from './users.service';

@Controller('users')
@ApiTags('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(usersApiExamples.list)
  @ApiResponse(usersApiExamples.forbidden)
  async list(
    @Query() query: ListUsersRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<UserResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.usersService.list(query, user.userId, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(UserResponseDto, doc)), count };
  }

  @Patch(':id/role')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(usersApiExamples.roleChanged)
  @ApiResponse(usersApiExamples.notFound)
  @ApiResponse(usersApiExamples.lastAdmin)
  @ApiResponse(usersApiExamples.forbidden)
  async changeRole(
    @Param('id') id: string,
    @Body() dto: ChangeRoleRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<UserResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      UserResponseDto,
      await this.usersService.changeRole(id, dto.role, user.userId, user.tenantId),
    );
  }

  @Delete(':id')
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(usersApiExamples.removed)
  @ApiResponse(usersApiExamples.notFound)
  @ApiResponse(usersApiExamples.lastAdmin)
  @ApiResponse(usersApiExamples.forbidden)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    await this.usersService.remove(id, user.userId, user.tenantId);
  }

  @Post(':id/revoke-sessions')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(usersApiExamples.sessionsRevoked)
  @ApiResponse(usersApiExamples.notFound)
  @ApiResponse(usersApiExamples.forbidden)
  async revokeSessions(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<UserResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      UserResponseDto,
      await this.usersService.revokeSessions(id, user.userId, user.tenantId),
    );
  }
}
