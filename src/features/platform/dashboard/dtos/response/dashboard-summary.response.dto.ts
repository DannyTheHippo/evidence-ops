import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class DashboardSummaryResponseDto {
  @Expose()
  @ApiProperty({ example: 2, description: 'Approvals still awaiting a human decision.' })
  pendingApprovalCount: number;

  @Expose()
  @ApiProperty({ example: 1, description: 'Conflicts still open for this tenant.' })
  openConflictCount: number;

  @Expose()
  @ApiProperty({ example: 128, description: "The tenant's total document count." })
  documentCount: number;

  @Expose()
  @ApiProperty({ example: 4, description: "The tenant's total source count." })
  sourceCount: number;

  @Expose()
  @ApiProperty({
    example: 2,
    description: 'Documents whose current version failed ingestion.',
  })
  ingestionFailedCount: number;

  @Expose()
  @ApiProperty({ example: 1, description: 'Sources whose most recent sync attempt failed.' })
  syncFailedCount: number;

  @Expose()
  @ApiProperty({
    example: 3,
    description:
      'Documents whose current version needs OCR — a scanned PDF with no embedded text layer.',
  })
  needsOcrCount: number;

  @Expose()
  @ApiProperty({
    example: 1,
    description:
      'Documents whose current version ingested successfully but carries no extracted facts.',
  })
  factsFailedCount: number;

  @Expose()
  @ApiProperty({ example: 12, description: "The tenant's total answer count." })
  answerCount: number;

  @Expose()
  @ApiProperty({
    example: true,
    description:
      'Whether any document in the tenant has a completed current version, resolved across the whole corpus rather than a single page.',
  })
  hasIngestedDocument: boolean;
}
