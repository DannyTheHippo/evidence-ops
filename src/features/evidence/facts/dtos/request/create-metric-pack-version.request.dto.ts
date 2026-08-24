import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { DocumentSourceClass } from '../../../../../database/schemas/evidence/document/document.schema';
import {
  FACT_VALUE_TYPES,
  TOLERANCE_KINDS,
} from '../../../../../database/schemas/evidence/metric-pack/metric-pack.schema';
import type { FactValueType, ToleranceKind } from '../../metric-ontology';
import { METRIC_ID_PATTERN } from '../../tenant-metrics.service';
import { RANKABLE_SOURCE_CLASSES } from './upsert-metric-policy.request.dto';

export class MetricUnitDefinitionRequestDto {
  @ApiProperty({ example: 'usd', description: "This unit's id, unique within its metric." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id: string;

  @ApiProperty({
    example: 1,
    description:
      "Multiplicative conversion from this unit to the metric's canonicalUnit. Must be finite " +
      'and greater than zero — a zero, negative, infinite, or NaN factor could never legitimately ' +
      'convert an observed value.',
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  toCanonicalFactor: number;
}

/**
 * Exactly one unit in a metric's `units` must carry `toCanonicalFactor: 1`, and that unit's `id`
 * must equal the metric's own `canonicalUnit` — the canonical unit is defined by being its own
 * identity conversion, not by a separate claim that could disagree with it.
 */
@ValidatorConstraint({ name: 'hasCanonicalUnit', async: false })
class HasCanonicalUnitConstraint implements ValidatorConstraintInterface {
  validate(units: unknown, args: ValidationArguments): boolean {
    if (!Array.isArray(units)) {
      return false;
    }
    const metric = args.object as MetricDefinitionRequestDto;
    const identityUnits = (units as MetricUnitDefinitionRequestDto[]).filter(
      (unit) => unit?.toCanonicalFactor === 1,
    );
    return identityUnits.length === 1 && identityUnits[0].id === metric.canonicalUnit;
  }

  defaultMessage(args: ValidationArguments): string {
    const metric = args.object as MetricDefinitionRequestDto;
    return (
      `Metric '${metric.id}' must declare exactly one unit with toCanonicalFactor: 1, whose id ` +
      `equals canonicalUnit ('${metric.canonicalUnit}')`
    );
  }
}

/** `toleranceKind: 'relative'` compares a difference against a fraction of the larger magnitude —
 *  a tolerance at or above 1 would never flag a disagreement no matter how large. `'absolute'`
 *  carries no such ceiling (`lease_term_years` uses `0`, others use plain unit differences). */
@ValidatorConstraint({ name: 'toleranceBelowOneWhenRelative', async: false })
class ToleranceBelowOneWhenRelativeConstraint implements ValidatorConstraintInterface {
  validate(tolerance: unknown, args: ValidationArguments): boolean {
    const metric = args.object as MetricDefinitionRequestDto;
    if (metric.toleranceKind !== 'relative') {
      return true;
    }
    return typeof tolerance === 'number' && tolerance < 1;
  }

  defaultMessage(): string {
    return "tolerance must be less than 1 when toleranceKind is 'relative'";
  }
}

export class MetricDefinitionRequestDto {
  @ApiProperty({
    example: 'cap_rate',
    description: 'This metric’s id, unique within the pack. Lowercase snake_case.',
  })
  @IsString()
  @Matches(METRIC_ID_PATTERN)
  id: string;

  @ApiProperty({ example: 'Cap Rate', description: 'Display label for this metric.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;

  @ApiProperty({
    example: ['Cap Rate', 'cap rate', 'capitalization rate'],
    isArray: true,
    description: 'Exact header/phrase forms a document might use, matched case-insensitively.',
  })
  @IsArray()
  @IsString({ each: true })
  aliases: string[];

  @ApiProperty({ example: 'percentage', enum: FACT_VALUE_TYPES })
  @IsIn(FACT_VALUE_TYPES)
  valueType: FactValueType;

  @ApiProperty({
    example: 'ratio',
    description: "The unit every other unit in units converts to. Must match one unit's id.",
  })
  @IsString()
  @IsNotEmpty()
  canonicalUnit: string;

  @ApiProperty({ type: () => [MetricUnitDefinitionRequestDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MetricUnitDefinitionRequestDto)
  @ArrayUnique((unit: MetricUnitDefinitionRequestDto) => unit.id)
  @Validate(HasCanonicalUnitConstraint)
  units: MetricUnitDefinitionRequestDto[];

  @ApiProperty({ example: 'absolute', enum: TOLERANCE_KINDS })
  @IsIn(TOLERANCE_KINDS)
  toleranceKind: ToleranceKind;

  @ApiProperty({
    example: 0.0025,
    description:
      'How large a gap between two normalized values counts as a disagreement. Never negative; ' +
      "must be below 1 when toleranceKind is 'relative' (see that field's own description).",
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Validate(ToleranceBelowOneWhenRelativeConstraint)
  tolerance: number;

  @ApiProperty({
    example: ['pm-export', 'spreadsheet'],
    enum: RANKABLE_SOURCE_CLASSES,
    isArray: true,
    description:
      "Most-authoritative-first ranking of source classes for this metric. Rejects 'unclassified' " +
      'and a class repeated at two ranks, the same rule UpsertMetricPolicyRequestDto enforces for ' +
      'a tenant-authored policy row. Omit to leave this metric with no authority ranking.',
    required: false,
  })
  @IsOptional()
  @ArrayUnique()
  @IsIn(RANKABLE_SOURCE_CLASSES, { each: true })
  authorityOrder?: DocumentSourceClass[];

  @ApiProperty({
    example: 180 * 24 * 60 * 60 * 1000,
    description:
      'How long an observed value stays current for this metric, in milliseconds. Omit to leave ' +
      'this metric with no staleness check.',
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  stalenessWindowMs?: number;
}

export class CreateMetricPackVersionRequestDto {
  @ApiProperty({ example: 'CRE Fork', description: 'Display label for this pack version.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;

  @ApiProperty({
    type: () => [MetricDefinitionRequestDto],
    description: "This version's complete metric set — not a diff against the parent version.",
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MetricDefinitionRequestDto)
  @ArrayUnique((metric: MetricDefinitionRequestDto) => metric.id)
  metrics: MetricDefinitionRequestDto[];

  @ApiProperty({
    example: 1,
    description:
      'The version, within this same packId, to compare this draft against at publish time. ' +
      "Omit to base the draft on the tenant's currently active pack instead — which may belong to " +
      'a different packId (forking the code default into a new lineage) or to this same one.',
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  parentVersion?: number;
}
