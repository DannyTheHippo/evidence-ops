import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import type { DocumentSourceClass } from '../../../../../database/schemas/evidence/document/document.schema';
import type { EvidenceLocator } from '../../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import {
  MEASURE_ORIGINS,
  MEASURE_STATUSES,
  type MeasureOrigin,
  type MeasureStatus,
} from '../../../../../database/schemas/evidence/measure/measure.schema';
import {
  FACT_VALUE_TYPES,
  TOLERANCE_KINDS,
  type FactValueType,
  type ToleranceKind,
} from '../../../facts/metric-ontology';

/** A measure's convertible unit — a value object, not an entity, matching `Measure.units`'s own
 *  `_id: false` schema. */
export interface MeasureUnitShape {
  id: string;
  toCanonicalFactor: number;
}

/** One document's header evidence for a `'header'`-origin proposal (`Measure.proposedFrom`'s own
 *  `_id: false` value object). */
export interface MeasureProposedFromShape {
  documentVersionId: string;
  locator: EvidenceLocator;
  headerText: string;
}

/** The outcome of the synchronous rescan a confirm or edit triggers (`Measure.lastRescan`). */
export interface MeasureRescanShape {
  at: string;
  status: 'completed' | 'failed';
  durationMs: number;
  conflictsCreated?: number;
  skippedFactCount?: number;
  error?: string;
}

export class MeasureResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Measure identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: 'cap_rate',
    description: 'Slug the ExtractedFact.factKey.metric join key carries.',
  })
  slug: string;

  @Expose()
  @ApiProperty({ example: 'Cap Rate', description: 'Human-readable label.' })
  label: string;

  @Expose()
  @ApiProperty({
    example: ['Cap Rate', 'capitalization rate'],
    description: 'Header/phrase forms matched case-insensitively.',
  })
  aliases: string[];

  @Expose()
  @ApiProperty({
    example: 'percentage',
    enum: FACT_VALUE_TYPES,
    description: 'The kind of value this measure holds.',
  })
  valueType: FactValueType;

  @Expose()
  @ApiProperty({ example: 'ratio', description: 'The unit every value converts to.' })
  canonicalUnit: string;

  @Expose()
  @ApiProperty({
    example: [
      { id: 'ratio', toCanonicalFactor: 1 },
      { id: 'percent', toCanonicalFactor: 0.01 },
    ],
    description:
      'Convertible units. Exactly one carries toCanonicalFactor 1, matching canonicalUnit.',
  })
  units: MeasureUnitShape[];

  @Expose()
  @ApiProperty({
    example: 'absolute',
    enum: TOLERANCE_KINDS,
    description: 'How tolerance is applied when comparing values.',
  })
  toleranceKind: ToleranceKind;

  @Expose()
  @ApiProperty({
    example: 0.0025,
    description: 'Disagreement threshold before two values conflict.',
  })
  tolerance: number;

  @Expose()
  @ApiProperty({
    type: [String],
    example: ['pm-export', 'spreadsheet'],
    description: 'Source classes ranked by authority, most authoritative first.',
    required: false,
  })
  authorityOrder?: DocumentSourceClass[];

  @Expose()
  @ApiProperty({
    example: 15_552_000_000,
    description: 'How long an observed value stays current for this measure, in milliseconds.',
    required: false,
  })
  stalenessWindowMs?: number;

  @Expose()
  @ApiProperty({
    example: 'confirmed',
    enum: MEASURE_STATUSES,
    description: 'Measure lifecycle status.',
  })
  status: MeasureStatus;

  @Expose()
  @ApiProperty({
    example: 'seed',
    enum: MEASURE_ORIGINS,
    description: 'How this measure came to exist.',
  })
  origin: MeasureOrigin;

  @Expose()
  @ApiProperty({
    example: [],
    description:
      "Header evidence recorded while this measure was 'proposed' — empty for a seed or " +
      'manually authored row.',
  })
  proposedFrom: MeasureProposedFromShape[];

  @Expose()
  @ApiProperty({
    example: 1,
    description:
      'Bumped on every confirm/update. Seed rows are the only rows that ever read 1 while confirmed.',
  })
  version: number;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7c1',
    description: 'User id who confirmed this measure.',
    required: false,
  })
  confirmedBy?: string;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this measure was confirmed.',
    required: false,
  })
  confirmedAt?: Date;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7c1',
    description: 'User id who rejected this measure.',
    required: false,
  })
  rejectedBy?: string;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this measure was rejected.',
    required: false,
  })
  rejectedAt?: Date;

  @Expose()
  @ApiProperty({
    example: 'duplicate',
    description: 'Why this measure was rejected.',
    required: false,
  })
  rejectedReason?: string;

  @Expose()
  @ApiProperty({
    example: {
      at: '2026-07-01T00:00:00.000Z',
      status: 'completed',
      durationMs: 42,
      conflictsCreated: 0,
    },
    description:
      'Outcome of the synchronous conflict rescan the last confirm/update triggered. Absent until ' +
      'this measure has been confirmed or edited at least once.',
    required: false,
  })
  lastRescan?: MeasureRescanShape;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this row was first created.',
  })
  createdAt: Date;
}
