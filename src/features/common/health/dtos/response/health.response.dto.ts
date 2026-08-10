import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsIn } from 'class-validator';

export class HealthResponseDto {
  @Expose()
  @ApiProperty({
    example: 'ok',
    description: 'Overall health status.',
    enum: ['ok', 'degraded'],
  })
  @IsIn(['ok', 'degraded'])
  status: 'ok' | 'degraded';

  @Expose()
  @ApiProperty({
    example: 'up',
    description: 'Mongo connectivity, checked via an admin ping (~2s timeout).',
    enum: ['up', 'down'],
  })
  @IsIn(['up', 'down'])
  mongo: 'up' | 'down';
}
