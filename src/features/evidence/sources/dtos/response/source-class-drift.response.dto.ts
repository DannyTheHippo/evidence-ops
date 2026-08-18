import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';

export class SourceClassDriftResponseDto {
  @Expose()
  @ApiProperty({
    example: 'memo',
    enum: DOCUMENT_SOURCE_CLASSES,
    description:
      'The class documents were ingested under before sourceClass last changed. Absent means ' +
      'sourceClass has never changed for this source.',
    required: false,
  })
  previousClass?: DocumentSourceClass;

  @Expose()
  @ApiProperty({
    example: 12,
    description:
      "How many documents still carry previousClass rather than the source's current sourceClass.",
  })
  count: number;
}
