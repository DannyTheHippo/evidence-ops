import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  DOCUMENT_SOURCE_KINDS,
  type DocumentSourceKind,
} from '../../../../../database/schemas/evidence/document/document.schema';

/** One resolved `(documentVersionId → document)` row for `GET /documents/versions/lookup`.
 *  `sourceKind` lets a caller pick a PDF pane vs. the chunk reader without a second fetch;
 *  `versionNumber` feeds a breadcrumb; `withdrawn` is set on a soft-withdrawn version so a
 *  historic citation still resolves and can be labelled rather than silently breaking. */
export class DocumentVersionLookupResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b9', description: 'Document version identifier.' })
  versionId: string;

  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Owning document identifier.' })
  documentId: string;

  @Expose()
  @ApiProperty({ example: 'Q3 Rent Roll', description: 'Owning document title.' })
  documentTitle: string;

  @Expose()
  @ApiProperty({ example: 1, description: 'Sequential version number, starting at 1.' })
  versionNumber: number;

  @Expose()
  @ApiProperty({
    example: 'xlsx',
    enum: DOCUMENT_SOURCE_KINDS,
    description: 'Extractor pipeline kind, for choosing a PDF pane vs. the chunk reader.',
  })
  sourceKind: DocumentSourceKind;

  @Expose()
  @ApiProperty({
    example: false,
    description: 'True when this version is soft-withdrawn — it still resolves, but is stale.',
  })
  withdrawn: boolean;
}
