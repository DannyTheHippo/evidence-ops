import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsOptional, IsString } from 'class-validator';

/**
 * Every metric id present in the parent version but absent from this draft must be named here —
 * a silent removal orphans every `ExtractedFact`/`Conflict` already stamped against that metric
 * and turns the hindsight backtest `unscorable` for them, so `MetricPacksService.publish` refuses
 * a removal this list does not name, and refuses a name here that is not actually a removal.
 */
export class PublishMetricPackVersionRequestDto {
  @ApiProperty({
    example: ['lease_term_years'],
    isArray: true,
    description:
      'Metric ids the operator confirms are deliberately dropped from the parent version. Omit ' +
      'when this draft removes none.',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  acknowledgeRemovedMetricIds?: string[];
}
