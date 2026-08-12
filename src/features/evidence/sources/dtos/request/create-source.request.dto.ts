import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import {
  SOURCE_KINDS,
  type SourceKind,
} from '../../../../../database/schemas/evidence/source/source.schema';

export class CreateSourceRequestDto {
  @ApiProperty({ example: 'Deal Room Inbox', description: 'Human-readable name for this source.' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'local-folder',
    enum: SOURCE_KINDS,
    description: 'Which connector syncs this source.',
  })
  @IsIn(SOURCE_KINDS)
  kind: SourceKind;

  @ApiProperty({
    example: 'deal-room',
    description: "The connector's location for this source — a folder path for 'local-folder'.",
  })
  @IsString()
  @IsNotEmpty()
  path: string;

  @ApiProperty({
    example: 60000,
    description:
      'Per-source override of the global sync interval, in milliseconds. Omit to use the ' +
      'configured default.',
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMs?: number;

  @ApiProperty({
    example: true,
    description: 'Whether the sync loop is allowed to run for this source. Defaults to true.',
    required: false,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
