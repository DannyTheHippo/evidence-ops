import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { WithCountResponseDto } from '../../../../../shared/dtos/response/with-count.response.dto';
import { LedgerEntityResponseDto } from './ledger-entity.response.dto';

/** Nameable `{ docs, count }` envelope for the ledger's entity roster. */
export class LedgerEntityListResponseDto extends WithCountResponseDto<LedgerEntityResponseDto> {
  @Expose()
  @Type(() => LedgerEntityResponseDto)
  @ApiProperty({
    type: [LedgerEntityResponseDto],
    description: 'Entities the ledger holds confirmed facts for.',
  })
  declare docs: LedgerEntityResponseDto[];
}
