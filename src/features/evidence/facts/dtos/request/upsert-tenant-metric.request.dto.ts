import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Deliberately the only field this DTO declares. `tolerance` and `unit` decide what counts as a
 * disagreement between two facts, and the global `ValidationPipe` runs with
 * `forbidNonWhitelisted: true` — a request naming either becomes a 400 before it reaches
 * `TenantMetricsService`, not a value this DTO could ever carry through.
 */
export class UpsertTenantMetricRequestDto {
  @ApiProperty({
    example: 'Capitalization Rate',
    description:
      'Display label for this measure. Renames an existing code-ontology metric when the path ' +
      "id matches one of METRIC_IDS's members, or adds a wholly new catalog entry otherwise.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label: string;
}
