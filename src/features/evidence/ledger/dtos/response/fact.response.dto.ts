import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  EXTRACTION_METHODS,
  FACT_MEASURE_STATUSES,
  type ExtractionMethod,
  type FactKey,
  type FactMeasureStatus,
  type FactValue,
} from '../../../../../database/schemas/evidence/extracted-fact/extracted-fact.schema';
import type { LedgerCitationShape } from './ledger-resolution.response.dto';

/** One extracted fact behind a ledger cell. Unlike the cell and resolution views, this drill-down
 *  returns facts at any `measureStatus`, labelled by it — an operator inspecting a cell needs to
 *  see the proposed-measure rows that are deliberately excluded from the answer. */
export class FactResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Fact identifier.' })
  id: string;

  @Expose()
  @ApiProperty({ type: Object, description: 'Entity, metric and period this fact is keyed by.' })
  factKey: FactKey;

  @Expose()
  @ApiProperty({ type: Object, description: 'The extracted amount and its unit.' })
  value: FactValue;

  @Expose()
  @ApiProperty({
    required: false,
    description:
      "The value in the measure's canonical unit. Absent when the fact's unit does not convert.",
  })
  canonicalAmount?: number;

  @Expose()
  @ApiProperty({ description: 'The source text this fact was read from.' })
  rawText: string;

  @Expose()
  @ApiProperty({ example: 0.92, description: 'Extractor confidence in this fact.' })
  confidence: number;

  @Expose()
  @ApiProperty({
    example: 'regex',
    enum: EXTRACTION_METHODS,
    description: 'How this fact was extracted.',
  })
  extractionMethod: ExtractionMethod;

  @Expose()
  @ApiProperty({ description: 'The measure row this fact was stamped under.' })
  measureId: string;

  @Expose()
  @ApiProperty({
    example: 1,
    description:
      'The measure version in force at extraction time — provenance, never re-derived from the measure as it stands now.',
  })
  measureVersion: number;

  @Expose()
  @ApiProperty({
    example: 'confirmed',
    enum: FACT_MEASURE_STATUSES,
    description:
      'Whether the measure behind this fact is confirmed. A proposed-measure fact is stored but excluded from conflict detection and ledger answers.',
  })
  measureStatus: FactMeasureStatus;

  @Expose()
  @ApiProperty({ required: false, description: 'Start of the period this fact covers.' })
  periodStart?: Date;

  @Expose()
  @ApiProperty({ required: false, description: 'End of the period this fact covers.' })
  periodEnd?: Date;

  @Expose()
  @ApiProperty({ required: false, description: 'When the fact was observed, where stated.' })
  observedAt?: Date;

  @Expose()
  @ApiProperty({
    required: false,
    description: "Whether the fact's entity matched a registered canonical entity.",
  })
  entityMatched?: boolean;

  @Expose()
  @ApiProperty({
    type: Object,
    required: false,
    description:
      'Where this fact can be re-checked. Absent when the document version behind it could not be resolved.',
  })
  citation?: LedgerCitationShape;

  @Expose()
  @ApiProperty({
    required: false,
    description: 'Whether the document version behind this fact has been withdrawn.',
  })
  withdrawn?: boolean;

  @Expose()
  @ApiProperty({
    required: false,
    description: 'Whether a newer version of the same document has superseded this one.',
  })
  superseded?: boolean;

  @Expose()
  @ApiProperty({ description: 'When the fact was extracted.' })
  createdAt: Date;
}
