import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsMongoId, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import {
  DOCUMENT_SOURCE_CLASSES,
  type DocumentSourceClass,
} from '../../../../../database/schemas/evidence/document/document.schema';

/**
 * The classes an uploader may declare for a browser upload. `'unclassified'` is excluded: it
 * means no authority information was recorded, not a rank a caller can assert — a document this
 * DTO never touches is already `'unclassified'` by the schema's own default, so accepting the
 * word here would just be a second way to say nothing.
 */
const UPLOAD_SOURCE_CLASSES: readonly DocumentSourceClass[] = DOCUMENT_SOURCE_CLASSES.filter(
  (sourceClass) => sourceClass !== 'unclassified',
);

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
    description: 'Document title or filename. Ignored when documentId is set.',
    required: false,
  })
  @IsOptional()
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

  @ApiProperty({
    example: 'memo',
    enum: UPLOAD_SOURCE_CLASSES,
    description:
      'Authority classification for a newly created document — the survivorship policy weighs ' +
      "this against every other document's class the next time this metric conflicts. Omit to " +
      "leave the document 'unclassified' (no authority information, not the lowest rank). " +
      "Rejects 'unclassified' as an explicit value for the same reason: it is not a rank a " +
      'caller can assert. Ignored when documentId is set — a new version never changes its ' +
      "document's class.",
    required: false,
  })
  @IsOptional()
  @IsIn(UPLOAD_SOURCE_CLASSES)
  sourceClass?: DocumentSourceClass;
}
