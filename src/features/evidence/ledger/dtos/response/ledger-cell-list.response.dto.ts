import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { LedgerCellResponseDto } from './ledger-cell.response.dto';

/** Nameable `{ docs, count }` envelope for the ledger's cell view. */
export class LedgerCellListResponseDto extends WithCountResponseDto<LedgerCellResponseDto> {
  @Expose()
  @Type(() => LedgerCellResponseDto)
  @ApiProperty({ type: [LedgerCellResponseDto], description: 'Resolved ledger cells.' })
  declare docs: LedgerCellResponseDto[];
}
