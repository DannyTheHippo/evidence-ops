import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';

export class UploadDocumentRequestDto {
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description:
      'Existing document to add a new version to. Omit to create a new document from this upload.',
    required: false,
  })
  @IsOptional()
  @IsMongoId()
  documentId?: string;

  @ApiProperty({
    example: 'Q3 Rent Roll',
    description: 'Document title. Required when documentId is omitted (new document).',
    required: false,
  })
  // Only required on the new-document path; a version upload keeps the document's existing title.
  @ValidateIf((dto: UploadDocumentRequestDto) => !dto.documentId)
  @IsString()
  @IsNotEmpty()
  title?: string;
}
