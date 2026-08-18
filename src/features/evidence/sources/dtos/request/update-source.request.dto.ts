import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';
import {
  SOURCE_CONNECTIVITIES,
  SOURCE_REACHABILITIES,
  type SourceConnectivity,
  type SourceReachability,
} from '../../../../../database/schemas/evidence/source/source.schema';

/**
 * Every field is optional and independently settable — `SourcesService.update` only touches the
 * ones present here. `name`/`kind`/`path` are not included: repointing or renaming a source is a
 * `create` decision, not an edit.
 */
export class UpdateSourceRequestDto {
  @ApiProperty({
    example: false,
    description: 'Whether the sync loop is allowed to run for this source.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({
    example: 'export-only',
    enum: SOURCE_CONNECTIVITIES,
    description: "How this source's bytes get into the corpus.",
    required: false,
  })
  @IsOptional()
  @IsIn(SOURCE_CONNECTIVITIES)
  connectivity?: SourceConnectivity;

  @ApiProperty({
    example: 'possible',
    enum: SOURCE_REACHABILITIES,
    description:
      "Whether the estate's own access posture lets this system reach this source at all.",
    required: false,
  })
  @IsOptional()
  @IsIn(SOURCE_REACHABILITIES)
  reachability?: SourceReachability;

  @ApiProperty({
    example: 'Jane Doe, IT',
    description: 'Person or team accountable for this source.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  owner?: string;

  @ApiProperty({
    example: false,
    description:
      "Whether the sync loop may ever run for this source. 'false' marks an inventory-only row " +
      'catalogued for the estate map but never synced.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  tracked?: boolean;

  @ApiProperty({
    example: 'crm-export',
    enum: DOCUMENT_SOURCE_CLASSES,
    description:
      "Default document classification a document created from this source's sync pass " +
      'inherits. Correcting this does not rewrite documents already ingested under the old class.',
    required: false,
  })
  @IsOptional()
  @IsIn(DOCUMENT_SOURCE_CLASSES)
  sourceClass?: DocumentSourceClass;
}
