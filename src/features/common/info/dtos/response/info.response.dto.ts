import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString } from 'class-validator';

export class InfoResponseDto {
  @Expose()
  @ApiProperty({
    example: '1.0.0',
    description: 'Application package version.',
  })
  @IsString()
  version: string;
}
