import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  DOCUMENT_VERSION_INGESTION_STATUSES,
  type DocumentVersionIngestionStatus,
} from '../../../../../database/schemas/evidence/document-version/document-version.schema';

export class DocumentVersionResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b9', description: 'Version identifier.' })
  id: string;

  @Expose()
  @ApiProperty({ example: 1, description: 'Sequential version number, starting at 1.' })
  versionNumber: number;

  @Expose()
  @ApiProperty({
    example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85',
    description: 'sha256 of the version bytes — what a citation pins.',
  })
  sha256: string;

  @Expose()
  @ApiProperty({ example: 245760, description: 'Size of the version bytes, in bytes.' })
  sizeBytes: number;

  @Expose()
  @ApiProperty({
    example: 'pending',
    enum: DOCUMENT_VERSION_INGESTION_STATUSES,
    description: 'Progress marker for the ingestion workflow started on upload.',
  })
  ingestionStatus: DocumentVersionIngestionStatus;

  @Expose()
  @ApiProperty({
    example:
      'Document has 3 page(s) but no extractable text on any of them (likely a scanned image ' +
      'with no embedded text layer); OCR is out of scope for this parser',
    description:
      'Present when ingestionStatus is "failed" or "needs-ocr" — the parser exception message ' +
      'from the attempt that set that status.',
    required: false,
  })
  ingestionFailureReason?: string;

  @Expose()
  @ApiProperty({ example: '2026-07-01T00:00:00.000Z', description: 'Version creation timestamp.' })
  createdAt: Date;
}
