import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/**
 * Diagnostic view of a source's most recent sync attempt, derived from stored fields only —
 * `SourcesService.toResult` never queries the workflow engine to build this. `nextSweepAt` is an
 * approximation for the same reason: nothing clears `Source.syncWorkflowId` when a sync loop
 * exits, so a source whose loop has stopped can still project one.
 */
export class SourceLastSyncResponseDto {
  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When the most recent sync attempt started.',
    required: false,
  })
  startedAt?: Date;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:01:12.000Z',
    description: 'When the most recent sync attempt finished.',
    required: false,
  })
  finishedAt?: Date;

  @Expose()
  @ApiProperty({
    example: 'ok',
    enum: ['ok', 'failed'],
    description: "Outcome of the most recent sync attempt — 'ok' or 'failed'.",
    required: false,
  })
  status?: 'ok' | 'failed';

  @Expose()
  @ApiProperty({
    example: 'ENOENT: no such file or directory',
    description: 'Error detail, present only when status is failed.',
    required: false,
  })
  error?: string;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:06:12.000Z',
    description:
      'Estimated time of the next sweep, projected from the last finished attempt and the sync ' +
      'interval. Present only while the sync loop appears to still be running — an approximation, ' +
      'not a guarantee, since nothing clears this the moment a loop actually stops.',
    required: false,
  })
  nextSweepAt?: Date;
}
