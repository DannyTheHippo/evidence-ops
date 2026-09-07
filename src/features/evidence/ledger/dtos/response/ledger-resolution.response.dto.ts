import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { EvidenceLocator } from '../../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { LedgerCellResponseDto } from './ledger-cell.response.dto';

/** One citation a recipient can re-check against bytes without trusting this server: `sha256`
 *  pins the exact document version `quote` was read from, and `locator` says where inside it.
 *  A fact whose document version cannot be resolved produces no citation at all rather than one
 *  carrying a blank hash. */
export interface LedgerCitationShape {
  factId: string;
  documentId: string;
  documentVersionId: string;
  sha256: string;
  locator: EvidenceLocator;
  extractorVersion: string;
  quote: string;
  withdrawn: boolean;
}

/** A single cell resolved in full: the cell's own state plus the evidence behind it. The list
 *  view deliberately omits citations; this route is where they are paid for. */
export class LedgerResolutionResponseDto extends LedgerCellResponseDto {
  @Expose()
  @ApiProperty({
    type: [Object],
    description: 'Citations for the facts this resolution rests on, one per fact.',
  })
  citations: LedgerCitationShape[];
}
