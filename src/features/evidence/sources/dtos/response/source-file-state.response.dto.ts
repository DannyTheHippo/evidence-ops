import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export const SOURCE_FILE_STATE_STATUSES = ['ok', 'failed'] as const;

export type SourceFileStateStatus = (typeof SOURCE_FILE_STATE_STATUSES)[number];

/**
 * Diagnostic view of one entry in `Source.fileStates` — the fields an operator needs to tell
 * which file failed to sync and why. `status` is derived from whether `lastError` is set; the
 * schema itself has no separate status field per file. Internals with no diagnostic value
 * (`sha256`, `sizeBytes`, `documentId`) are deliberately not exposed here.
 */
export class SourceFileStateResponseDto {
  @Expose()
  @ApiProperty({
    example: 'contracts/lease-agreement.pdf',
    description: "The file's path relative to the source's root.",
  })
  path: string;

  @Expose()
  @ApiProperty({
    example: 'failed',
    enum: SOURCE_FILE_STATE_STATUSES,
    description: "'failed' when the most recent sync attempt for this file recorded an error.",
  })
  status: SourceFileStateStatus;

  @Expose()
  @ApiProperty({
    example: "Could not resolve a document type for 'contracts/lease-agreement.pdf'",
    description: 'Error detail from the most recent failed sync attempt for this file.',
    required: false,
  })
  lastError?: string;

  @Expose()
  @ApiProperty({
    example: 1753920000000,
    description: "The file's on-disk modification time, epoch milliseconds.",
  })
  mtimeMs: number;
}
