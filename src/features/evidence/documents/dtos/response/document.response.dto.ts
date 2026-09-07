import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import type {
  DocumentSourceClass,
  DocumentSourceKind,
} from '../../../../../database/schemas/evidence/document/document.schema';
import {
  DOCUMENT_SOURCE_CLASSES,
  DOCUMENT_SOURCE_KINDS,
} from '../../../../../database/schemas/evidence/document/document.schema';
import { DocumentLocationResponseDto } from './document-location.response.dto';
import { DocumentVersionResponseDto } from './document-version.response.dto';

export class DocumentResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Document identifier.' })
  id: string;

  @Expose()
  @ApiProperty({ example: 'Q3 Rent Roll', description: 'Document title.' })
  title: string;

  @Expose()
  @ApiProperty({
    example: 'xlsx',
    enum: DOCUMENT_SOURCE_KINDS,
    description: 'Extractor pipeline kind.',
  })
  sourceKind: DocumentSourceKind;

  @Expose()
  @ApiProperty({
    example: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    description: 'Raw content type as uploaded.',
  })
  mimeType: string;

  @Expose()
  @ApiProperty({
    example: 'unclassified',
    enum: DOCUMENT_SOURCE_CLASSES,
    description:
      "Authority classification for this document. 'unclassified' means nobody has declared one " +
      '— the survivorship policy treats that as no authority information, not the lowest rank.',
  })
  sourceClass: DocumentSourceClass;

  @Expose()
  @Type(() => DocumentVersionResponseDto)
  @ApiProperty({ type: () => DocumentVersionResponseDto })
  currentVersion: DocumentVersionResponseDto;

  @Expose()
  @Type(() => DocumentLocationResponseDto)
  @ApiProperty({
    type: () => [DocumentLocationResponseDto],
    description: "Every place this document's current-version bytes have been seen, tenant-wide.",
  })
  locations: DocumentLocationResponseDto[];

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Document creation timestamp.' })
  createdAt: Date;
}
