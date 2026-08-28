import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import type { EvidenceLocator } from '../../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { HarvestedAliasStatus } from '../../../../../database/schemas/evidence/canonical-entity/canonical-entity.schema';

/** An alias read out of a document's own parenthetical definition, with the citation that makes it
 *  checkable. Only a `applied` entry resolves; `proposed` is recorded and inert, `revoked` is an
 *  operator's rejection and never returns to `applied`. */
export class HarvestedAliasResponseDto {
  @Expose()
  @ApiProperty({ example: 'Property', description: 'Alias as the document wrote it.' })
  alias: string;

  @Expose()
  @ApiProperty({
    example: 'proposed',
    enum: ['proposed', 'applied', 'revoked'],
    description:
      'Whether this alias resolves (applied), is recorded only (proposed), or has been rejected (revoked).',
  })
  status: HarvestedAliasStatus;

  @Expose()
  @ApiProperty({
    example: 'Northgate Business Park (the "Property")',
    description: 'Verbatim span of the document that defines this alias.',
  })
  quote: string;

  @Expose()
  @ApiProperty({
    example: { kind: 'pdf-page', page: 4, extractorVersion: 'pdf-1' },
    description: 'Where the quote sits in the document version it was read from.',
  })
  locator: EvidenceLocator;

  @Expose()
  @ApiProperty({
    example: '65f1c2e4a1b2c3d4e5f6a7b8',
    description: 'Document version the definition was read from.',
  })
  documentVersionId: string;

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When the definition was harvested.',
  })
  harvestedAt: Date;
}

export class CanonicalEntityResponseDto {
  @Expose()
  @ApiProperty({ example: '65f1c2e4a1b2c3d4e5f6a7b8', description: 'Canonical entity identifier.' })
  id: string;

  @Expose()
  @ApiProperty({
    example: 'Northgate Business Park',
    description: 'Canonical display name this row registers alternate spellings against.',
  })
  canonicalName: string;

  @Expose()
  @ApiProperty({
    example: ['Northgate Bus. Park'],
    description: 'Alternate spellings that resolve to canonicalName.',
  })
  aliases: string[];

  @Expose()
  @Type(() => HarvestedAliasResponseDto)
  @ApiProperty({
    type: [HarvestedAliasResponseDto],
    description: 'Aliases read out of documents, each with the quote and locator defining it.',
  })
  harvestedAliases: HarvestedAliasResponseDto[];

  @Expose()
  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description: 'When this row was first authored.',
  })
  createdAt: Date;
}
