import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { DocumentResponseDto } from './document.response.dto';
import { DocumentVersionResponseDto } from './document-version.response.dto';

export class DocumentWithVersionsResponseDto extends DocumentResponseDto {
  @Expose()
  @Type(() => DocumentVersionResponseDto)
  @ApiProperty({
    type: () => [DocumentVersionResponseDto],
    description: 'Full version history, oldest first.',
  })
  versions: DocumentVersionResponseDto[];
}
