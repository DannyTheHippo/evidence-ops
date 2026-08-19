import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class TenantMetricResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Tenant metric identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: 'cap_rate',
    description:
      "The measure this row labels — one of METRIC_IDS's members when this row renames a " +
      'code-ontology metric, or a tenant-chosen id when it adds a new one.',
  })
  metricId: string;

  @Expose()
  @ApiProperty({ example: 'Capitalization Rate', description: 'Display label for this measure.' })
  label: string;

  @Expose()
  @ApiProperty({
    example: false,
    description:
      "True when metricId is not one of METRIC_IDS's members — a tenant-added measure " +
      'rather than a rename of a code-ontology one.',
  })
  isCustom: boolean;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this row was first authored.',
  })
  createdAt: Date;
}
