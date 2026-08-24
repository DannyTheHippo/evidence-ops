import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { DOCUMENT_SOURCE_CLASSES } from '../../../../../database/schemas/evidence/document/document.schema';
import {
  FACT_VALUE_TYPES,
  METRIC_PACK_STATUSES,
  TOLERANCE_KINDS,
} from '../../../../../database/schemas/evidence/metric-pack/metric-pack.schema';

export class MetricUnitDefinitionResponseDto {
  @Expose()
  @ApiProperty({ example: 'usd', description: "This unit's id." })
  id: string;

  @Expose()
  @ApiProperty({
    example: 1,
    description: "Multiplicative conversion to the metric's canonicalUnit.",
  })
  toCanonicalFactor: number;
}

export class MetricDefinitionResponseDto {
  @Expose()
  @ApiProperty({ example: 'cap_rate', description: "This metric's id, unique within the pack." })
  id: string;

  @Expose()
  @ApiProperty({ example: 'Cap Rate', description: 'Display label for this metric.' })
  label: string;

  @Expose()
  @ApiProperty({
    example: ['Cap Rate', 'cap rate', 'capitalization rate'],
    isArray: true,
    description: 'Exact header/phrase forms a document might use, matched case-insensitively.',
  })
  aliases: string[];

  @Expose()
  @ApiProperty({ example: 'percentage', enum: FACT_VALUE_TYPES })
  valueType: string;

  @Expose()
  @ApiProperty({ example: 'ratio', description: 'The unit every other unit converts to.' })
  canonicalUnit: string;

  @Expose()
  @Type(() => MetricUnitDefinitionResponseDto)
  @ApiProperty({ type: () => [MetricUnitDefinitionResponseDto] })
  units: MetricUnitDefinitionResponseDto[];

  @Expose()
  @ApiProperty({ example: 'absolute', enum: TOLERANCE_KINDS })
  toleranceKind: string;

  @Expose()
  @ApiProperty({
    example: 0.0025,
    description: 'How large a normalized gap counts as a disagreement.',
  })
  tolerance: number;

  @Expose()
  @ApiProperty({
    example: ['pm-export', 'spreadsheet'],
    enum: DOCUMENT_SOURCE_CLASSES,
    isArray: true,
    description: 'Most-authoritative-first ranking of source classes. Absent means no opinion.',
    required: false,
  })
  authorityOrder?: string[];

  @Expose()
  @ApiProperty({
    example: 180 * 24 * 60 * 60 * 1000,
    description:
      'How long an observed value stays current, in milliseconds. Absent means no check.',
    required: false,
  })
  stalenessWindowMs?: number;
}

export class MetricPackResponseDto {
  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description: 'Metric pack version identifier.',
  })
  id: string;

  @Expose()
  @ApiProperty({ example: 'cre-fork', description: 'The pack lineage this version belongs to.' })
  packId: string;

  @Expose()
  @ApiProperty({ example: 2, description: 'This version number, unique within packId.' })
  version: number;

  @Expose()
  @ApiProperty({ example: 'draft', enum: METRIC_PACK_STATUSES })
  status: string;

  @Expose()
  @ApiProperty({ example: 'CRE Fork', description: 'Display label for this pack version.' })
  label: string;

  @Expose()
  @Type(() => MetricDefinitionResponseDto)
  @ApiProperty({ type: () => [MetricDefinitionResponseDto] })
  metrics: MetricDefinitionResponseDto[];

  @Expose()
  @ApiProperty({
    example: 'cre',
    description: 'The packId this version was drafted from.',
    required: false,
  })
  parentPackId?: string;

  @Expose()
  @ApiProperty({
    example: 1,
    description: 'The version, within parentPackId, this version was drafted from.',
    required: false,
  })
  parentVersion?: number;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this version was created.',
  })
  createdAt: Date;
}
