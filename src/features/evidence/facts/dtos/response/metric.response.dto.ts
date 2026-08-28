import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class MetricResponseDto {
  @Expose()
  @ApiProperty({
    example: 'cap_rate',
    description: "Metric identifier, one of METRIC_ONTOLOGY's METRIC_IDS.",
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
