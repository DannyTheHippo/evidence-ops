import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { SourceFileStateResponseDto } from './source-file-state.response.dto';
import { SourceResponseDto } from './source.response.dto';

export class SourceWithFileStatesResponseDto extends SourceResponseDto {
  @Expose()
  @Type(() => SourceFileStateResponseDto)
  @ApiProperty({
    type: () => [SourceFileStateResponseDto],
    description: 'Per-file sync state, one entry per file this source has ever seen.',
  })
  fileStates: SourceFileStateResponseDto[];
}
