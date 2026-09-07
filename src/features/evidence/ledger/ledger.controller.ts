import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UnauthorizedException,
  Version,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { ledgerApiExamples } from './api-examples/ledger.api-examples';
import { ListLedgerCellsRequestDto } from './dtos/request/list-ledger-cells.request.dto';
import { ListLedgerEntitiesRequestDto } from './dtos/request/list-ledger-entities.request.dto';
import { ListLedgerFactsRequestDto } from './dtos/request/list-ledger-facts.request.dto';
import { ResolveLedgerRequestDto } from './dtos/request/resolve-ledger.request.dto';
import { FactResponseDto } from './dtos/response/fact.response.dto';
import { LedgerCellResponseDto } from './dtos/response/ledger-cell.response.dto';
import { LedgerEntityResponseDto } from './dtos/response/ledger-entity.response.dto';
import { LedgerResolutionResponseDto } from './dtos/response/ledger-resolution.response.dto';
import { LedgerService } from './ledger.service';

/**
 * Read-only view of what the estate's documents say, per entity × measure × period. Every route
 * is member-readable: the ledger is the record, and authoring happens elsewhere — through the
 * measures registry, and through the adjudication of conflicts. Nothing here mutates.
 *
 * `LedgerService` returns plain objects it builds field by field, not Mongoose documents, so
 * `toResponseDto` serializes them directly with no `_id` to map.
 */
@Controller('ledger')
@ApiTags('ledger')
@ApiBearerAuth()
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(ledgerApiExamples.cells)
  async listCells(
    @Query() query: ListLedgerCellsRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<LedgerCellResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.ledgerService.listCells(user.tenantId, query);

    return { docs: docs.map((doc) => toResponseDto(LedgerCellResponseDto, doc)), count };
  }

  // Declared before the `:id`-free sibling routes have any chance to shadow it: `resolve` and
  // `facts` are literal segments, and Nest matches in declaration order.
  @Get('resolve')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(ledgerApiExamples.resolution)
  @ApiResponse(ledgerApiExamples.measureNotFound)
  async resolve(
    @Query() query: ResolveLedgerRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<LedgerResolutionResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      LedgerResolutionResponseDto,
      await this.ledgerService.resolveValue({
        tenantId: user.tenantId,
        entity: query.entity,
        measure: query.measure,
        period: query.period,
      }),
    );
  }

  @Get('facts')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(ledgerApiExamples.facts)
  @ApiResponse(ledgerApiExamples.measureNotFound)
  async listFacts(
    @Query() query: ListLedgerFactsRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<FactResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.ledgerService.listFacts(user.tenantId, query);

    return { docs: docs.map((doc) => toResponseDto(FactResponseDto, doc)), count };
  }

  @Get('entities')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(ledgerApiExamples.entities)
  async listEntities(
    @Query() query: ListLedgerEntitiesRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<LedgerEntityResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.ledgerService.listEntities(user.tenantId, query);

    return { docs: docs.map((doc) => toResponseDto(LedgerEntityResponseDto, doc)), count };
  }
}
