import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateSourceEnabledRequestDto {
  @ApiProperty({
    example: false,
    description: 'Whether the sync loop is allowed to run for this source.',
  })
  @IsBoolean()
  enabled: boolean;
}
