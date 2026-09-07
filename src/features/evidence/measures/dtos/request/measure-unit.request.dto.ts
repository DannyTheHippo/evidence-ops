import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive, IsString, Matches } from 'class-validator';

// Matches the same grammar `validateMeasureDefinition` (`../../measure-definition.ts`) enforces
// server-side — duplicated here rather than imported so a malformed unit id is rejected by the
// request pipeline before it ever reaches the service.
const UNIT_ID_GRAMMAR = /^[a-z][a-z0-9_]{0,63}$/;

export class MeasureUnitRequestDto {
  @ApiProperty({
    example: 'sf',
    description: 'Unit identifier, matched case-sensitively against a fact’s reported unit.',
  })
  @IsString()
  @Matches(UNIT_ID_GRAMMAR)
  id: string;

  @ApiProperty({
    example: 1,
    description: 'Multiplicative factor converting one of this unit into the canonicalUnit.',
  })
  @IsNumber()
  @IsPositive()
  toCanonicalFactor: number;
}
