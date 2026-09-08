import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';
import {
  CONNECTOR_SOURCE_KINDS,
  SOURCE_CONNECTIVITIES,
  SOURCE_REACHABILITIES,
  type SourceConnectivity,
  type SourceKind,
  type SourceReachability,
} from '../../../../../database/schemas/evidence/source/source.schema';

export class CreateSourceRequestDto {
  @ApiProperty({ example: 'Deal Room Inbox', description: 'Human-readable name for this source.' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'local-folder',
    enum: CONNECTOR_SOURCE_KINDS,
    description: 'Which connector syncs this source.',
  })
  @IsIn(CONNECTOR_SOURCE_KINDS)
  kind: SourceKind;

  @ApiProperty({
    example: 'deal-room',
    description:
      "The connector's location for this source — a folder path for 'local-folder'; the " +
      "submitting client's label for 'mcp-submit'.",
  })
  @IsString()
  @IsNotEmpty()
  path: string;

  @ApiProperty({
    example: 60000,
    description:
      'Per-source override of the global sync interval, in milliseconds. Omit to use the ' +
      'configured default.',
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMs?: number;

  @ApiProperty({
    example: true,
    description: 'Whether the sync loop is allowed to run for this source. Defaults to true.',
    required: false,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({
    example: 'connector',
    enum: SOURCE_CONNECTIVITIES,
    description: "How this source's bytes get into the corpus. Defaults to 'connector'.",
    required: false,
    default: 'connector',
  })
  @IsOptional()
  @IsIn(SOURCE_CONNECTIVITIES)
  connectivity?: SourceConnectivity;

  @ApiProperty({
    example: 'live',
    enum: SOURCE_REACHABILITIES,
    description:
      "Whether the estate's own access posture lets this system reach this source at " +
      "all. Defaults to 'live'.",
    required: false,
    default: 'live',
  })
  @IsOptional()
  @IsIn(SOURCE_REACHABILITIES)
  reachability?: SourceReachability;

  @ApiProperty({
    example: 'Jane Doe, IT',
    description:
      'Person or team accountable for this source. Required — its absence is the gap an ' +
      "estate's inventory pass exists to surface, so it is never inferred or defaulted.",
  })
  @IsString()
  @IsNotEmpty()
  owner: string;

  @ApiProperty({
    example: true,
    description:
      "Whether the sync loop may ever run for this source. 'false' marks an inventory-only row " +
      'catalogued for the estate map but never synced. Defaults to true.',
    required: false,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  tracked?: boolean;

  @ApiProperty({
    example: 'unclassified',
    enum: DOCUMENT_SOURCE_CLASSES,
    description:
      "Default document classification a document created from this source's sync pass " +
      "inherits. Defaults to 'unclassified'.",
    required: false,
    default: 'unclassified',
  })
  @IsOptional()
  @IsIn(DOCUMENT_SOURCE_CLASSES)
  sourceClass?: DocumentSourceClass;
}
