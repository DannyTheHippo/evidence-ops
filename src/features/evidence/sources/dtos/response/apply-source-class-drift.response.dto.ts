import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';

export class ApplySourceClassDriftResponseDto {
  @Expose()
  @ApiProperty({
    example: 12,
    description:
      'How many documents this apply actually rewrote — recomputed at apply time, so ' +
      'it can differ from a count read earlier.',
  })
  modifiedCount: number;

  @Expose()
  @ApiProperty({
    example: 'memo',
    enum: DOCUMENT_SOURCE_CLASSES,
    description:
      'The class this apply reconciled from. Absent when there was nothing to reconcile.',
    required: false,
  })
  previousClass?: DocumentSourceClass;

  @Expose()
  @ApiProperty({
    example: 'crm-export',
    enum: DOCUMENT_SOURCE_CLASSES,
    description: "The class this apply reconciled to — the source's current sourceClass.",
  })
  sourceClass: DocumentSourceClass;
}
