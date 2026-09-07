import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class MetricResponseDto {
  @Expose()
  @ApiProperty({
    example: 'cap_rate',
    description:
      'Measure slug (`Measure.slug`) — the value `ExtractedFact.factKey.metric` carries.',
  })
  id: string;

  @Expose()
  @ApiProperty({ example: 'Cap Rate', description: 'Human-readable label for id.' })
  label: string;

  @Expose()
  @ApiProperty({
    example: 'ratio',
    description: 'The unit every normalized value for this metric is expressed in.',
  })
  canonicalUnit: string;
}
