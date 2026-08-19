import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsIn, IsInt, IsOptional, Min } from 'class-validator';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';

/**
 * The classes an operator may rank in `authorityOrder`. `'unclassified'` means no authority
 * information was ever recorded for a document, not the lowest rank — `resolveConflictPolicy`
 * already refuses to rank it (`resolve-conflict-policy.ts`), so a row naming it would pass write
 * time and then fail closed silently, with no proposal, the first time it mattered. Excluding it
 * here rejects that row at the moment an operator can still see why.
 */
const RANKABLE_SOURCE_CLASSES: readonly DocumentSourceClass[] = DOCUMENT_SOURCE_CLASSES.filter(
  (sourceClass) => sourceClass !== 'unclassified',
);

/**
 * Both fields optional and independently settable — either replaces this metric's whole row
 * (`MetricPoliciesService.upsert`), never merges field-by-field with whatever a previous `PUT`
 * stored, so a field omitted from this request does not survive from an earlier one.
 */
export class UpsertMetricPolicyRequestDto {
  @ApiProperty({
    example: ['pm-export', 'spreadsheet'],
    enum: RANKABLE_SOURCE_CLASSES,
    isArray: true,
    description:
      "Most-authoritative-first ranking of source classes for this metric. Rejects 'unclassified' " +
      '(it means no authority information was recorded, not the lowest rank) and a class repeated ' +
      'at two ranks — both would otherwise pass here and then make resolveConflictPolicy silently ' +
      'refuse to propose a winner. Omit to leave this metric with no authority ranking.',
    required: false,
  })
  @IsOptional()
  @ArrayUnique()
  @IsIn(RANKABLE_SOURCE_CLASSES, { each: true })
  authorityOrder?: DocumentSourceClass[];

  @ApiProperty({
    example: 180 * 24 * 60 * 60 * 1000,
    description:
      'How long an observed value stays current for this metric, in milliseconds. Must be at ' +
      'least 1 — a zero window makes any nonzero gap decisive, which is clock precision rather ' +
      'than a claim about freshness. Omit to leave this metric with no staleness check.',
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  stalenessWindowMs?: number;
}
