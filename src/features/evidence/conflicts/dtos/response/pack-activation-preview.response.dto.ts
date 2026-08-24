import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class PackActivationPreviewMetricResponseDto {
  @Expose()
  @ApiProperty({ example: 'cap_rate', description: 'The metric this row reports on.' })
  metricId: string;

  @Expose()
  @ApiProperty({
    example: 2,
    description:
      'How many new Conflict rows the previewed version would create for this metric, computed ' +
      'without writing one.',
  })
  wouldCreate: number;

  @Expose()
  @ApiProperty({
    example: 3,
    description:
      "How many of this metric's currently open Conflict rows the previewed version would " +
      'retract, computed without writing one. Excludes a conflict already carrying a pending ' +
      "resolution approval, the same guard a real activation's rescan respects.",
  })
  wouldRetract: number;
}

export class PackActivationPreviewResponseDto {
  @Expose()
  @Type(() => PackActivationPreviewMetricResponseDto)
  @ApiProperty({
    type: () => [PackActivationPreviewMetricResponseDto],
    description:
      'Only the metrics whose detection-relevant configuration actually changed relative to the ' +
      "tenant's currently active pack. Empty when the previewed version only relabels a metric or " +
      'adds an alias — activating it would start no rescan at all.',
  })
  metrics: PackActivationPreviewMetricResponseDto[];
}
