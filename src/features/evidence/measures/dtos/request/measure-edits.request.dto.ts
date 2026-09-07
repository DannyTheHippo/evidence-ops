import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';
import {
  MAX_HEADER_TEXT_CHARS,
  MAX_MEASURE_SLUG_CHARS,
} from '../../../../../database/schemas/evidence/measure/measure.schema';
import {
  FACT_VALUE_TYPES,
  TOLERANCE_KINDS,
  type FactValueType,
  type ToleranceKind,
} from '../../../facts/metric-ontology';
import { MeasureUnitRequestDto } from './measure-unit.request.dto';

// `'unclassified'` is excluded here too, matching `validateMeasureDefinition`'s own
// `AUTHORITY_SOURCE_CLASSES` filter — an unclassified document has no claim to authority over any
// other source.
const AUTHORITY_SOURCE_CLASSES = DOCUMENT_SOURCE_CLASSES.filter(
  (sourceClass) => sourceClass !== 'unclassified',
);

/** Every field optional and independently settable — confirm/update apply only the fields the
 *  caller sends, leaving the rest of the definition as-is (`MeasuresService.applyEdits`). */
export class MeasureEditsRequestDto {
  @ApiProperty({
    example: 'Tenant Occupancy Share',
    description: 'Human-readable label.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_HEADER_TEXT_CHARS)
  label?: string;

  @ApiProperty({
    example: ['Occupancy %'],
    description: 'Replaces the full alias list. Omit to leave the current aliases untouched.',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(MAX_HEADER_TEXT_CHARS, { each: true })
  aliases?: string[];

  @ApiProperty({
    example: 'percentage',
    enum: FACT_VALUE_TYPES,
    description: 'The kind of value this measure holds.',
    required: false,
  })
  @IsOptional()
  @IsIn(FACT_VALUE_TYPES)
  valueType?: FactValueType;

  @ApiProperty({
    example: 'ratio',
    description: 'The unit every value converts to. Must name one of units below.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_MEASURE_SLUG_CHARS)
  canonicalUnit?: string;

  @ApiProperty({
    type: [MeasureUnitRequestDto],
    description:
      'Replaces the full unit list. Exactly one unit must have toCanonicalFactor 1 and its id ' +
      'must equal canonicalUnit.',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MeasureUnitRequestDto)
  units?: MeasureUnitRequestDto[];

  @ApiProperty({
    example: 'absolute',
    enum: TOLERANCE_KINDS,
    description: 'How tolerance is applied when comparing values.',
    required: false,
  })
  @IsOptional()
  @IsIn(TOLERANCE_KINDS)
  toleranceKind?: ToleranceKind;

  @ApiProperty({
    example: 0.02,
    description: 'Disagreement threshold before two values conflict.',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tolerance?: number;

  @ApiProperty({
    type: [String],
    enum: AUTHORITY_SOURCE_CLASSES,
    example: ['pm-export', 'spreadsheet'],
    description: 'Source classes ranked by authority, most authoritative first.',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(AUTHORITY_SOURCE_CLASSES, { each: true })
  authorityOrder?: DocumentSourceClass[];

  @ApiProperty({
    example: 7_776_000_000,
    description: 'How long an observed value stays current for this measure, in milliseconds.',
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  stalenessWindowMs?: number;
}
