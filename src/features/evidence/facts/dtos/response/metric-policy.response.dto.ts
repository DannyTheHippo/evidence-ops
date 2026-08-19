import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';
import { METRIC_IDS, type MetricId } from '../../metric-ontology';

export class MetricPolicyResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Metric policy identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: 'net_operating_income',
    enum: METRIC_IDS,
    description: 'The metric this row overrides the ontology default for.',
  })
  metric: MetricId;

  @Expose()
  @ApiProperty({
    example: ['pm-export', 'spreadsheet'],
    enum: DOCUMENT_SOURCE_CLASSES,
    isArray: true,
    description:
      'Most-authoritative-first ranking of source classes for this metric. Absent means this row ' +
      'has no opinion on authority ranking.',
    required: false,
  })
  authorityOrder?: DocumentSourceClass[];

  @Expose()
  @ApiProperty({
    example: 365 * 24 * 60 * 60 * 1000,
    description:
      'How long an observed value stays current for this metric, in milliseconds. Absent means ' +
      'this row applies no staleness check.',
    required: false,
  })
  stalenessWindowMs?: number;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this row was first authored.',
  })
  createdAt: Date;
}
