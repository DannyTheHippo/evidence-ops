import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

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

  @ApiProperty({
    example: false,
    description:
      "Route this upload's ingestion through a human-approval gate (D5 of the approvals " +
      'milestone) before chunking/embedding proceeds. Default false — an uploader who does not ' +
      'opt in is never blocked.',
    required: false,
    default: false,
  })
  @IsOptional()
  // This body arrives as `multipart/form-data`, so every field is a string on the wire — a bare
  // `@IsBoolean()` would 400 on the literal string `'true'`. Explicit string comparison, not
  // `Boolean(value)`/a bare `@Type(() => Boolean)`: those coerce the *non-empty string* `'false'`
  // to `true`, which would silently gate an uploader who explicitly opted out — the one outcome
  // this field's whole "default is do not gate" contract forbids.
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  requireApproval?: boolean;
}
