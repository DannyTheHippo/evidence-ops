import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';
import {
  SOURCE_CONNECTIVITIES,
  SOURCE_KINDS,
  SOURCE_REACHABILITIES,
  type SourceConnectivity,
  type SourceKind,
  type SourceReachability,
} from '../../../../../database/schemas/evidence/source/source.schema';

export class SourceResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Source identifier.' })
  id: string;

  @Expose()
  @ApiProperty({ example: 'Deal Room Inbox', description: 'Human-readable name for this source.' })
  name: string;

  @Expose()
  @ApiProperty({
    example: 'local-folder',
    enum: SOURCE_KINDS,
    description: 'Which connector syncs this source.',
  })
  kind: SourceKind;

  @Expose()
  @ApiProperty({
    example: 'deal-room',
    description:
      "The connector's location for this source — a folder path for 'local-folder'; the " +
      "submitting client's label for 'mcp-submit'.",
  })
  path: string;

  @Expose()
  @ApiProperty({
    example: true,
    description: 'Whether the sync loop is allowed to run for this source.',
  })
  enabled: boolean;

  @Expose()
  @ApiProperty({
    example: 60000,
    description:
      'Per-source override of the global sync interval, in milliseconds. Absent means the ' +
      'configured default applies.',
    required: false,
  })
  intervalMs?: number;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When the most recent sync attempt finished.',
    required: false,
  })
  lastSyncAt?: Date;

  @Expose()
  @ApiProperty({
    example: 'ok',
    description: "Outcome of the most recent sync attempt — 'ok' or 'failed'.",
    required: false,
  })
  lastSyncStatus?: string;

  @Expose()
  @ApiProperty({
    example: 'ENOENT: no such file or directory',
    description: 'Error detail, present only when lastSyncStatus is failed.',
    required: false,
  })
  lastSyncError?: string;

  @Expose()
  @ApiProperty({ example: 42, description: 'Number of files this source has synced state for.' })
  fileCount: number;

  @Expose()
  @ApiProperty({
    example: 'connector',
    enum: SOURCE_CONNECTIVITIES,
    description: "How this source's bytes get into the corpus.",
  })
  connectivity: SourceConnectivity;

  @Expose()
  @ApiProperty({
    example: 'live',
    enum: SOURCE_REACHABILITIES,
    description:
      "Whether the estate's own access posture lets this system reach this source at all.",
  })
  reachability: SourceReachability;

  @Expose()
  @ApiProperty({
    example: 'Jane Doe, IT',
    description: 'Person or team accountable for this source. Absent means nobody has said yet.',
    required: false,
  })
  owner?: string;

  @Expose()
  @ApiProperty({
    example: true,
    description:
      "Whether the sync loop may ever run for this source. 'false' marks an inventory-only row.",
  })
  tracked: boolean;

  @Expose()
  @ApiProperty({
    example: 'unclassified',
    enum: DOCUMENT_SOURCE_CLASSES,
    description:
      "Default document classification a document created from this source's sync pass inherits.",
  })
  sourceClass: DocumentSourceClass;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Source creation timestamp.' })
  createdAt: Date;
}
