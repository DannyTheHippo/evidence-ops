import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Both fields optional and independently settable — an omitted field leaves that half of the
 *  row untouched, unlike `UpsertMetricPolicyRequestDto`'s whole-row replace. A canonical entity
 *  has no ontology default to fall back to, so there is nothing for an omitted field to revert
 *  to; leaving it as-is is the only sensible partial-update semantics here. */
export class UpdateCanonicalEntityRequestDto {
  @ApiProperty({
    example: 'Northgate Business Park',
    description: 'New canonical display name for this row.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  canonicalName?: string;

  @ApiProperty({
    example: ['Northgate Bus. Park'],
    description: 'Replaces the full alias list. Omit to leave the current aliases untouched.',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];
}
