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
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { RequireRole } from '../../../shared/decorators/require-role.decorator';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { canonicalEntitiesApiExamples } from './api-examples/canonical-entities.api-examples';
import { CanonicalEntityService } from './canonical-entity.service';
import { CreateCanonicalEntityRequestDto } from './dtos/request/create-canonical-entity.request.dto';
import { ListCanonicalEntitiesRequestDto } from './dtos/request/list-canonical-entities.request.dto';
import { RevokeHarvestedAliasRequestDto } from './dtos/request/revoke-harvested-alias.request.dto';
import { UpdateCanonicalEntityRequestDto } from './dtos/request/update-canonical-entity.request.dto';
import { CanonicalEntityResponseDto } from './dtos/response/canonical-entity.response.dto';
import { ScanNearMatchesResponseDto } from './dtos/response/scan-near-matches.response.dto';

@Controller('canonical-entities')
@ApiTags('canonical-entities')
export class CanonicalEntitiesController {
  constructor(private readonly canonicalEntityService: CanonicalEntityService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(canonicalEntitiesApiExamples.list)
  async list(
    @Query() pagination: ListCanonicalEntitiesRequestDto,
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

  // Admin-only: a proposal it records changes what a subsequent GET surfaces for review
  // tenant-wide, the same authorship bar `create` sets for an authored row.
  @Post('near-matches/scan')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(canonicalEntitiesApiExamples.nearMatchesScanned)
  @ApiResponse(canonicalEntitiesApiExamples.forbidden)
  async scanNearMatches(
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<ScanNearMatchesResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const proposed = await this.canonicalEntityService.scanNearMatches(user.tenantId);
    return toResponseDto(ScanNearMatchesResponseDto, { proposed });
  }

  // Admin-only: an authored row changes how every conflict grouped under its name resolves
  // tenant-wide.
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
      await this.canonicalEntityService.create(
        user.tenantId,
        {
          canonicalName: dto.canonicalName,
          aliases: dto.aliases,
        },
        user.userId,
      ),
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
      await this.canonicalEntityService.update(
        id,
        user.tenantId,
        {
          canonicalName: dto.canonicalName,
          aliases: dto.aliases,
        },
        user.userId,
      ),
    );
  }

  // Admin-only, same reasoning as `create` — applying a proposed alias changes how every fact
  // grouped under it resolves tenant-wide. The one-click confirmation for both a document-read
  // and an inferred proposal: both land as `proposed` and this is the only path to `applied`.
  @Post(':id/harvested-aliases/apply')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(canonicalEntitiesApiExamples.aliasApplied)
  @ApiResponse(canonicalEntitiesApiExamples.notFound)
  @ApiResponse(canonicalEntitiesApiExamples.aliasNotFound)
  @ApiResponse(canonicalEntitiesApiExamples.aliasNotProposed)
  @ApiResponse(canonicalEntitiesApiExamples.forbidden)
  async applyHarvestedAlias(
    @Param('id') id: string,
    @Body() dto: RevokeHarvestedAliasRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<CanonicalEntityResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      CanonicalEntityResponseDto,
      await this.canonicalEntityService.applyHarvestedAlias(
        id,
        user.tenantId,
        dto.alias,
        user.userId,
      ),
    );
  }

  // Admin-only, same reasoning as `create` — revoking a harvested alias changes how every fact
  // grouped under it resolves tenant-wide. A `POST` rather than a `DELETE`: the alias travels in
  // the body, and the row it hangs off survives.
  @Post(':id/harvested-aliases/revoke')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(canonicalEntitiesApiExamples.aliasRevoked)
  @ApiResponse(canonicalEntitiesApiExamples.notFound)
  @ApiResponse(canonicalEntitiesApiExamples.aliasNotFound)
  @ApiResponse(canonicalEntitiesApiExamples.forbidden)
  async revokeHarvestedAlias(
    @Param('id') id: string,
    @Body() dto: RevokeHarvestedAliasRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<CanonicalEntityResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      CanonicalEntityResponseDto,
      await this.canonicalEntityService.revokeHarvestedAlias(
        id,
        user.tenantId,
        dto.alias,
        user.userId,
      ),
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

    await this.canonicalEntityService.remove(id, user.tenantId, user.userId);
  }
}
