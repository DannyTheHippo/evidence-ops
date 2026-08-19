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
import { RolesGuard } from '../../common/auth/guards/roles.guard';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { RequireRole } from '../../../shared/decorators/require-role.decorator';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { canonicalEntitiesApiExamples } from './api-examples/canonical-entities.api-examples';
import { CanonicalEntityService } from './canonical-entity.service';
import { CreateCanonicalEntityRequestDto } from './dtos/request/create-canonical-entity.request.dto';
import { UpdateCanonicalEntityRequestDto } from './dtos/request/update-canonical-entity.request.dto';
import { CanonicalEntityResponseDto } from './dtos/response/canonical-entity.response.dto';

@Controller('canonical-entities')
@ApiTags('canonical-entities')
export class CanonicalEntitiesController {
  constructor(private readonly canonicalEntityService: CanonicalEntityService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(canonicalEntitiesApiExamples.list)
  async list(
    @Query() pagination: PaginationRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<CanonicalEntityResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.canonicalEntityService.listForTenant(
      user.tenantId,
      pagination,
    );

    return { docs: docs.map((doc) => toResponseDto(CanonicalEntityResponseDto, doc)), count };
  }

  // Admin-only: an authored row changes how every conflict grouped under its name resolves
  // tenant-wide, the same register as authoring a metric policy (`metric-policies.controller.ts`).
  @Post()
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(canonicalEntitiesApiExamples.created)
  @ApiResponse(canonicalEntitiesApiExamples.nameConflict)
  @ApiResponse(canonicalEntitiesApiExamples.forbidden)
  async create(
    @Body() dto: CreateCanonicalEntityRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<CanonicalEntityResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      CanonicalEntityResponseDto,
      await this.canonicalEntityService.create(user.tenantId, {
        canonicalName: dto.canonicalName,
        aliases: dto.aliases,
      }),
    );
  }

  // Admin-only, same reasoning as `create`.
  @Patch(':id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(canonicalEntitiesApiExamples.updated)
  @ApiResponse(canonicalEntitiesApiExamples.notFound)
  @ApiResponse(canonicalEntitiesApiExamples.nameConflict)
  @ApiResponse(canonicalEntitiesApiExamples.forbidden)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCanonicalEntityRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<CanonicalEntityResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      CanonicalEntityResponseDto,
      await this.canonicalEntityService.update(id, user.tenantId, {
        canonicalName: dto.canonicalName,
        aliases: dto.aliases,
      }),
    );
  }

  // Admin-only, same reasoning as `create`.
  @Delete(':id')
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(canonicalEntitiesApiExamples.removed)
  @ApiResponse(canonicalEntitiesApiExamples.notFound)
  @ApiResponse(canonicalEntitiesApiExamples.forbidden)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    await this.canonicalEntityService.remove(id, user.tenantId);
  }
}
